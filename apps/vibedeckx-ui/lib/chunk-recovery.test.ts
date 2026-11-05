// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_ERROR_RE,
  CHUNK_RECOVERY_SCRIPT,
  installChunkRecovery,
  isChunkLoadError,
  type ChunkRecoveryApi,
} from "./chunk-recovery";

// A throwaway window per test: the installer attaches listeners and a global,
// which must not leak between cases.
function makeWin(opts: { visible?: boolean; storage?: "ok" | "broken"; stored?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(opts.stored ?? {}));
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = opts.visible === false ? "hidden" : "visible";
  const sessionStorage =
    opts.storage === "broken"
      ? {
          getItem: () => {
            throw new Error("denied");
          },
          setItem: () => {
            throw new Error("denied");
          },
          removeItem: () => {
            throw new Error("denied");
          },
        }
      : {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        };
  const fetch = vi.fn();
  const reload = vi.fn();
  const win = Object.assign(new EventTarget(), {
    document: doc,
    sessionStorage,
    fetch,
    location: { reload },
  });
  const api = () => (win as unknown as Record<string, ChunkRecoveryApi>).__vibedeckxChunkRecovery;
  const setVisible = (visible: boolean) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { win, store, fetch, reload, api, setVisible };
}

const ok = () => Promise.resolve({ ok: true, status: 200 });
const down = () => Promise.reject(new TypeError("Failed to fetch"));
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("chunk recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reloads once the probe succeeds and counts the reload", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    expect(t.api().recover("ChunkLoadError: x")).toBe("scheduled");
    await flush();
    expect(t.fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/build-id\.json\?probe=/), expect.objectContaining({ cache: "no-store" }));
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("1");
  });

  it("keeps probing with backoff while the site is unreachable, then reloads", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(down);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(t.fetch).toHaveBeenCalledTimes(2); // second backoff is 4s
    t.fetch.mockImplementation(ok);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("treats `online` as a hint to probe now, not as proof", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(down);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await flush();
    t.win.dispatchEvent(new Event("online"));
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("does nothing while hidden and resumes when the page becomes visible", async () => {
    const t = makeWin({ visible: false });
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.fetch).not.toHaveBeenCalled();
    t.setVisible(true);
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload if the page went hidden while the probe was out", async () => {
    const t = makeWin();
    let resolveProbe!: (v: { ok: boolean; status: number }) => void;
    t.fetch.mockImplementationOnce(() => new Promise((r) => (resolveProbe = r))).mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await flush();
    t.setVisible(false);
    resolveProbe({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.store.has("vibedeckx-chunk-recovery")).toBe(false); // not consumed
    t.setVisible(true);
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("does not start a second probe while one is in flight", async () => {
    const t = makeWin();
    let resolveProbe!: (v: { ok: boolean; status: number }) => void;
    t.fetch.mockImplementationOnce(() => new Promise((r) => (resolveProbe = r))).mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await flush();
    t.win.dispatchEvent(new Event("online"));
    t.setVisible(false);
    t.setVisible(true);
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    resolveProbe({ ok: true, status: 200 });
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("1");
  });

  it("ignores every trigger after reload() was called", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("ChunkLoadError: x");
    await flush();
    t.win.dispatchEvent(new Event("online"));
    t.setVisible(false);
    t.setVisible(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("probes once for concurrent failures", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    t.api().recover("a");
    t.api().recover("b");
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the reload cap, even when each failure takes long", async () => {
    const t = makeWin({ stored: { "vibedeckx-chunk-recovery": "3" } });
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    expect(t.api().recover("ChunkLoadError: x")).toBe("exhausted");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("clears the count once the app has mounted and stayed healthy", async () => {
    const t = makeWin({ stored: { "vibedeckx-chunk-recovery": "2" } });
    installChunkRecovery(t.win as unknown as Window);
    t.api().appMounted();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("2");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.store.has("vibedeckx-chunk-recovery")).toBe(false);
  });

  it("never clears the count while a boot chunk request is still hanging", async () => {
    // A timed-out chunk can take minutes to fail; if the count cleared in the
    // meantime, the cap would never be reached.
    const t = makeWin({ stored: { "vibedeckx-chunk-recovery": "2" } });
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    await vi.advanceTimersByTimeAsync(300_000); // no appMounted(): boot never finished
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("2");
    t.api().recover("ChunkLoadError: x");
    await flush();
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("3");
  });

  it("keeps the count while a recovery is still pending", async () => {
    const t = makeWin({ stored: { "vibedeckx-chunk-recovery": "2" } });
    t.fetch.mockImplementation(down);
    installChunkRecovery(t.win as unknown as Window);
    t.api().appMounted();
    t.api().recover("ChunkLoadError: x");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.store.get("vibedeckx-chunk-recovery")).toBe("2");
  });

  it("never reloads without a working counter", async () => {
    const t = makeWin({ storage: "broken" });
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    expect(t.api().recover("ChunkLoadError: x")).toBe("unavailable");
    await flush();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("picks up unhandled chunk rejections and build-asset load failures, ignores the rest", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);

    const rejection = (reason: unknown) => Object.assign(new Event("unhandledrejection"), { reason });
    t.win.dispatchEvent(rejection(new Error("boom")));
    const script = document.createElement("script");
    script.src = "https://cdn.example.com/other.js";
    const assetError = new Event("error");
    Object.defineProperty(assetError, "target", { value: script });
    t.win.dispatchEvent(assetError);
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();

    const err = Object.assign(new Error("Failed to load chunk /_next/static/chunks/a.js"), { name: "ChunkLoadError" });
    t.win.dispatchEvent(rejection(err));
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("treats a failed /_next/static/ <script> as a chunk failure", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    installChunkRecovery(t.win as unknown as Window);
    const script = document.createElement("script");
    script.src = "https://vibedeckx.dev/_next/static/chunks/a.js";
    const event = new Event("error");
    Object.defineProperty(event, "target", { value: script });
    t.win.dispatchEvent(event);
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("works when evaluated from the inlined string (no module-scope references)", async () => {
    const t = makeWin();
    t.fetch.mockImplementation(ok);
    new Function("window", CHUNK_RECOVERY_SCRIPT)(t.win);
    t.api().recover("ChunkLoadError: x");
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the installer's pattern in sync with CHUNK_ERROR_RE", () => {
    expect(installChunkRecovery.toString()).toContain(CHUNK_ERROR_RE.source);
  });

  it("classifies chunk errors", () => {
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("ChunkLoadError")).toBe(false);
  });
});
