// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTtsSettings: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { getTtsSettings: mocks.getTtsSettings, synthesizeSpeech: mocks.synthesizeSpeech } };
});

import { TtsRequestError } from "@/lib/api";
import { TtsPlayer } from "./tts-player";

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = "";
  playCalls: string[] = [];
  playRates: number[] = [];
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  play() {
    this.playCalls.push(this.src);
    this.playRates.push(this.playbackRate);
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  finish() {
    this.dispatchEvent(new Event("ended"));
  }
}

const SETTINGS = {
  provider: "azure",
  voice: "v",
  rate: 1,
  configured: true,
  credentials: {},
  rateRange: { min: 0.5, max: 2 },
  providers: [{ id: "azure", label: "Azure", defaultVoice: "v", maxCharsPerRequest: 1500, configured: true, credentialFields: [] }],
};

// Two sentences that can't share the (200-char) first chunk.
const LONG = `${"a".repeat(150)}. ${"b".repeat(150)}.`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const audio = () => FakeAudio.instances[0];

describe("TtsPlayer", () => {
  let player: TtsPlayer;
  let blobCount = 0;

  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = vi.fn(() => `blob:${++blobCount}`);
    URL.revokeObjectURL = vi.fn();
    mocks.getTtsSettings.mockReset().mockResolvedValue(SETTINGS);
    mocks.synthesizeSpeech.mockReset().mockImplementation(async (text: string) => new Blob([text]));
    player = new TtsPlayer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unlocks the audio element synchronously inside the click", () => {
    player.play("m1", "Hello.");
    expect(audio().playCalls).toHaveLength(1);
    expect(audio().playCalls[0]).toMatch(/^data:audio\/wav;base64,/);
  });

  it("plays chunks in order, prefetching the next one while the current plays", async () => {
    player.play("m1", LONG);
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "playing", ownerKey: "m1", chunk: 0, total: 2 });
    // Chunk 2 was requested before chunk 1 finished playing.
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(mocks.synthesizeSpeech.mock.calls[0][0]).toBe(`${"a".repeat(150)}.`);

    const seen: string[] = [];
    const unsubscribe = player.subscribe(() => seen.push(player.getSnapshot().status));
    audio().finish();
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "playing", chunk: 1 });
    // Chunk 2 was already prefetched: no spinner flash at the boundary.
    expect(seen).not.toContain("loading");
    unsubscribe();

    audio().finish();
    await flush();
    expect(player.getSnapshot()).toEqual({ status: "idle" });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("stop aborts in-flight synthesis and goes idle", async () => {
    const pending = deferred<Blob>();
    let signal: AbortSignal | undefined;
    mocks.synthesizeSpeech.mockImplementation((_t: string, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return pending.promise;
    });
    player.play("m1", "Hello.");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "loading", ownerKey: "m1" });

    player.stop();
    expect(signal?.aborted).toBe(true);
    expect(player.getSnapshot()).toEqual({ status: "idle" });
    // A late result from the stopped run must not resurrect it.
    pending.resolve(new Blob(["x"]));
    await flush();
    expect(player.getSnapshot()).toEqual({ status: "idle" });
  });

  it("playing another message stops the current one", async () => {
    player.play("m1", LONG);
    await flush();
    player.play("m2", "Other.");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "playing", ownerKey: "m2" });
  });

  it("toggle stops the active owner", async () => {
    player.toggle("m1", "Hello.");
    await flush();
    expect(player.isActive("m1")).toBe(true);
    player.toggle("m1", "Hello.");
    expect(player.getSnapshot()).toEqual({ status: "idle" });
  });

  it("reports not_configured without calling synthesis", async () => {
    mocks.getTtsSettings.mockResolvedValue({ ...SETTINGS, configured: false });
    player.play("m1", "Hello.");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "error", ownerKey: "m1", code: "not_configured" });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("maps a server-side not_configured to the same code", async () => {
    mocks.synthesizeSpeech.mockRejectedValue(new TtsRequestError("nope", 409, "tts_not_configured"));
    player.play("m1", "Hello.");
    await flush();
    expect(player.getSnapshot()).toMatchObject({ status: "error", code: "not_configured" });
  });

  it("retries once when the server says it is busy", async () => {
    vi.useFakeTimers();
    try {
      mocks.synthesizeSpeech
        .mockRejectedValueOnce(new TtsRequestError("busy", 429, "tts_busy"))
        .mockResolvedValueOnce(new Blob(["ok"]));
      player.play("m1", "Hello.");
      await vi.advanceTimersByTimeAsync(400);
      expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(2);
      expect(player.getSnapshot()).toMatchObject({ status: "playing" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaying the same text reuses the audio", async () => {
    player.play("m1", "Hello.");
    await flush();
    audio().finish();
    await flush();
    player.play("m1", "Hello.");
    await flush();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(player.getSnapshot()).toMatchObject({ status: "playing" });

    player.stop();
    player.invalidateSettings();
    player.play("m1", "Hello.");
    await flush();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(2);
  });

  it("applies speed at playback, never in the synthesis request", async () => {
    mocks.getTtsSettings.mockResolvedValue({ ...SETTINGS, rate: 1.5 });
    player.play("m1", "Hello.");
    await flush();
    expect(audio().playRates.at(-1)).toBe(1.5);
    expect(audio().defaultPlaybackRate).toBe(1.5);
    expect(audio().preservesPitch).toBe(true);
    expect(mocks.synthesizeSpeech.mock.calls[0][1]).not.toHaveProperty("rate");

    // A preview override wins, and reuses the audio already synthesized.
    player.play("m1", "Hello.", { rate: 0.75 });
    await flush();
    expect(audio().playRates.at(-1)).toBe(0.75);
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it("stopOwnersWithPrefix only stops matching owners", async () => {
    player.play("s1:abc", "Hello.");
    await flush();
    player.stopOwnersWithPrefix("s2:");
    expect(player.isActive("s1:abc")).toBe(true);
    player.stopOwnersWithPrefix("s1:");
    expect(player.getSnapshot()).toEqual({ status: "idle" });
  });

  it("does nothing for text with nothing to say", () => {
    player.play("m1", "```bash\nls\n```");
    expect(player.getSnapshot()).toEqual({ status: "idle" });
    expect(FakeAudio.instances).toHaveLength(0);
  });
});
