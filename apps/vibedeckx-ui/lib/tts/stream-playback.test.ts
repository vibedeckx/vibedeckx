// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTtsSettings: vi.fn(),
  openSpeechStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { getTtsSettings: mocks.getTtsSettings, openSpeechStream: mocks.openSpeechStream } };
});

import { TtsPlayer } from "./tts-player";

// ---- Minimal Media Source Extensions fakes ----

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  appended: number[] = [];
  private bytes = 0;
  buffered = {
    length: 0,
    start: () => 0,
    end: () => this.bytes / 1000, // 1 KB ≈ 1 s of "audio"
  };
  appendBuffer(data: Uint8Array) {
    if (this.updating) throw new DOMException("busy", "InvalidStateError");
    this.updating = true;
    setTimeout(() => {
      this.bytes += data.byteLength;
      this.buffered.length = 1;
      this.appended.push(data.byteLength);
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 0);
  }
  remove() {}
}

class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = (type: string) => type === "audio/mpeg";
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffer: FakeSourceBuffer | null = null;
  mime = "";
  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }
  addSourceBuffer(mime: string) {
    this.mime = mime;
    this.sourceBuffer = new FakeSourceBuffer();
    return this.sourceBuffer;
  }
  endOfStream() {
    this.readyState = "ended";
  }
}

const mediaSourceUrls = new Map<string, FakeMediaSource>();

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  private _src = "";
  playCalls: string[] = [];
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  disableRemotePlayback = false;
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  get src() {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
    const ms = mediaSourceUrls.get(value);
    if (ms) {
      setTimeout(() => {
        ms.readyState = "open";
        ms.dispatchEvent(new Event("sourceopen"));
      }, 0);
    }
  }
  /** Make play() reject for MediaSource URLs (e.g. autoplay blocked). */
  rejectStreamPlay: Error | null = null;
  play() {
    this.playCalls.push(this._src);
    if (this.rejectStreamPlay && mediaSourceUrls.has(this._src)) return Promise.reject(this.rejectStreamPlay);
    return Promise.resolve();
  }
  pause() {}
  removeAttribute(name: string) {
    if (name === "src") this._src = "";
  }
}

// ---- helpers ----

function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: (type = "audio/mpeg") => new Response(stream, { headers: { "Content-Type": type } }),
    push: (bytes: number) => controller.enqueue(new Uint8Array(bytes)),
    close: () => controller.close(),
    get cancelled() {
      return cancelled;
    },
  };
}

const SETTINGS = {
  provider: "azure",
  voice: "v",
  rate: 1.25,
  configured: true,
  credentials: {},
  rateRange: { min: 0.5, max: 2 },
  providers: [{ id: "azure", label: "Azure", defaultVoice: "v", maxCharsPerRequest: 1500, configured: true, credentialFields: [] }],
};

// Two chunks: the first is capped at 200 characters.
const LONG = `${"a".repeat(150)}. ${"b".repeat(150)}.`;

const audio = () => FakeAudio.instances[0];
const mediaSource = () => FakeMediaSource.instances[0];

describe("TtsPlayer streaming playback", () => {
  let player: TtsPlayer;
  let urlCount = 0;
  let bodies: ReturnType<typeof controlledBody>[];
  let signals: AbortSignal[];

  beforeEach(() => {
    FakeAudio.instances = [];
    FakeMediaSource.instances = [];
    mediaSourceUrls.clear();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("MediaSource", FakeMediaSource);
    URL.createObjectURL = vi.fn((obj: unknown) => {
      const url = `blob:${++urlCount}`;
      if (obj instanceof FakeMediaSource) mediaSourceUrls.set(url, obj);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    mocks.getTtsSettings.mockReset().mockResolvedValue(SETTINGS);
    bodies = [];
    signals = [];
    mocks.openSpeechStream.mockReset().mockImplementation(async (_text: string, opts: { signal: AbortSignal }) => {
      const body = controlledBody();
      bodies.push(body);
      signals.push(opts.signal);
      return body.response();
    });
    player = new TtsPlayer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts playing before the first chunk has finished downloading", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));

    bodies[0].push(1000);
    await vi.waitFor(() => expect(mediaSource().sourceBuffer?.appended).toEqual([1000]));
    // Playback was started on the MediaSource while chunk 1 is still open.
    expect(audio().playCalls.at(-1)).toBe([...mediaSourceUrls.keys()][0]);
    expect(mediaSource().mime).toBe("audio/mpeg");
    expect(mediaSource().sourceBuffer?.mode).toBe("sequence");
    expect(audio().playbackRate).toBe(1.25);

    audio().dispatchEvent(new Event("playing"));
    expect(player.getSnapshot()).toMatchObject({ status: "playing", chunk: 0, total: 2 });
    // One request at a time: chunk 2 is not requested yet.
    expect(bodies).toHaveLength(1);
  });

  it("requests the next chunk once the previous one is received, into the same buffer", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bodies[0].push(500);
    bodies[0].push(500);
    bodies[0].close();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    bodies[1].push(700);
    bodies[1].close();
    await vi.waitFor(() => expect(mediaSource().readyState).toBe("ended"));
    // Gapless: both chunks went into one MediaSource / SourceBuffer.
    expect(FakeMediaSource.instances).toHaveLength(1);
    expect(mediaSource().sourceBuffer?.appended).toEqual([500, 500, 700]);

    // Progress follows the playhead across the chunk boundary (1 KB ≈ 1 s).
    audio().dispatchEvent(new Event("playing"));
    audio().currentTime = 1.2;
    audio().dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot()).toMatchObject({ status: "playing", chunk: 1 });

    audio().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(player.getSnapshot()).toEqual({ status: "idle" }));
  });

  it("shows loading when playback stalls waiting for data", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bodies[0].push(100);
    await vi.waitFor(() => expect(mediaSource().sourceBuffer?.appended).toHaveLength(1));
    audio().dispatchEvent(new Event("playing"));
    audio().dispatchEvent(new Event("waiting"));
    expect(player.getSnapshot()).toMatchObject({ status: "loading", ownerKey: "m1" });
  });

  it("stop cancels the download", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bodies[0].push(100);
    await vi.waitFor(() => expect(mediaSource().sourceBuffer?.appended).toHaveLength(1));

    player.stop();
    expect(signals[0].aborted).toBe(true);
    expect(player.getSnapshot()).toEqual({ status: "idle" });
  });

  it("an audio error ends the run at once, even while the response stays open", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bodies[0].push(100);
    await vi.waitFor(() => expect(mediaSource().sourceBuffer?.appended).toHaveLength(1));

    // The response never finishes; the element fails.
    audio().dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(player.getSnapshot()).toMatchObject({ status: "error", ownerKey: "m1" }));
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(bodies[0].cancelled).toBe(true));
    expect(bodies).toHaveLength(1);
  });

  it("a rejected play() ends the run at once, even while the response stays open", async () => {
    player.play("m1", LONG);
    audio().rejectStreamPlay = new DOMException("blocked", "NotAllowedError");
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // No bytes ever arrive: the read is parked.
    await vi.waitFor(() =>
      expect(player.getSnapshot()).toMatchObject({ status: "error", message: "The browser blocked audio playback" }),
    );
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(bodies[0].cancelled).toBe(true));
  });

  it("replays from the cache without new requests", async () => {
    player.play("m1", LONG);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bodies[0].push(300);
    bodies[0].close();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    bodies[1].push(300);
    bodies[1].close();
    await vi.waitFor(() => expect(mediaSource().readyState).toBe("ended"));
    audio().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(player.getSnapshot()).toEqual({ status: "idle" }));

    player.play("m1", LONG);
    await vi.waitFor(() => expect(FakeMediaSource.instances[1]?.readyState).toBe("ended"));
    expect(mocks.openSpeechStream).toHaveBeenCalledTimes(2);
    expect(FakeMediaSource.instances[1].sourceBuffer?.appended.reduce((a, b) => a + b, 0)).toBe(600);
  });

  it("falls back to whole-chunk playback when the type can't be streamed", async () => {
    mocks.openSpeechStream.mockImplementation(async (text: string) =>
      new Response(new Blob([text]), { headers: { "Content-Type": "audio/wav" } }),
    );
    player.play("m1", "Hello.");
    await vi.waitFor(() => expect(player.getSnapshot()).toMatchObject({ status: "playing" }));
    expect(FakeMediaSource.instances).toHaveLength(0);
    expect(mediaSourceUrls.size).toBe(0);
  });
});
