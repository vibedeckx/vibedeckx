import { describe, it, expect, vi } from "vitest";
import { loadFilesWithRetry } from "./use-file-ref-index";

const noSleep = () => Promise.resolve();

describe("loadFilesWithRetry", () => {
  it("retries past empty results until files arrive", async () => {
    let n = 0;
    const fetchFiles = vi.fn(async () =>
      n++ < 2 ? { files: [], truncated: false } : { files: ["a.ts"], truncated: false },
    );
    const res = await loadFilesWithRetry(fetchFiles, { sleep: noSleep });
    expect(res?.files).toEqual(["a.ts"]);
    expect(fetchFiles).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured retries and returns the last empty result", async () => {
    const fetchFiles = vi.fn(async () => ({ files: [], truncated: false }));
    const res = await loadFilesWithRetry(fetchFiles, { sleep: noSleep, delaysMs: [0, 0] });
    expect(res?.files).toEqual([]);
    expect(fetchFiles).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("returns null when every attempt throws", async () => {
    const fetchFiles = vi.fn(async () => {
      throw new Error("remote down");
    });
    const res = await loadFilesWithRetry(fetchFiles, { sleep: noSleep, delaysMs: [0] });
    expect(res).toBeNull();
    expect(fetchFiles).toHaveBeenCalledTimes(2);
  });

  it("stops early when cancelled mid-flight", async () => {
    const fetchFiles = vi.fn(async () => ({ files: [], truncated: false }));
    let calls = 0;
    const res = await loadFilesWithRetry(fetchFiles, {
      sleep: noSleep,
      cancelled: () => ++calls > 1, // allow first guard, cancel after first fetch
    });
    expect(res).toBeNull();
    expect(fetchFiles).toHaveBeenCalledTimes(1);
  });
});
