import { useSyncExternalStore } from "react";
import { api, TtsRequestError, type TtsSettings } from "@/lib/api";
import { chunkForSpeech } from "./chunk-text";
import { hasSpeakableContent, toSpeakableText } from "./speakable-text";

/**
 * Page-wide read-aloud player: one message at a time, chunked synthesis with
 * one-ahead prefetch, a single <audio> element. Components subscribe through
 * `useTtsState()`; the state lives here so a message that unmounts (scroll
 * virtualization) and remounts picks its playback state back up.
 * Design: docs/agent-message-tts-design.md §4.2.
 */

export type TtsErrorCode = "not_configured" | "failed";

export type TtsState =
  | { status: "idle" }
  | { status: "loading" | "playing"; ownerKey: string; chunk: number; total: number }
  | { status: "error"; ownerKey: string; code: TtsErrorCode; message: string };

export interface TtsPlayOptions {
  /** Override the saved voice / rate (settings preview of unsaved values). */
  voice?: string;
  rate?: number;
}

const IDLE: TtsState = { status: "idle" };
const ERROR_VISIBLE_MS = 3000;
const BUSY_RETRY_MS = 300;
const FALLBACK_MAX_CHARS = 1500;

let silentWavUrl: string | null = null;

/** 0.05 s of 8 kHz 8-bit silence — played inside the click to unlock the element. */
function silentWav(): string {
  if (silentWavUrl) return silentWavUrl;
  const samples = 400;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  silentWavUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return silentWavUrl;
}

function isAbort(err: unknown): boolean {
  return (err as Error)?.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

interface Run {
  controller: AbortController;
}

export class TtsPlayer {
  private state: TtsState = IDLE;
  private listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private run: Run | null = null;
  private settings: Promise<TtsSettings> | null = null;
  /** The last played text's audio, so replaying the same reply skips synthesis. */
  private cache: { key: string; blobs: Blob[] } | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TtsState => this.state;

  /** Settings changed (voice, rate, key) — refetch next time and drop cached audio. */
  invalidateSettings(): void {
    this.settings = null;
    this.cache = null;
  }

  /**
   * Must be called from the click handler: the element is unlocked
   * synchronously, before any await, or Safari refuses later play() calls.
   */
  play(ownerKey: string, markdown: string, opts: TtsPlayOptions = {}): void {
    this.stop();
    if (!hasSpeakableContent(markdown)) return;
    const text = toSpeakableText(markdown);

    const audio = this.unlockAudio();
    const run: Run = { controller: new AbortController() };
    this.run = run;
    this.set({ status: "loading", ownerKey, chunk: 0, total: 0 });

    this.execute(run, audio, ownerKey, text, opts).then(
      () => {
        if (this.run !== run) return;
        this.run = null;
        this.set(IDLE);
      },
      (err: unknown) => {
        if (this.run !== run) return; // stopped or superseded
        this.run = null;
        this.resetAudio();
        this.fail(ownerKey, err);
      },
    );
  }

  /** Play if idle for this owner, stop if it is the one playing. */
  toggle(ownerKey: string, markdown: string, opts?: TtsPlayOptions): void {
    if (this.isActive(ownerKey)) this.stop();
    else this.play(ownerKey, markdown, opts);
  }

  isActive(ownerKey: string): boolean {
    const s = this.state;
    return (s.status === "loading" || s.status === "playing") && s.ownerKey === ownerKey;
  }

  stop(): void {
    if (this.run) {
      this.run.controller.abort();
      this.run = null;
    }
    this.resetAudio();
    if (this.state.status !== "idle") this.set(IDLE);
  }

  /** Stop if the current owner key starts with `prefix` (e.g. "<sessionId>:" on session switch). */
  stopOwnersWithPrefix(prefix: string): void {
    const s = this.state;
    if (s.status !== "idle" && s.ownerKey.startsWith(prefix)) this.stop();
  }

  private async execute(run: Run, audio: HTMLAudioElement, ownerKey: string, text: string, opts: TtsPlayOptions) {
    const { signal } = run.controller;
    const settings = await this.loadSettings();
    if (!settings.configured) {
      throw new TtsRequestError("Text-to-speech is not configured", 409, "tts_not_configured");
    }
    const maxChars =
      settings.providers.find((p) => p.id === settings.provider)?.maxCharsPerRequest ?? FALLBACK_MAX_CHARS;
    const chunks = chunkForSpeech(text, maxChars);

    const key = JSON.stringify([text, opts.voice ?? null, opts.rate ?? null]);
    if (this.cache?.key !== key) this.cache = { key, blobs: [] };
    const blobs = this.cache.blobs;

    const fetchChunk = (i: number): Promise<Blob> => {
      const hit = blobs[i];
      if (hit) return Promise.resolve(hit);
      return this.synthesize(chunks[i], opts, signal).then((blob) => {
        blobs[i] = blob;
        return blob;
      });
    };

    // Tracks whether the prefetched chunk has already arrived, so a chunk
    // boundary only shows the spinner when there is actually a wait.
    const prefetch = (i: number) => {
      const entry = { promise: fetchChunk(i), ready: false };
      entry.promise.then(
        () => (entry.ready = true),
        () => {}, // surfaced when awaited; avoid an unhandled rejection if we stop first
      );
      return entry;
    };

    let next = prefetch(0);
    for (let i = 0; i < chunks.length; i++) {
      if (!next.ready) this.set({ status: "loading", ownerKey, chunk: i, total: chunks.length });
      const blob = await next.promise;
      if (signal.aborted) return;
      if (i + 1 < chunks.length) next = prefetch(i + 1);
      this.set({ status: "playing", ownerKey, chunk: i, total: chunks.length });
      await this.playBlob(audio, blob, signal);
    }
  }

  private async synthesize(text: string, opts: TtsPlayOptions, signal: AbortSignal): Promise<Blob> {
    try {
      return await api.synthesizeSpeech(text, { ...opts, signal });
    } catch (err) {
      // The server caps in-flight requests per user; a just-stopped request can
      // still hold a slot for a moment after we switch messages.
      if (err instanceof TtsRequestError && err.code === "tts_busy") {
        await sleep(BUSY_RETRY_MS, signal);
        return api.synthesizeSpeech(text, { ...opts, signal });
      }
      throw err;
    }
  }

  private playBlob(audio: HTMLAudioElement, blob: Blob, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        URL.revokeObjectURL(url);
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Audio playback failed"));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) return onAbort();
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      signal.addEventListener("abort", onAbort);
      audio.src = url;
      Promise.resolve(audio.play()).catch((err: unknown) => {
        cleanup();
        reject(err);
      });
    });
  }

  private loadSettings(): Promise<TtsSettings> {
    if (!this.settings) {
      const pending = api.getTtsSettings();
      this.settings = pending;
      pending.catch(() => {
        if (this.settings === pending) this.settings = null; // retry next time
      });
    }
    return this.settings;
  }

  private unlockAudio(): HTMLAudioElement {
    if (!this.audio) this.audio = new Audio();
    const audio = this.audio;
    audio.src = silentWav();
    // Interrupted by the real src moments later — that rejection is expected.
    Promise.resolve(audio.play()).catch(() => {});
    return audio;
  }

  private resetAudio(): void {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute("src");
  }

  private fail(ownerKey: string, err: unknown): void {
    if (isAbort(err)) {
      this.set(IDLE);
      return;
    }
    const notConfigured = err instanceof TtsRequestError && err.code === "tts_not_configured";
    const message =
      (err as Error)?.name === "NotAllowedError"
        ? "The browser blocked audio playback"
        : err instanceof Error
          ? err.message
          : "Speech playback failed";
    if (!notConfigured) console.warn("[tts] playback failed:", err);
    const errorState: TtsState = { status: "error", ownerKey, code: notConfigured ? "not_configured" : "failed", message };
    this.set(errorState);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      if (this.state === errorState) this.set(IDLE);
    }, ERROR_VISIBLE_MS);
  }

  private set(next: TtsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const ttsPlayer = new TtsPlayer();

export function useTtsState(): TtsState {
  return useSyncExternalStore(ttsPlayer.subscribe, ttsPlayer.getSnapshot, ttsPlayer.getSnapshot);
}
