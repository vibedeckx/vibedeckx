import { describe, it, expect, vi } from "vitest";
import { restoreRunningRemoteStreams } from "./websocket-routes.js";

describe("restoreRunningRemoteStreams", () => {
  // Status is repaired by the reconcile itself; the stream is only needed for
  // turns still in flight, so their eventual finish (and taskCompleted) is heard.
  it("reattaches only the sessions the worker reports as running", () => {
    const ensure = vi.fn();

    restoreRunningRemoteStreams([
      {
        sessions: [
          { localSessionId: "remote-s-p-a", remoteSessionId: "a", branch: null, status: "running" },
          { localSessionId: "remote-s-p-b", remoteSessionId: "b", branch: null, status: "stopped" },
          { localSessionId: "remote-s-p-c", remoteSessionId: "c", branch: null, status: null },
        ],
      },
      {
        sessions: [
          { localSessionId: "remote-s-q-d", remoteSessionId: "d", branch: "dev", status: "running" },
        ],
      },
    ], ensure);

    expect(ensure.mock.calls.map((c) => c[0])).toEqual(["remote-s-p-a", "remote-s-q-d"]);
  });
});
