import { describe, it, expect, afterEach, vi } from "vitest";
import { createRateLimitedWarn } from "./rate-limited-warn.js";

describe("createRateLimitedWarn", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("emits the first hit for a key and swallows repeats inside the window", () => {
    vi.useFakeTimers();
    const warn = spyWarn();
    const log = createRateLimitedWarn(30_000, 500);

    log("a", "first");
    log("a", "second");
    log("a", "third");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("first");
  });

  it("reports how many hits were swallowed on the next window's line", () => {
    vi.useFakeTimers();
    const warn = spyWarn();
    const log = createRateLimitedWarn(30_000, 500);

    log("a", "hit");
    log("a", "hit");
    log("a", "hit");
    vi.advanceTimersByTime(30_001);
    log("a", "hit");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe("hit (+2 more in the last 30s)");
    // The count resets with the new line rather than accumulating forever.
    vi.advanceTimersByTime(30_001);
    log("a", "hit");
    expect(warn.mock.calls[2][0]).toBe("hit");
  });

  it("keeps separate windows per key", () => {
    vi.useFakeTimers();
    const warn = spyWarn();
    const log = createRateLimitedWarn(30_000, 500);

    log("a", "from a");
    log("b", "from b");
    log("a", "from a");

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("caps retained keys even when every one is still inside its window", () => {
    vi.useFakeTimers();
    const warn = spyWarn();
    const max = 500;
    const log = createRateLimitedWarn(30_000, max);

    // Keys come from untrusted input, so a flood of distinct ones must not grow
    // the map without bound. Expiry frees nothing here — all 600 are fresh.
    for (let i = 0; i < 600; i++) log(`k${i}`, `hit ${i}`);
    expect(warn).toHaveBeenCalledTimes(600);

    // The 100 oldest were evicted, so re-reporting one logs anew instead of
    // being suppressed...
    log("k0", "k0 again");
    expect(warn).toHaveBeenCalledTimes(601);
    expect(warn.mock.calls[600][0]).toBe("k0 again");

    // ...while a recent key is still remembered and stays suppressed.
    log("k599", "k599 again");
    expect(warn).toHaveBeenCalledTimes(601);
  });

  it("expires stale keys before resorting to eviction", () => {
    vi.useFakeTimers();
    const warn = spyWarn();
    const log = createRateLimitedWarn(30_000, 3);

    log("old1", "x");
    log("old2", "x");
    vi.advanceTimersByTime(30_001);
    // old1/old2 are past their window; adding two more must reclaim their slots
    // rather than evicting anything still live.
    log("live", "x");
    log("new", "x");
    warn.mockClear();

    log("live", "x");
    expect(warn).not.toHaveBeenCalled();
  });
});
