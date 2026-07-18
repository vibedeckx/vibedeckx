import { describe, it, expect } from "vitest";
import {
  taskCompletedEventFromRemoteFrame,
  mapRemoteReviewerCandidate,
  mapRemoteRun,
  runUpdatedEventFromRemoteFrame,
} from "./remote-status-bridge.js";
import type { RemoteSessionInfo } from "../server-types.js";

const remoteInfo: RemoteSessionInfo = {
  remoteServerId: "srv1",
  remoteUrl: "http://r",
  remoteApiKey: "k",
  remoteSessionId: "bare1",
  branch: "dev",
};
const localId = "remote-srv1-p1-bare1";

describe("taskCompletedEventFromRemoteFrame", () => {
  it("maps ids and forwards turnEndEntryIndex + workflowSuppressed", () => {
    const evt = taskCompletedEventFromRemoteFrame(
      { taskCompleted: { summaryText: "done", turnEndEntryIndex: 7, workflowSuppressed: true } },
      localId,
      remoteInfo,
    );
    expect(evt).toMatchObject({
      type: "session:taskCompleted",
      projectId: "p1",
      branch: "dev",
      sessionId: localId,
      summaryText: "done",
      turnEndEntryIndex: 7,
      workflowSuppressed: true,
    });
  });

  it("omits optional fields when absent and returns null for other frames", () => {
    const evt = taskCompletedEventFromRemoteFrame({ taskCompleted: {} }, localId, remoteInfo);
    expect(evt?.turnEndEntryIndex).toBeUndefined();
    expect(evt?.workflowSuppressed).toBeUndefined();
    expect(taskCompletedEventFromRemoteFrame({ finished: true }, localId, remoteInfo)).toBeNull();
  });
});

describe("mapRemoteRun", () => {
  it("prefixes run + participant ids and rewrites project_id", () => {
    const mapped = mapRemoteRun(
      { id: "run1", project_id: "wp1", source_session_id: "src1", reviewer_session_id: "rev1" },
      "srv1",
      "p1",
    );
    expect(mapped).toEqual({
      id: "remote-srv1-p1-run1",
      project_id: "p1",
      source_session_id: "remote-srv1-p1-src1",
      reviewer_session_id: "remote-srv1-p1-rev1",
    });
  });

  it("keeps a null reviewer null", () => {
    const mapped = mapRemoteRun(
      { id: "run1", project_id: "wp1", source_session_id: "src1", reviewer_session_id: null },
      "srv1",
      "p1",
    );
    expect(mapped.reviewer_session_id).toBeNull();
  });
});

describe("mapRemoteReviewerCandidate", () => {
  it("prefixes an available reviewer id and preserves unavailable/null candidates", () => {
    expect(mapRemoteReviewerCandidate({
      available: true,
      sessionId: "rev1",
      title: "Review - Task",
      agentType: "codex",
      reason: null,
    }, "srv1", "p1")).toMatchObject({
      available: true,
      sessionId: "remote-srv1-p1-rev1",
    });
    expect(mapRemoteReviewerCandidate(null, "srv1", "p1")).toBeNull();
    expect(mapRemoteReviewerCandidate({
      available: false, sessionId: null, title: null, agentType: null, reason: "deleted",
    }, "srv1", "p1")?.sessionId).toBeNull();
  });
});

describe("runUpdatedEventFromRemoteFrame", () => {
  const bare = {
    id: "run1", project_id: "wp1", branch: "dev",
    source_session_id: "src1", source_turn_end_index: 4,
    reviewer_session_id: "rev1", review_focus: null, review_target: null,
    feedback_snapshot: null, status: "waiting_feedback", error: null,
    created_at: "", updated_at: "",
  };

  it("maps run + participant ids into the front id space", () => {
    const evt = runUpdatedEventFromRemoteFrame({ workflowRunUpdated: bare }, localId, remoteInfo);
    expect(evt).toMatchObject({ type: "workflow:run-updated", projectId: "p1", branch: "dev" });
    expect(evt?.run).toMatchObject({
      id: "remote-srv1-p1-run1",
      project_id: "p1",
      source_session_id: "remote-srv1-p1-src1",
      reviewer_session_id: "remote-srv1-p1-rev1",
      status: "waiting_feedback",
    });
  });

  it("returns null for other frames", () => {
    expect(runUpdatedEventFromRemoteFrame({ taskCompleted: {} }, localId, remoteInfo)).toBeNull();
  });
});
