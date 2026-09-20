import { describe, it, expect, vi, beforeEach } from "vitest";

const { bindMock, ensureStreamMock } = vi.hoisted(() => ({ bindMock: vi.fn(), ensureStreamMock: vi.fn() }));
vi.mock("./remote-agent-sessions.js", () => ({
  bindRemoteSessionMapping: bindMock,
  ensureRemoteAgentStream: ensureStreamMock,
}));

import { publishRemoteLoopSessions, type PublishLoopDeps } from "./remote-loop-sessions.js";
import type { WorkflowRun } from "./storage/types.js";

const SERVER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const PREFIX = `remote-${SERVER}-${PROJECT}-`;
const ANCHOR = `${PREFIX}anchor`;

function makeDeps() {
  const remoteSessionMap = new Map<string, unknown>();
  const extendNotificationWatch = vi.fn(async () => undefined);
  const emit = vi.fn();
  const deps = {
    remoteSessionMap, remotePatchCache: {}, reverseConnectManager: null, eventBus: { emit }, agentSessionManager: {},
    storage: {
      projectRemotes: { getByProjectAndServer: async () => ({ remote_path: "/w/repo" }) },
      remoteSessionMappings: { extendNotificationWatch },
    },
  } as unknown as PublishLoopDeps;
  return { deps, remoteSessionMap, extendNotificationWatch, emit };
}

const run = (over: Partial<WorkflowRun> = {}) => ({
  id: `${PREFIX}${RUN}`, kind: "repeat", status: "running_task", branch: "dev", project_id: PROJECT,
  source_session_id: ANCHOR,
  params: JSON.stringify({ anchorSessionId: ANCHOR, maxMinutes: 60, startedAt: Date.now() }),
  ...over,
}) as WorkflowRun;

describe("publishRemoteLoopSessions", () => {
  beforeEach(() => { vi.clearAllMocks(); bindMock.mockResolvedValue(undefined); });

  it("publishes a worker-created session once: mapping, stream, anchor watch", async () => {
    const { deps, remoteSessionMap, extendNotificationWatch, emit } = makeDeps();
    await publishRemoteLoopSessions(deps, run());
    await publishRemoteLoopSessions(deps, run());
    expect(remoteSessionMap.get(ANCHOR)).toMatchObject({ remoteServerId: SERVER, remoteSessionId: "anchor" });
    expect(bindMock).toHaveBeenCalledTimes(1);
    expect(bindMock.mock.calls[0][1]).toMatchObject({ localSessionId: ANCHOR, notificationSyncStart: "from_start" });
    expect(ensureStreamMock).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(extendNotificationWatch).toHaveBeenCalledTimes(2); // MAX() in storage: cheap, and only ever lengthens
  });

  // The persisted mapping of the anchor is what the loop's bell rests on. An
  // in-memory entry must never stand in for "published".
  it("a first attempt that failed to persist the mapping is completed by the next call", async () => {
    const { deps, remoteSessionMap } = makeDeps();
    bindMock.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    await publishRemoteLoopSessions(deps, run());
    expect(remoteSessionMap.has(ANCHOR)).toBe(true);
    expect(ensureStreamMock).not.toHaveBeenCalled();

    await publishRemoteLoopSessions(deps, run());
    expect(bindMock).toHaveBeenCalledTimes(2);
    expect(ensureStreamMock).toHaveBeenCalledTimes(1);
  });

  it("a session the hub already knows in memory (sidebar discovery, reboot hydration) still gets its mapping ensured", async () => {
    const { deps, remoteSessionMap } = makeDeps();
    const known = { remoteServerId: SERVER, remoteSessionId: "anchor", branch: "dev", marker: "kept" };
    remoteSessionMap.set(ANCHOR, known);
    await publishRemoteLoopSessions(deps, run());
    expect(bindMock).toHaveBeenCalledTimes(1);
    expect(remoteSessionMap.get(ANCHOR)).toBe(known); // never clobbers the existing entry
  });
});
