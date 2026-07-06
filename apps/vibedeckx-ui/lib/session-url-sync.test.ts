import { describe, expect, it } from "vitest";

import { shouldClearSessionAfterWorkspaceChange } from "./session-url-sync";

describe("shouldClearSessionAfterWorkspaceChange", () => {
  it("clears an existing session id when the user switches workspace directly", () => {
    expect(
      shouldClearSessionAfterWorkspaceChange({
        branchChanged: true,
        projectChanged: false,
        urlSessionId: "old-session",
        pendingSessionSelection: null,
        currentProjectId: "project-1",
        selectedBranch: "feature",
      })
    ).toBe(true);
  });

  it("preserves the selected session id when selecting a session also switches workspace", () => {
    expect(
      shouldClearSessionAfterWorkspaceChange({
        branchChanged: true,
        projectChanged: false,
        urlSessionId: "session-2",
        pendingSessionSelection: {
          projectId: "project-1",
          branch: "feature",
          sessionId: "session-2",
        },
        currentProjectId: "project-1",
        selectedBranch: "feature",
      })
    ).toBe(false);
  });

  it("does not preserve a stale pending session for a different branch", () => {
    expect(
      shouldClearSessionAfterWorkspaceChange({
        branchChanged: true,
        projectChanged: false,
        urlSessionId: "session-2",
        pendingSessionSelection: {
          projectId: "project-1",
          branch: "feature",
          sessionId: "session-2",
        },
        currentProjectId: "project-1",
        selectedBranch: "main",
      })
    ).toBe(true);
  });
});
