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
