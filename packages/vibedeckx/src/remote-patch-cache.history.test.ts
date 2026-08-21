import { describe, expect, it } from "vitest";
import { ConversationPatch } from "./conversation-patch.js";
import { RemotePatchCache } from "./remote-patch-cache.js";

const frame = (index: number, type: "assistant" | "turn_end") => JSON.stringify({
  JsonPatch: ConversationPatch.addEntry(index, type === "turn_end"
    ? { type, timestamp: 1, outcome: "completed" }
    : { type, content: "text", timestamp: 1 }),
});

describe("RemotePatchCache history metadata", () => {
  it("tracks absolute entry and sealed-turn heads from patches", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(8, "assistant"), true);
    cache.appendMessage("s1", frame(9, "turn_end"), true);
    expect(cache.get("s1")).toMatchObject({ latestEntryIndex: 9, lastTurnEndEntryIndex: 9 });
  });

  it("drops the prior index namespace without dropping live subscribers", () => {
    const cache = new RemotePatchCache();
    const subscriber = { send() {} } as never;
    cache.addSubscriber("s1", subscriber);
    cache.appendMessage("s1", frame(9, "turn_end"), true);
    cache.resetHistory("s1", 4);
    expect(cache.get("s1")).toMatchObject({
      messages: [],
      patchCount: 0,
      historyEpoch: 4,
      latestEntryIndex: null,
      lastTurnEndEntryIndex: null,
    });
    expect(cache.get("s1")?.subscribers.has(subscriber)).toBe(true);
  });

  // The worker pushes a full snapshot on every task change. Appending them
  // would grow the cache without bound and replay a burst of superseded frames
  // to a reloading client, so the newest one is held as a last value.
  it("keeps only the newest background-task snapshot, outside the message log", () => {
    const cache = new RemotePatchCache();
    const snapshot = (ids: string[]) => JSON.stringify({
      backgroundTasks: { tasks: ids.map((taskId) => ({ taskId, startedAt: 1 })) },
    });
    cache.appendMessage("s1", frame(4, "assistant"), true);
    cache.setBackgroundTasks("s1", snapshot(["a"]));
    cache.setBackgroundTasks("s1", snapshot(["a", "b"]));
    expect(cache.get("s1")!.backgroundTasks).toBe(snapshot(["a", "b"]));
    expect(cache.get("s1")!.messages).toEqual([frame(4, "assistant")]);
  });

  // A stale-cache replacement rebuilds `messages` from the worker's replay,
  // which never contains the snapshot — carrying it is the only way the bar
  // survives a resync while the task is still running.
  it("carries the background-task snapshot across a full cache replacement", () => {
    const cache = new RemotePatchCache();
    const snapshot = JSON.stringify({ backgroundTasks: { tasks: [{ taskId: "a", startedAt: 1 }] } });
    cache.setBackgroundTasks("s1", snapshot);
    cache.replaceAll("s1", [frame(0, "assistant")], 1);
    expect(cache.get("s1")!.backgroundTasks).toBe(snapshot);
  });

  // A fresh namespace is a different conversation whose worker-side ledger was
  // reset with it — unlike replaceAll, where the same tasks are still running.
  it("drops the background-task snapshot when the namespace resets", () => {
    const cache = new RemotePatchCache();
    cache.setBackgroundTasks("s1", JSON.stringify({
      backgroundTasks: { tasks: [{ taskId: "a", startedAt: 1 }], turnParked: true },
    }));
    cache.resetHistory("s1", 4);
    expect(cache.get("s1")!.backgroundTasks).toBeNull();
  });

  it("replaces only entries after the sealed boundary", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(4, "turn_end"), true);
    cache.appendMessage("s1", frame(5, "assistant"), true);
    cache.replaceEntryTail("s1", 4, [frame(5, "assistant"), frame(6, "assistant")]);
    const paths = cache.get("s1")!.messages.flatMap((raw) => {
      const parsed = JSON.parse(raw) as { JsonPatch?: Array<{ path: string }> };
      return parsed.JsonPatch?.map((op) => op.path) ?? [];
    });
    expect(paths).toEqual(["/entries/4", "/entries/5", "/entries/6"]);
  });
});
