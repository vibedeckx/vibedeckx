import { describe, it, expect } from "vitest";
import { taskCompletedEventFromRemoteFrame, mapRemoteRun } from "./remote-status-bridge.js";
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
