// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("last location", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("restores the saved location on a bare-root load", async () => {
    const m = await import("./last-location");
    m.saveLastLocation("/p/proj-1/workspace?branch=dev1&session=s1");
    m.restoreLastLocation();
    expect(window.location.pathname + window.location.search).toBe("/p/proj-1/workspace?branch=dev1&session=s1");
    expect(m.settleRestoredLocation(false)).toBe(true);
  });

  it("never overrides a deep link", async () => {
    const m = await import("./last-location");
    m.saveLastLocation("/p/proj-1/workspace");
    window.history.replaceState(null, "", "/p/proj-2/tasks");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/p/proj-2/tasks");
    expect(m.settleRestoredLocation(false)).toBe(false);
  });

  it("is scoped per user", async () => {
    const m = await import("./last-location");
    m.setLastLocationUser("user-a");
    m.saveLastLocation("/p/proj-a/tasks");
    m.setLastLocationUser("user-b");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/");
    m.setLastLocationUser("user-a");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/p/proj-a/tasks");
  });

  it("ignores non-app values and forgets a discarded location", async () => {
    const m = await import("./last-location");
    window.localStorage.setItem("vibedeckx.lastLocation.solo", "//evil.example/x");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/");

    m.saveLastLocation("/p/gone/tasks");
    m.restoreLastLocation();
    expect(m.settleRestoredLocation(false)).toBe(true);
    window.history.replaceState(null, "", "/");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/");
  });

  it("survives StrictMode's double initializer call", async () => {
    const m = await import("./last-location");
    m.saveLastLocation("/p/gone/tasks");
    m.restoreLastLocation();
    m.restoreLastLocation();
    expect(m.settleRestoredLocation(false)).toBe(true);
  });

  it("navigation away before settling is the user's own", async () => {
    const m = await import("./last-location");
    m.saveLastLocation("/p/proj-1/tasks");
    m.restoreLastLocation();
    // Back/forward lands on a missing project while projects are still loading.
    window.history.replaceState(null, "", "/p/gone/tasks");
    expect(m.settleRestoredLocation(false)).toBe(false);
    window.history.replaceState(null, "", "/");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/p/proj-1/tasks");
  });

  it("settles once: later missing-project navigation is not treated as restored", async () => {
    const m = await import("./last-location");
    m.saveLastLocation("/p/proj-1/tasks");
    m.restoreLastLocation();
    expect(m.settleRestoredLocation(true)).toBe(false);
    // Back/forward later lands on a missing project: not ours to redirect.
    expect(m.settleRestoredLocation(false)).toBe(false);
    window.history.replaceState(null, "", "/");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/p/proj-1/tasks");
  });

  it("a remount at a deep link drops the previous mount's restore, keeping the new user's location", async () => {
    const m = await import("./last-location");
    m.setLastLocationUser("user-a");
    m.saveLastLocation("/p/proj-a/tasks");
    m.restoreLastLocation(); // user A restored, never settled

    // Session expires, URL is kept, user B signs in and the app remounts.
    m.setLastLocationUser("user-b");
    m.saveLastLocation("/p/proj-b/tasks");
    window.history.replaceState(null, "", "/p/proj-a/tasks");
    m.restoreLastLocation();
    expect(m.settleRestoredLocation(false)).toBe(false);

    window.history.replaceState(null, "", "/");
    m.restoreLastLocation();
    expect(window.location.pathname).toBe("/p/proj-b/tasks");
  });
});
