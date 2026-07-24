import { beforeEach, describe, expect, it } from "vitest";
import {
  beginEmptyQuerySearch,
  commitEmptyQueryResults,
  getCachedEmptyResults,
  overlayRecents,
  setQuickSwitcherCacheUser,
  touchRecentSessionOpen,
  touchSessionStarted,
  updateCachedSessionTitle,
} from "./quick-switcher-cache";
import type { SearchResponse, SearchResultSession } from "@/lib/api";

const emptyResponse = (): SearchResponse => ({
  projects: [], workspaces: [], sessions: [], favorites: [], cacheState: "fresh",
});

const serverRow = (over: Partial<SearchResultSession> = {}): SearchResultSession => ({
  sessionId: "srv1", projectId: "p1", projectName: "proj", targetId: "local",
  branch: null, title: "Server session", lastActiveAt: Date.now() - 60_000, favoritedAt: null,
  ...over,
});

// Module-level cache state persists across tests — switching to a fresh user
// scope resets both the MRU ledger and the cached snapshot.
let scope = 0;
beforeEach(() => {
  setQuickSwitcherCacheUser(`test-${++scope}`);
});

describe("touchSessionStarted", () => {
  it("materializes the just-created session in Recents before any server row exists", () => {
    // The palette's seeded first frame renders from a snapshot that predates
    // the creation — the synthesized full-row touch must carry it alone.
    touchSessionStarted({
      sessionId: "s-new", projectId: "p1", projectName: "proj", targetId: "local", branch: "dev",
    });
    const { sessions } = overlayRecents(emptyResponse());
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-new"]);
    expect(sessions[0].projectName).toBe("proj");
    expect(sessions[0].title).toBeNull();
  });

  it("ranks the just-created session above older server recents (open = recent)", () => {
    const res = emptyResponse();
    res.sessions = [serverRow()];
    touchSessionStarted({
      sessionId: "s-new", projectId: "p1", projectName: "proj", targetId: "local", branch: "dev",
    });
    expect(overlayRecents(res).sessions.map((s) => s.sessionId)).toEqual(["s-new", "srv1"]);
  });

  it("does not erase a previously known title with its synthesized title-less row", () => {
    // A quick-switcher selection stored a full copy with a title; a later
    // reconnect fires the started-callback again with title unknown.
    touchRecentSessionOpen("s1", serverRow({ sessionId: "s1", title: "Known title" }));
    touchSessionStarted({
      sessionId: "s1", projectId: "p1", projectName: "proj", targetId: "local", branch: null,
    });
    const { sessions } = overlayRecents(emptyResponse());
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(sessions[0].title).toBe("Known title");
  });
});

describe("updateCachedSessionTitle", () => {
  it("updates a title-null MRU copy so the overlay stops showing Untitled", () => {
    // Session created in this window (title generated async → stored null).
    touchSessionStarted({
      sessionId: "s-new", projectId: "p1", projectName: "proj", targetId: "local", branch: "dev",
    });
    updateCachedSessionTitle("s-new", "Generated title");
    const { sessions } = overlayRecents(emptyResponse());
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-new"]);
    expect(sessions[0].title).toBe("Generated title");
  });

  it("patches a title-null row in the cached empty-query snapshot (snapshot rows win over MRU)", () => {
    // The snapshot captured the session before its title was generated.
    touchSessionStarted({
      sessionId: "s-new", projectId: "p1", projectName: "proj", targetId: "local", branch: "dev",
    });
    const res = emptyResponse();
    res.sessions = [serverRow({ sessionId: "s-new", title: null })];
    commitEmptyQueryResults(beginEmptyQuerySearch(), res);
    updateCachedSessionTitle("s-new", "Generated title");
    // Seeded first frame renders from the cached snapshot; overlayRecents
    // prefers snapshot rows over MRU copies, so the snapshot row itself must
    // carry the new title.
    const cached = getCachedEmptyResults();
    expect(cached?.sessions.find((s) => s.sessionId === "s-new")?.title).toBe("Generated title");
    const { sessions } = overlayRecents(cached!);
    expect(sessions[0].title).toBe("Generated title");
  });

  it("keeps the updated title after the session slides out of the server's recency window", () => {
    touchSessionStarted({
      sessionId: "s-old", projectId: "p1", projectName: "proj", targetId: "local", branch: "dev",
    });
    updateCachedSessionTitle("s-old", "Generated title");
    // A later response no longer contains the session (it fell out of the
    // server's recent-10); the overlay must render it from the MRU copy with
    // the written-back title, not fossilized null.
    const later = emptyResponse();
    later.sessions = [serverRow({ sessionId: "srv-other", lastActiveAt: Date.now() })];
    commitEmptyQueryResults(beginEmptyQuerySearch(), later);
    const { sessions } = overlayRecents(later);
    const old = sessions.find((s) => s.sessionId === "s-old");
    expect(old?.title).toBe("Generated title");
  });

  it("writes a cleared title back as null so the palette falls back to Untitled", () => {
    touchRecentSessionOpen("s1", serverRow({ sessionId: "s1", title: "Old name" }));
    updateCachedSessionTitle("s1", null);
    const { sessions } = overlayRecents(emptyResponse());
    expect(sessions[0].title).toBeNull();
  });
});
