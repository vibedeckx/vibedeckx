import { describe, expect, it } from "vitest";
import {
  isReconnectTransition,
  mergeRefreshedSessions,
  updateResidentSessionTitle,
  upsertResidentSession,
  type ResidentSidebarSession,
} from "./use-resident-sessions";

describe("upsertResidentSession", () => {
  it("adds a freshly created live session immediately", () => {
    const created: ResidentSidebarSession = {
      id: "s-new",
      projectId: "p1",
      branch: "feature",
      title: "New Session",
      status: "running",
      processAlive: true,
      updated_at: "2026-07-06T00:00:00.000Z",
    };

    expect(upsertResidentSession([], created)).toEqual([created]);
  });

  it("updates an existing resident session instead of duplicating it", () => {
    const previous: ResidentSidebarSession = {
      id: "s1",
      projectId: "p1",
      branch: null,
      title: "Old",
      status: "stopped",
      processAlive: true,
    };
    const updated = { ...previous, title: "Updated", status: "running" };

    expect(upsertResidentSession([previous], updated)).toEqual([updated]);
  });

  it("does not downgrade a generated title back to the placeholder title", () => {
    const previous: ResidentSidebarSession = {
      id: "s1",
      projectId: "p1",
      branch: null,
      title: "Generated title",
      status: "stopped",
      processAlive: true,
    };
    const reconnectSeed = { ...previous, title: "New Session", status: "running" };

    expect(upsertResidentSession([previous], reconnectSeed)).toEqual([
      { ...previous, status: "running" },
    ]);
  });

  it("updates a resident session title from the websocket title event", () => {
    const previous: ResidentSidebarSession = {
      id: "s1",
      projectId: "p1",
      branch: null,
      title: "New Session",
      status: "running",
      processAlive: true,
    };

    expect(updateResidentSessionTitle([previous], "s1", "Generated title")).toEqual([
      { ...previous, title: "Generated title" },
    ]);
    expect(updateResidentSessionTitle([previous], "missing", "Generated title")).toEqual([previous]);
  });
});

describe("mergeRefreshedSessions", () => {
  const base: ResidentSidebarSession = {
    id: "s1",
    projectId: "p1",
    branch: "feature-a",
    title: "New Session",
    status: "running",
    processAlive: true,
    updated_at: "2026-07-14T00:00:00.000Z",
  };

  it("keeps a resolved title when a stale refresh returns the placeholder", () => {
    // The race: a session:title event resolved the title, then a refresh that
    // started before the backend persisted the title lands with the old
    // placeholder. The merge must not revert the sidebar to "New Session".
    const current = [{ ...base, title: "Add dark mode toggle" }];
    const staleFetch = [{ ...base, title: "New Session" }];

    expect(mergeRefreshedSessions(current, staleFetch)).toEqual([
      { ...base, title: "Add dark mode toggle" },
    ]);
  });

  it("adopts the fetched title when the refresh is the newer source", () => {
    const current = [{ ...base, title: "New Session" }];
    const freshFetch = [{ ...base, title: "Add dark mode toggle" }];

    expect(mergeRefreshedSessions(current, freshFetch)).toEqual([
      { ...base, title: "Add dark mode toggle" },
    ]);
  });

  it("uses the fetched list for membership — drops gone, adds new", () => {
    const current = [{ ...base, id: "gone", title: "Old title" }];
    const fetched = [{ ...base, id: "s-new", title: "New Session" }];

    expect(mergeRefreshedSessions(current, fetched)).toEqual(fetched);
  });
});

describe("isReconnectTransition", () => {
  it("fires when the stream comes back after a drop", () => {
    expect(isReconnectTransition("connecting", "live", true)).toBe(true);
    expect(isReconnectTransition("stale", "live", true)).toBe(true);
  });

  it("does not fire on the very first connect (mount refresh covers it)", () => {
    // Provider starts "connecting", then reaches "live" for the first time.
    expect(isReconnectTransition("connecting", "live", false)).toBe(false);
    expect(isReconnectTransition(null, "live", false)).toBe(false);
  });

  it("does not fire while merely re-rendering in the live state", () => {
    expect(isReconnectTransition("live", "live", true)).toBe(false);
  });

  it("does not fire when going offline", () => {
    expect(isReconnectTransition("live", "connecting", true)).toBe(false);
    expect(isReconnectTransition("live", "stale", true)).toBe(false);
  });
});
