/**
 * Streaming playback through Media Source Extensions: bytes are appended to
 * the <audio> element as they arrive, so speech starts at the provider's
 * first byte instead of after the whole chunk is synthesized (measured on
 * Azure HD Omni: ~1.5 s vs 8–11 s for a 170-character chunk). All chunks go
 * into one SourceBuffer back to back, so chunk boundaries are gapless.
 *
 * Chrome/Edge/Firefox expose MediaSource with audio/mpeg; Safari 17+ exposes
 * ManagedMediaSource instead. Anything else falls back to whole-blob playback
 * in the player.
 */

type MediaSourceCtor = { new (): MediaSource; isTypeSupported(type: string): boolean };

export interface StreamingSource {
  ctor: MediaSourceCtor;
  /** ManagedMediaSource (Safari) — needs disableRemotePlayback on the element. */
  managed: boolean;
}

/** A MediaSource implementation that can stream `mime`, or null. */
export function streamingSourceFor(mime: string): StreamingSource | null {
  if (typeof window === "undefined" || !mime) return null;
  const w = window as unknown as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  if (w.MediaSource?.isTypeSupported?.(mime)) return { ctor: w.MediaSource, managed: false };
  if (w.ManagedMediaSource?.isTypeSupported?.(mime)) return { ctor: w.ManagedMediaSource, managed: true };
  return null;
}

export interface StreamPlaybackOptions {
  audio: HTMLAudioElement;
  source: StreamingSource;
  mime: string;
  rate: number;
  total: number;
  /**
   * Body of chunk `i`. Called only once chunk `i - 1` is fully received —
   * synthesis outruns playback several times over, so one request at a time
   * keeps the buffer ahead without two provider streams competing.
   */
  openChunk: (i: number) => Promise<ReadableStream<Uint8Array>>;
  /** All bytes of chunk `i`, once fully received (the player's replay cache). */
  onChunkComplete?: (i: number, parts: Uint8Array[]) => void;
  /** Buffering vs. audibly playing, and which chunk the playhead is in. */
  onProgress: (status: "loading" | "playing", chunk: number) => void;
  signal: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function once(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      target.removeEventListener(type, onEvent);
      reject(abortError());
    };
    const onEvent = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    target.addEventListener(type, onEvent, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settled(sb: SourceBuffer, signal: AbortSignal): Promise<void> {
  while (sb.updating) await once(sb, "updateend", signal);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/**
 * Append, and if the buffer is full (very long replies), drop what has
 * already been played and wait for the playhead to make room.
 */
async function append(sb: SourceBuffer, data: Uint8Array, audio: HTMLAudioElement, signal: AbortSignal) {
  for (;;) {
    await settled(sb, signal);
    try {
      sb.appendBuffer(data as BufferSource);
      await settled(sb, signal);
      return;
    } catch (err) {
      if ((err as Error)?.name !== "QuotaExceededError") throw err;
      const playedUpTo = audio.currentTime - 5;
      if (playedUpTo > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < playedUpTo) {
        sb.remove(sb.buffered.start(0), playedUpTo);
        await settled(sb, signal);
      }
      await sleep(500, signal);
    }
  }
}

export async function playStreaming(o: StreamPlaybackOptions): Promise<void> {
  const { audio, signal } = o;
  const mediaSource = new o.source.ctor();
  const url = URL.createObjectURL(mediaSource);
  const cleanups: Array<() => void> = [];
  const on = (target: EventTarget, type: string, fn: () => void) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  try {
    if (o.source.managed) audio.disableRemotePlayback = true;
    const opened = once(mediaSource, "sourceopen", signal);
    // Loading a new src resets playbackRate to defaultPlaybackRate, so set
    // both. preservesPitch (the default) keeps the voice from going chipmunk.
    audio.defaultPlaybackRate = o.rate;
    audio.src = url;
    audio.playbackRate = o.rate;
    audio.preservesPitch = true;
    await opened;

    const sb = mediaSource.addSourceBuffer(o.mime);
    // MPEG audio carries no timestamps: sequence mode lays chunks end to end.
    if (sb.mode !== "sequence") sb.mode = "sequence";

    // Where each chunk ends on the media timeline, to report progress.
    const boundaries: number[] = [];
    const chunkAtPlayhead = () => {
      const index = boundaries.findIndex((end) => audio.currentTime < end);
      return index === -1 ? boundaries.length : index;
    };
    let audible = false;
    on(audio, "waiting", () => {
      audible = false;
      o.onProgress("loading", chunkAtPlayhead());
    });
    on(audio, "playing", () => {
      audible = true;
      o.onProgress("playing", chunkAtPlayhead());
    });
    on(audio, "timeupdate", () => {
      if (audible) o.onProgress("playing", chunkAtPlayhead());
    });

    // A playback failure (audio error, rejected play(), stop) must end the
    // run at once — not whenever the in-flight response next yields bytes,
    // which for a stalled or long stream could be much later. Every wait
    // below races against `failed`.
    let fatal: unknown = null;
    let fail!: (err: unknown) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    failed.catch(() => {});
    const setFatal = (err: unknown) => {
      if (fatal) return;
      fatal = err;
      fail(err);
    };
    const guard = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, failed]);

    const finished = new Promise<void>((resolve, reject) => {
      on(audio, "ended", () => resolve());
      on(audio, "error", () => reject(new Error("Audio playback failed")));
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    finished.catch(setFatal);

    // Start now: the element sits in "waiting" until the first bytes land.
    // Not awaited — play() only settles once audio is actually flowing.
    Promise.resolve(audio.play()).catch(setFatal);

    for (let i = 0; i < o.total; i++) {
      const reader = (await guard(o.openChunk(i))).getReader();
      const parts: Uint8Array[] = [];
      let complete = false;
      try {
        for (;;) {
          const { done, value } = await guard(reader.read());
          if (fatal) throw fatal;
          if (done) break;
          if (!value?.byteLength) continue;
          parts.push(value);
          await guard(append(sb, value, audio, signal));
        }
        complete = true;
      } finally {
        // Leaving early (error, stop): stop the download too.
        if (complete) reader.releaseLock();
        else reader.cancel().catch(() => {});
      }
      boundaries.push(sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0);
      o.onChunkComplete?.(i, parts);
    }

    await guard(settled(sb, signal));
    if (mediaSource.readyState === "open") mediaSource.endOfStream();
    await finished;
  } finally {
    for (const cleanup of cleanups) cleanup();
    URL.revokeObjectURL(url);
  }
}
