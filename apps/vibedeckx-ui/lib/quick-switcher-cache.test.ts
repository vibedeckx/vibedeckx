import { beforeEach, describe, expect, it } from "vitest";
import {
  overlayRecents,
  setQuickSwitcherCacheUser,
  touchRecentSessionOpen,
  touchSessionStarted,
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
