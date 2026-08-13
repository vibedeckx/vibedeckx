import { describe, expect, it } from "vitest";
import { ConversationPatch } from "./conversation-patch.js";
import { RemotePatchCache } from "./remote-patch-cache.js";

const frame = (index: number) => JSON.stringify({
  JsonPatch: ConversationPatch.addEntry(index, { type: "assistant", content: "text", timestamp: 1 }),
});

describe("RemotePatchCache size accounting", () => {
  it("tracks appended bytes per session", () => {
    const cache = new RemotePatchCache();
    const a = frame(0);
    const b = frame(1);
    cache.appendMessage("s1", a, true);
    cache.appendMessage("s1", b, true);

    expect(cache.get("s1")?.approxBytes).toBe(a.length + b.length);
    expect(cache.stats().approx_bytes).toBe(a.length + b.length);
  });

  it("recomputes bytes on full replacement instead of accumulating", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(0), true);
    cache.appendMessage("s1", frame(1), true);

    const replacement = [frame(0)];
    cache.replaceAll("s1", replacement, 1);

    expect(cache.get("s1")?.approxBytes).toBe(replacement[0].length);
  });

  it("drops bytes with the entry-index namespace on resetHistory", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(9), true);
    cache.resetHistory("s1", 2);

    expect(cache.get("s1")?.approxBytes).toBe(0);
    expect(cache.stats().approx_bytes).toBe(0);
  });

  it("keeps the tail's bytes when only the unsealed tail is replaced", () => {
    const cache = new RemotePatchCache();
    const kept = frame(0);
    cache.appendMessage("s1", kept, true);
    cache.appendMessage("s1", frame(1), true);

    const tail = [frame(1), frame(2)];
    cache.replaceEntryTail("s1", 0, tail);

    expect(cache.get("s1")?.approxBytes).toBe(
      kept.length + tail[0].length + tail[1].length,
    );
  });

  it("releases a deleted session's bytes from the aggregate", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(0), true);
    cache.appendMessage("s2", frame(0), true);
    cache.delete("s1");

    const stats = cache.stats();
    expect(stats.sessions).toBe(1);
    expect(stats.approx_bytes).toBe(frame(0).length);
  });
});

describe("RemotePatchCache retention breakdowns", () => {
  it("separates finished and unwatched sessions — the retention-cost signal", () => {
    const cache = new RemotePatchCache();
    const subscriber = { send() {} } as never;

    // Watched and live: cost the cache exists to pay.
    cache.appendMessage("watched", frame(0), true);
    cache.addSubscriber("watched", subscriber);
    // Nobody looking, still streaming: pure retention.
    cache.appendMessage("unwatched", frame(0), true);
    // Finished with nobody looking: will never receive another frame.
    cache.appendMessage("done", frame(0), true);
    cache.setFinished("done");

    const stats = cache.stats();
    expect(stats.sessions).toBe(3);
    expect(stats.with_subscribers).toBe(1);
    expect(stats.subscribers).toBe(1);
    expect(stats.unwatched_sessions).toBe(2);
    expect(stats.unwatched_approx_bytes).toBe(frame(0).length * 2);
    expect(stats.finished_sessions).toBe(1);
    expect(stats.finished_approx_bytes).toBe(frame(0).length);
  });

  it("counts sessions still holding a persistent worker WS", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(0), true);
    cache.setRemoteWs("s1", { readyState: 1 } as never);
    cache.appendMessage("s2", frame(0), true);

    expect(cache.stats().with_remote_ws).toBe(1);
  });

  it("reports per-session percentiles, and zeroes on an empty cache", () => {
    const empty = new RemotePatchCache();
    expect(empty.stats()).toMatchObject({
      sessions: 0,
      approx_bytes: 0,
      per_session_approx_bytes: { p50: 0, p95: 0, p99: 0, max: 0 },
    });

    const cache = new RemotePatchCache();
    // Four sessions of 1, 2, 3 and 4 frames.
    for (let session = 1; session <= 4; session++) {
      for (let i = 0; i < session; i++) cache.appendMessage(`s${session}`, frame(i), true);
    }
    const unit = frame(0).length;
    const stats = cache.stats();

    expect(stats.messages).toBe(1 + 2 + 3 + 4);
    expect(stats.per_session_approx_bytes.max).toBe(unit * 4);
    // Nearest-rank: p50 of [1,2,3,4] units is the 2nd value.
    expect(stats.per_session_approx_bytes.p50).toBe(unit * 2);
    expect(stats.per_session_approx_bytes.p99).toBe(unit * 4);
  });
});
