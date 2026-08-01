// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { buildUrl, parseUrlState } from "./url-state";

describe("project chat URL state", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("round-trips the canonical project chat thread path", () => {
    const path = buildUrl({
      projectId: "project-1",
      tab: "project-chat",
      threadId: "thread-9",
    });

    expect(path).toBe("/p/project-1/chat/thread-9");
    window.history.replaceState(null, "", path);
    expect(parseUrlState()).toEqual({
      projectId: "project-1",
      tab: "project-chat",
      branch: null,
      threadId: "thread-9",
    });
  });

  it("does not interpret an incomplete chat path as a selected thread", () => {
    window.history.replaceState(null, "", "/p/project-1/chat");

    expect(parseUrlState()).toEqual({
      projectId: "project-1",
      tab: "project-info",
      branch: null,
      threadId: null,
    });
  });

  it("keeps normal project views free of stale thread state", () => {
    const path = buildUrl({ projectId: "project-1", tab: "project-info", threadId: "stale" });

    expect(path).toBe("/p/project-1/project-info");
    window.history.replaceState(null, "", path);
    expect(parseUrlState().threadId).toBeNull();
  });

  it("falls back to Overview for a malformed encoded thread id", () => {
    window.history.replaceState(null, "", "/p/project-1/chat/%E0%A4%A");

    expect(parseUrlState()).toEqual({
      projectId: "project-1",
      tab: "project-info",
      branch: null,
      threadId: null,
    });
  });
});
