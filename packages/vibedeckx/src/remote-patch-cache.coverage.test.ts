import { describe, expect, it } from "vitest";
import { ConversationPatch } from "./conversation-patch.js";
import { RemotePatchCache, coverageAdmitsReplay } from "./remote-patch-cache.js";

const frame = (index: number) => JSON.stringify({
  JsonPatch: ConversationPatch.addEntry(index, { type: "assistant", content: "text", timestamp: 1 }),
});

describe("cache coverage as a precondition for claiming a complete replay", () => {
  it("refuses a client whose cursor predates the cache's authorized start", () => {
    // The production shape: cache built from a bounded upstream replay at 227,
    // a second reader arriving with an older cursor.
    const coverage = { epoch: 0, start: 228 };
    expect(coverageAdmitsReplay(coverage, 0, 221)).toBe(false);
    expect(coverageAdmitsReplay(coverage, 0, 227)).toBe(true);
  });

  it("refuses a client asking from the beginning when the cache starts mid-history", () => {
    // `after` absent is the most permissive request there is: everything from 0.
    expect(coverageAdmitsReplay({ epoch: 0, start: 156 }, 0, undefined)).toBe(false);
    expect(coverageAdmitsReplay({ epoch: 0, start: 0 }, 0, undefined)).toBe(true);
  });

  it("refuses a cursor from a different entry-index namespace", () => {
    expect(coverageAdmitsReplay({ epoch: 3, start: 0 }, 2, 10)).toBe(false);
    expect(coverageAdmitsReplay({ epoch: 3, start: 0 }, 3, 10)).toBe(true);
    // An epoch-less client (pre-window UI) cannot be contradicted, and an
    // epoch-less coverage statement makes no claim about namespaces.
    expect(coverageAdmitsReplay({ epoch: 3, start: 0 }, undefined, 10)).toBe(true);
    expect(coverageAdmitsReplay({ epoch: null, start: 0 }, 2, 10)).toBe(true);
  });

  it("proves nothing when no coverage was ever declared", () => {
    expect(coverageAdmitsReplay(null, 0, 221)).toBe(false);
    expect(coverageAdmitsReplay(null, undefined, undefined)).toBe(false);
  });

  it("keeps the bound of a bounded replay that returned no entries at all", () => {
    // The 2026-08-12 shape: `after=27`, worker replays nothing, only a `/status`
    // frame lands. An arrival-derived low-water mark has no data here; the
    // requested bound still says everything at or below 27 is unknown.
    const cache = new RemotePatchCache();
    cache.declareCoverage("s1", { epoch: 0, start: 28 });
    cache.appendMessage("s1", JSON.stringify({ JsonPatch: ConversationPatch.updateStatus("stopped") }), true);

    const entry = cache.get("s1")!;
    expect(entry.latestEntryIndex).toBeNull();
    expect(entry.messages).toHaveLength(1);
    // The client that asked for `after=27` is served: it needs 28 onwards, and
    // "nothing above 27 exists" is a complete answer for that range.
    expect(coverageAdmitsReplay(entry.coverage, 0, 27)).toBe(true);
    // An older reader is not, and no arrival-derived bound could tell them apart
    // — there is not a single entry frame in this cache to derive one from.
    expect(coverageAdmitsReplay(entry.coverage, 0, 20)).toBe(false);
    expect(coverageAdmitsReplay(entry.coverage, 0, undefined)).toBe(false);
  });

  it("does not raise the start when only the tail is replaced", () => {
    const cache = new RemotePatchCache();
    cache.declareCoverage("s1", { epoch: 0, start: 0 });
    cache.appendMessage("s1", frame(4), true);
    cache.appendMessage("s1", frame(5), true);
    // replaceEntryTail funnels through replaceAll; recomputing coverage there
    // would move the start up to the surviving tail and re-admit a false Ready.
    cache.replaceEntryTail("s1", 4, [frame(5), frame(6)]);
    expect(cache.get("s1")!.coverage).toEqual({ epoch: 0, start: 0 });
    expect(coverageAdmitsReplay(cache.get("s1")!.coverage, 0, undefined)).toBe(true);
  });

  it("treats a namespace reset as complete from its own start", () => {
    const cache = new RemotePatchCache();
    cache.declareCoverage("s1", { epoch: 0, start: 156 });
    cache.resetHistory("s1", 1);
    expect(cache.get("s1")!.coverage).toEqual({ epoch: 1, start: 0 });
    expect(coverageAdmitsReplay(cache.get("s1")!.coverage, 1, undefined)).toBe(true);
  });

  it("adopts a later-learned epoch but drops coverage when the namespace differs", () => {
    const adopting = new RemotePatchCache();
    adopting.declareCoverage("s1", { epoch: null, start: 12 });
    adopting.setHistoryEpoch("s1", 2);
    expect(adopting.get("s1")!.coverage).toEqual({ epoch: 2, start: 12 });

    const diverged = new RemotePatchCache();
    diverged.declareCoverage("s2", { epoch: 1, start: 12 });
    diverged.setHistoryEpoch("s2", 2);
    expect(diverged.get("s2")!.coverage).toBeNull();
  });
});
