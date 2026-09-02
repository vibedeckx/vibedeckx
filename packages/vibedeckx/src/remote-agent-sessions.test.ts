import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { conventionalWorktreePath } from "./utils/worktree-paths.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("./utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import {
  connectPersistentRemoteWs, createRemoteAgentSession, createRemoteBranchedSession,
  createRemoteWorkflowReviewer,
  bindRemoteSessionMapping, entryPatchFrames, isEntryPatchFrame, recoverPendingRemoteAgentSessions,
  type RemoteAgentSessionDeps,
} from "./remote-agent-sessions.js";

const entryPatch = (index: number, text: string) => JSON.stringify({
  JsonPatch: [{
    op: "add",
    path: `/entries/${index}`,
    value: { type: "ENTRY", content: { type: "assistant", content: text, timestamp: 1 } },
  }],
});
const statusPatch = (content: string) => JSON.stringify({
  JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content } }],
});

describe("replay-sequence classification", () => {
  it("counts entry patches and nothing else", () => {
    // The exact mix a real cache holds after one completed turn.
    const cached = [
      entryPatch(0, "a"),
      statusPatch("running"),
      entryPatch(1, "b"),
      JSON.stringify({ taskCompleted: { summaryText: "done" } }),
      statusPatch("stopped"),
    ];
    expect(entryPatchFrames(cached).length).toBe(2);
  });

  it("excludes the CLEAR_ALL marker, which resets the sequence rather than extending it", () => {
    const clearAll = JSON.stringify({
      JsonPatch: [{
        op: "replace",
        path: "/entries",
        value: { type: "ENTRY", content: { type: "system", content: "__CLEAR_ALL__", timestamp: 1 } },
      }],
    });
    expect(isEntryPatchFrame(JSON.parse(clearAll))).toBe(false);
    expect(entryPatchFrames([clearAll]).length).toBe(0);
  });

  it("ignores non-patch frames and unparseable input", () => {
    expect(isEntryPatchFrame(undefined)).toBe(false);
    expect(isEntryPatchFrame({ taskCompleted: {} })).toBe(false);
    expect(isEntryPatchFrame({ JsonPatch: "not-an-array" })).toBe(false);
    expect(entryPatchFrames(["}{"]).length).toBe(0);
  });
});

describe("reconnect reconciliation", () => {
  const sessionId = "remote-server-1-project-1-worker-session";
  const remoteInfo = { remoteServerId: "server-1", remoteSessionId: "worker-session", branch: "dev" };

  /** Drive a reconnect against a pre-seeded cache and capture what subscribers get. */
  const reconnectWith = (cached: Array<[string, boolean]>, replay: string[]) => {
    const cache = new RemotePatchCache();
    for (const [raw, isPatch] of cached) cache.appendMessage(sessionId, raw, isPatch);

    const received: string[] = [];
    cache.addSubscriber(sessionId, { send: (raw: string) => received.push(raw) } as never);

    let adapter: VirtualWsAdapter | undefined;
    const reverse = {
      isConnected: () => true,
      setChannelAdapter: (_s: string, _c: string, value: VirtualWsAdapter) => { adapter = value; },
      openVirtualChannel: vi.fn(),
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
    };

    connectPersistentRemoteWs(sessionId, remoteInfo, cache, reverse as never);
    for (const frame of replay) adapter!.deliverMessage(frame);
    adapter!.deliverMessage(JSON.stringify({ Ready: true }));

    return { cache, received, entriesIn: (frames: string[]) => frames
      .map((f) => JSON.parse(f) as { JsonPatch?: Array<{ path: string }> })
      .flatMap((m) => m.JsonPatch?.map((op) => op.path) ?? [])
      .filter((p) => p.startsWith("/entries/")) };
  };

  it("delivers every entry the worker gained during the disconnect", () => {
    // Cache holds 2 entry patches but 5 raw messages: the status patches and
    // taskCompleted that a completed turn leaves behind. Comparing raw counts
    // treated those 3 as already-seen entries and sliced them off the delta,
    // permanently losing entries 2-4 from both the stream and the cache.
    const replay = [0, 1, 2, 3, 4, 5, 6].map((i) => entryPatch(i, `e${i}`));
    // Verbatim copies of what the worker already sent — a real cache holds the
    // exact frames, interleaved with the status/taskCompleted traffic.
    const cached: Array<[string, boolean]> = [
      [replay[0], true],
      [statusPatch("running"), true],
      [replay[1], true],
      [JSON.stringify({ taskCompleted: { summaryText: "done" } }), false],
      [statusPatch("stopped"), true],
    ];

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    expect(entriesIn(received)).toEqual([
      "/entries/2", "/entries/3", "/entries/4", "/entries/5", "/entries/6",
    ]);
    // Repaired in the cache too — otherwise every later replay stays short.
    expect(entryPatchFrames(cache.get(sessionId)!.messages).length).toBe(7);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("sends nothing when the cache already matches the worker", () => {
    const replay = [0, 1].map((i) => entryPatch(i, `e${i}`));
    const cached: Array<[string, boolean]> = [
      [replay[0], true],
      [statusPatch("running"), true],
      [replay[1], true],
    ];

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    expect(entriesIn(received)).toEqual([]);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("clears and replaces when the worker has fewer entries than we cached", () => {
    // Session was restarted remotely: our history no longer exists upstream.
    const cached: Array<[string, boolean]> = [0, 1, 2, 3].map((i) => [entryPatch(i, `e${i}`), true]);
    const replay = [entryPatch(0, "fresh")];

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    expect(received.some((r) => r.includes("__CLEAR_ALL__"))).toBe(true);
    expect(entriesIn(received)).toEqual(["/entries/0"]);
    expect(entryPatchFrames(cache.get(sessionId)!.messages).length).toBe(1);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  // restartSession/switchAgentType wipe store.patches AND reset the index
  // provider, so a session restarted during the disconnect replays a brand-new
  // sequence that also starts at /entries/0. Neither length nor index tells it
  // apart from the old sequence having grown.
  it("replaces rather than deltas when a reset sequence has grown past the cached one", () => {
    const cached: Array<[string, boolean]> = [0, 1, 2].map((i) => [entryPatch(i, `old${i}`), true]);
    const replay = [0, 1, 2, 3, 4].map((i) => entryPatch(i, `new${i}`));

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    // A delta would have kept old0..old2 and appended new3, new4 — a cache that
    // is half one conversation and half another, forever.
    expect(received.some((r) => r.includes("__CLEAR_ALL__"))).toBe(true);
    expect(entriesIn(received)).toEqual([
      "/entries/0", "/entries/1", "/entries/2", "/entries/3", "/entries/4",
    ]);
    const repaired = entryPatchFrames(cache.get(sessionId)!.messages);
    expect(repaired).toEqual(replay);
    expect(repaired.some((f) => f.includes("old"))).toBe(false);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("replaces when a reset sequence has the same length as the cached one", () => {
    const cached: Array<[string, boolean]> = [0, 1, 2].map((i) => [entryPatch(i, `old${i}`), true]);
    const replay = [0, 1, 2].map((i) => entryPatch(i, `new${i}`));

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    // Equal counts previously read as "cache is current" and sent nothing,
    // leaving the window showing a conversation the worker no longer has.
    expect(received.some((r) => r.includes("__CLEAR_ALL__"))).toBe(true);
    expect(entriesIn(received)).toEqual(["/entries/0", "/entries/1", "/entries/2"]);
    expect(entryPatchFrames(cache.get(sessionId)!.messages)).toEqual(replay);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("forwards a taskCompleted that races the reconnect instead of folding it into the sequence", () => {
    const cached: Array<[string, boolean]> = [[entryPatch(0, "a"), true]];
    const replay = [
      entryPatch(0, "a"),
      entryPatch(1, "b"),
      JSON.stringify({ taskCompleted: { summaryText: "raced" } }),
    ];

    const { cache, received, entriesIn } = reconnectWith(cached, replay);

    // The taskCompleted must not consume a slot in the sequence comparison,
    // which would have hidden entry 1.
    expect(entriesIn(received)).toEqual(["/entries/1"]);
    expect(received.some((r) => r.includes("raced"))).toBe(true);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("reconciles a window-seeded cache with a bounded upstream tail", () => {
    const cache = new RemotePatchCache();
    for (let index = 120; index <= 160; index++) {
      cache.appendMessage(sessionId, entryPatch(index, `e${index}`), true);
    }
    cache.setHistoryEpoch(sessionId, 3);
    cache.setLastTurnEndEntryIndex(sessionId, 150);
    const received: string[] = [];
    cache.addSubscriber(sessionId, { send: (raw: string) => received.push(raw) } as never);

    let adapter: VirtualWsAdapter | undefined;
    const reverse = {
      isConnected: () => true,
      setChannelAdapter: (_s: string, _c: string, value: VirtualWsAdapter) => { adapter = value; },
      openVirtualChannel: vi.fn(),
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
    };
    connectPersistentRemoteWs(sessionId, remoteInfo, cache, reverse as never);

    expect(reverse.openVirtualChannel).toHaveBeenCalledWith(
      "server-1", expect.any(String), "/api/agent-sessions/worker-session/stream?after=150&epoch=3",
    );
    adapter!.deliverMessage(entryPatch(151, "current-tail"));
    adapter!.deliverMessage(JSON.stringify({ Ready: true, historyEpoch: 3 }));

    expect(received.some((raw) => raw.includes("__CLEAR_ALL__"))).toBe(false);
    expect(received.filter((raw) => raw.includes("/entries/151"))).toHaveLength(1);
    expect(entryPatchFrames(cache.get(sessionId)!.messages).some((raw) => raw.includes("current-tail"))).toBe(true);
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  // Reverses the cold-cache half of b2a1cbf ("load session history in turn
  // windows"), which sent the browser's cursor upstream in every case to keep
  // the full transcript off the tunnel. On a WARM cache that is still right —
  // the replayed tail splices onto a cached prefix. On a cold cache it instead
  // pinned the cache's coverage to whichever subscriber arrived first after a
  // hub restart, so any lower cursor could never be served from cache again and
  // would be handed a `Ready` the hub could not justify. Paying one full replay
  // per session per cold start (p50 ~67KB, p95 ~1.5MB in production) buys a
  // coverage floor of 0, which is what makes that `Ready` provable.
  it("asks for the whole history on a cold cache, ignoring the browser cursor", () => {
    const cache = new RemotePatchCache();
    const reverse = {
      isConnected: () => true,
      setChannelAdapter: vi.fn(),
      openVirtualChannel: vi.fn(),
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
    };
    connectPersistentRemoteWs(
      sessionId, remoteInfo, cache, reverse as never,
      undefined, undefined, undefined,
      { afterEntryIndex: 40, historyEpoch: 2 },
    );
    expect(reverse.openVirtualChannel).toHaveBeenCalledWith(
      "server-1", expect.any(String), "/api/agent-sessions/worker-session/stream",
    );
    expect(cache.get(sessionId)!.coverage).toEqual({ epoch: 2, start: 0 });
    cache.setFinished(sessionId);
    cache.shutdown();
  });

  it("still bounds the request on a warm cache, and keeps that cache's coverage", () => {
    const cache = new RemotePatchCache();
    cache.declareCoverage(sessionId, { epoch: 2, start: 0 });
    cache.appendMessage(sessionId, entryPatch(40, "cached"), true);
    cache.setHistoryEpoch(sessionId, 2);
    const reverse = {
      isConnected: () => true,
      setChannelAdapter: vi.fn(),
      openVirtualChannel: vi.fn(),
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
    };
    connectPersistentRemoteWs(
      sessionId, remoteInfo, cache, reverse as never,
      undefined, undefined, undefined,
      { afterEntryIndex: 40, historyEpoch: 2 },
    );
    expect(reverse.openVirtualChannel).toHaveBeenCalledWith(
      "server-1", expect.any(String), "/api/agent-sessions/worker-session/stream?after=40&epoch=2",
    );
    // The tail replay must not be mistaken for a new, higher coverage floor.
    expect(cache.get(sessionId)!.coverage).toEqual({ epoch: 2, start: 0 });
    cache.setFinished(sessionId);
    cache.shutdown();
  });
});

describe("createRemoteAgentSession", () => {
  let dir: string;
  let storage: Storage;
  let remoteSessionMap: Map<string, RemoteSessionInfo>;
  let upsert: ReturnType<typeof vi.fn>;
  let extendNotificationWatch: ReturnType<typeof vi.fn>;
  let emitBranchActivityIfChanged: ReturnType<typeof vi.fn>;
  let mapping: Record<string, unknown> | undefined;

  const agentMode = "srv-source";
  const projectId = "proj-1";

  const makeDeps = (): RemoteAgentSessionDeps => ({
    remoteSessionMap,
    remoteSessionMappings: {
      upsert,
      upsertBound: async (opts: {
        localSessionId: string; projectId: string; remoteServerId: string;
        remoteSessionId: string; branch: string | null; notificationSyncStart?: string;
      }) => upsert(opts.localSessionId, opts.projectId, opts.remoteServerId,
        opts.remoteSessionId, opts.branch, opts.notificationSyncStart),
      extendNotificationWatch, getByLocal: async () => mapping,
      markTitleResolved: vi.fn(async () => undefined),
    } as unknown as Storage["remoteSessionMappings"],
    remotePatchCache: new RemotePatchCache(),
    agentSessionManager: { emitBranchActivityIfChanged, markTitleResolved: vi.fn() } as never,
    reverseConnectManager: null,
    storage,
  });

  const params = () => ({
    projectId,
    agentMode,
    remoteConfig: { remote_path: "/remote/path" },
    branch: "main" as string | null,
    permissionMode: "edit" as const,
    agentType: "claude-code",
    force: false,
    userId: "user-1" as string | undefined,
  });

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-ras-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: projectId, name: "project", path: null });
    remoteSessionMap = new Map();
    mapping = undefined;
    upsert = vi.fn(async (
      localSessionId: string, mappedProjectId: string, remoteServerId: string,
      remoteSessionId: string, branch: string | null,
    ) => {
      mapping = {
        local_session_id: localSessionId, project_id: mappedProjectId,
        remote_server_id: remoteServerId, remote_session_id: remoteSessionId, branch,
      };
    });
    extendNotificationWatch = vi.fn().mockResolvedValue(undefined);
    emitBranchActivityIfChanged = vi.fn();

    // Enable cross-remote MCP minting: a public URL plus an opted-in remote that
    // is not the source (agentMode). Then the happy path forwards a crossRemoteMcp.
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const target = await storage.remoteServers.create({ name: "b" }, "user-1");
    await storage.remoteServers.update(target.id, { cross_remote_access: "exec" }, "user-1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  it("happy path: pre-registers, forwards sessionId + crossRemoteMcp, upserts, keeps the map entry", async () => {
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[3] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    const deps = makeDeps();

    const res = await createRemoteAgentSession(deps, params());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const localSessionId = res.localSessionId;
    const remoteSessionId = localSessionId.replace(`remote-${agentMode}-${projectId}-`, "");

    // Forwarded body carries the server-generated sessionId and a crossRemoteMcp config.
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
    const call = proxyToRemoteAuto.mock.calls[0];
    expect(call[2]).toBe("/api/path/agent-sessions/new");
    const body = call[3] as { sessionId: string; crossRemoteMcp?: { url: string; token: string } };
    expect(body.sessionId).toBe(remoteSessionId);
    expect(body.crossRemoteMcp?.url).toContain("/api/cross-remote-mcp");
    expect(body.crossRemoteMcp?.token).toBeTruthy();

    // Persisted mapping written with the pre-computed id, and marked
    // `from_start` — this front just created the session, so sequence zero is
    // what recovers a first turn that completes before this row lands.
    expect(upsert).toHaveBeenCalledWith(localSessionId, projectId, agentMode, remoteSessionId, "main", "from_start");
    // Brought into the periodic notification-poll set.
    expect(extendNotificationWatch).toHaveBeenCalledWith(localSessionId, expect.any(Number));

    // Map entry survives a successful create.
    expect(remoteSessionMap.has(localSessionId)).toBe(true);
    expect(remoteSessionMap.get(localSessionId)?.remoteSessionId).toBe(remoteSessionId);
  });

  it("pre-registration ordering: the map entry exists at the moment proxyToRemoteAuto is invoked", async () => {
    let hadEntryAtCallTime = false;
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[3] as { sessionId: string };
      const localSessionId = `remote-${agentMode}-${projectId}-${body.sessionId}`;
      // The race the design exists to prevent: the entry must be present *now*,
      // not merely after proxyToRemoteAuto resolves.
      hadEntryAtCallTime = remoteSessionMap.has(localSessionId);
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });

    await createRemoteAgentSession(makeDeps(), params());
    expect(hadEntryAtCallTime).toBe(true);
  });

  it.each([
    { hub: "new", worker: "old", reportedPath: undefined, expectedSource: "conventional" },
    { hub: "new", worker: "new", reportedPath: "/worker/reported/main", expectedSource: "reported" },
    { hub: "old", worker: "old", reportedPath: undefined, expectedSource: undefined },
    { hub: "old", worker: "new", reportedPath: "/worker/reported/main", expectedSource: undefined },
  ] as const)(
    "supports the $hub hub + $worker worker protocol combination",
    async ({ hub, reportedPath, expectedSource }) => {
      const workerResponse = {
        session: {
          id: "matrix-worker-session",
          processAlive: false,
          ...(reportedPath ? { worktreePath: reportedPath } : {}),
        },
        messages: [],
      };

      if (hub === "old") {
        // This is the pre-extension response decoder: it reads only fields in
        // the original contract. JSON's additive-field semantics ensure a new
        // worker remains consumable without a capability/version handshake.
        const legacyDecode = (data: typeof workerResponse) => ({
          session: { id: data.session.id, processAlive: data.session.processAlive },
          messages: data.messages,
        });
        expect(legacyDecode(workerResponse)).toEqual({
          session: { id: "matrix-worker-session", processAlive: false },
          messages: [],
        });
        return;
      }

      proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: workerResponse });
      const result = await createRemoteAgentSession(makeDeps(), {
        ...params(), remoteSessionId: "matrix-worker-session", localSessionId: "matrix-local-session",
      });
      expect(result.ok).toBe(true);

      const registered = await storage.workspaceRegistry.getByProjectBranch(projectId, "main", agentMode);
      expect(registered?.checkout).toMatchObject({
        path_source: expectedSource,
        worktree_path: reportedPath ?? conventionalWorktreePath("/remote/path", "main"),
      });
    },
  );

  it("upgrades a conventional old-worker path and never downgrades the reported path", async () => {
    await bindRemoteSessionMapping(storage, {
      localSessionId: "legacy-discovered", projectId, remoteServerId: agentMode,
      remoteSessionId: "legacy-worker", branch: "dev", remotePath: "/remote/path",
    });
    let checkout = await storage.workspaceRegistry.getByProjectBranch(projectId, "dev", agentMode);
    expect(checkout?.checkout.path_source).toBe("conventional");

    await bindRemoteSessionMapping(storage, {
      localSessionId: "new-discovered", projectId, remoteServerId: agentMode,
      remoteSessionId: "new-worker", branch: "dev", remotePath: "/remote/path",
      reportedWorktreePath: "/worker/authoritative/dev",
    });
    checkout = await storage.workspaceRegistry.getByProjectBranch(projectId, "dev", agentMode);
    expect(checkout?.checkout).toMatchObject({
      worktree_path: "/worker/authoritative/dev",
      path_source: "reported",
    });

    await bindRemoteSessionMapping(storage, {
      localSessionId: "relocated", projectId, remoteServerId: agentMode,
      remoteSessionId: "relocated-worker", branch: "dev", remotePath: "/remote/path",
      reportedWorktreePath: "/worker/relocated/dev",
    });
    checkout = await storage.workspaceRegistry.getByProjectBranch(projectId, "dev", agentMode);
    expect(checkout?.checkout).toMatchObject({
      worktree_path: "/worker/relocated/dev",
      path_source: "reported",
    });

    await bindRemoteSessionMapping(storage, {
      localSessionId: "later-legacy", projectId, remoteServerId: agentMode,
      remoteSessionId: "later-legacy-worker", branch: "dev", remotePath: "/changed/config/path",
    });
    checkout = await storage.workspaceRegistry.getByProjectBranch(projectId, "dev", agentMode);
    expect(checkout?.checkout.worktree_path).toBe("/worker/relocated/dev");
  });

  it("failure cleanup — !ok: deletes the map entry and returns { ok: false, status }", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 503, data: { error: "boom" } });

    const deps = makeDeps();
    const res = await createRemoteAgentSession(deps, params());
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);

    const recovery = await recoverPendingRemoteAgentSessions(deps, agentMode);
    expect(recovery).toEqual({ attempted: 0, confirmed: 0, failed: 0 });
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown network result pending for recovery", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: false, status: 0, data: { error: "connection lost" }, errorCode: "network_error",
    });

    const res = await createRemoteAgentSession(makeDeps(), params());
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([
      expect.objectContaining({ status: "pending", error: "worker result unknown: network_error" }),
    ]);
  });

  it("makes an unexpected worker session id terminal instead of replaying it", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200, data: { session: { id: "different-id" }, messages: [] },
    });

    const deps = makeDeps();
    const res = await createRemoteAgentSession(deps, params());
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
    expect(await recoverPendingRemoteAgentSessions(deps, agentMode))
      .toEqual({ attempted: 0, confirmed: 0, failed: 0 });
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
  });

  it("failure cleanup — thrown: a rejecting proxyToRemoteAuto deletes the entry and propagates", async () => {
    proxyToRemoteAuto.mockRejectedValue(new Error("reverse-connect channel closed"));

    await expect(createRemoteAgentSession(makeDeps(), params())).rejects.toThrow(
      "reverse-connect channel closed",
    );
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("failure cleanup — upsert throws: deletes the entry and propagates", async () => {
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[3] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    upsert.mockRejectedValue(new Error("db write failed"));

    await expect(createRemoteAgentSession(makeDeps(), params())).rejects.toThrow("db write failed");
    expect(remoteSessionMap.size).toBe(0);
  });

  it("retries the same worker identity after a create response was lost before mapping persistence", async () => {
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId, status: "running" }, messages: [] } };
    });
    upsert.mockRejectedValueOnce(new Error("frontend crashed before mapping"));
    const identity = { remoteSessionId: "worker-preallocated", localSessionId: "front-preallocated" };

    await expect(createRemoteAgentSession(makeDeps(), { ...params(), ...identity }))
      .rejects.toThrow("frontend crashed before mapping");
    expect(remoteSessionMap.has(identity.localSessionId)).toBe(false);
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([
      expect.objectContaining({
        local_session_id: identity.localSessionId,
        remote_session_id: identity.remoteSessionId,
        status: "pending",
      }),
    ]);

    const retried = await createRemoteAgentSession(makeDeps(), { ...params(), ...identity });

    expect(retried).toMatchObject({ ok: true, localSessionId: identity.localSessionId,
      remoteSession: { id: identity.remoteSessionId } });
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(2);
    expect(proxyToRemoteAuto.mock.calls.map((call) => (call[3] as { sessionId: string }).sessionId))
      .toEqual([identity.remoteSessionId, identity.remoteSessionId]);
    expect(upsert).toHaveBeenLastCalledWith(
      identity.localSessionId, projectId, agentMode, identity.remoteSessionId, "main", "from_start",
    );
    expect(remoteSessionMap.get(identity.localSessionId)?.remoteSessionId).toBe(identity.remoteSessionId);
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
  });

  it("recovers a pending create with the same worker id after a front restart", async () => {
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    const identity = { remoteSessionId: "worker-after-restart", localSessionId: "front-after-restart" };
    upsert.mockRejectedValueOnce(new Error("hub stopped after worker response"));
    await expect(createRemoteAgentSession(makeDeps(), { ...params(), ...identity }))
      .rejects.toThrow("hub stopped after worker response");

    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId,
      remote_server_id: agentMode,
      remote_path: "/remote/path-moved-after-attempt",
      sort_order: 0,
    });
    const restartedDeps = makeDeps();
    restartedDeps.remoteSessionMap = new Map();
    const recovery = await recoverPendingRemoteAgentSessions(restartedDeps, agentMode);

    expect(recovery).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(proxyToRemoteAuto.mock.calls.map((call) => (call[3] as { sessionId: string }).sessionId))
      .toEqual([identity.remoteSessionId, identity.remoteSessionId]);
    expect(proxyToRemoteAuto.mock.calls.map((call) => (call[3] as { path: string }).path))
      .toEqual(["/remote/path", "/remote/path"]);
    expect(restartedDeps.remoteSessionMap.get(identity.localSessionId)?.remoteSessionId)
      .toBe(identity.remoteSessionId);
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
  });

  it("recovers a conversation branch with the same source, cutoff, and preallocated worker id", async () => {
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { sessionId: string };
      return {
        ok: true,
        status: 200,
        data: { session: { id: body.sessionId, status: "stopped" }, messages: [{ type: "turn_end" }] },
      };
    });
    upsert.mockRejectedValueOnce(new Error("hub stopped before branch mapping"));
    const identity = { remoteSessionId: "worker-branch", localSessionId: "front-branch" };
    const branchParams = {
      projectId,
      agentMode,
      remotePath: "/remote/path",
      branch: "main",
      sourceRemoteSessionId: "worker-source",
      agentType: "codex",
      upToEntryIndex: 0,
      userId: "user-1",
      ...identity,
    };

    await expect(createRemoteBranchedSession(makeDeps(), branchParams))
      .rejects.toThrow("hub stopped before branch mapping");
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([
      expect.objectContaining({
        operation_kind: "branch",
        source_remote_session_id: "worker-source",
        up_to_entry_index: 0,
      }),
    ]);

    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId, remote_server_id: agentMode, remote_path: "/remote/path",
      sort_order: 0,
    });
    const recovered = await recoverPendingRemoteAgentSessions(makeDeps(), agentMode);

    expect(recovered).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(proxyToRemoteAuto.mock.calls.map((call) => call[2])).toEqual([
      "/api/path/agent-sessions/worker-source/branch",
      "/api/path/agent-sessions/worker-source/branch",
    ]);
    expect(proxyToRemoteAuto.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ sessionId: identity.remoteSessionId, agentType: "codex", upToEntryIndex: 0 }),
      expect.objectContaining({ sessionId: identity.remoteSessionId, agentType: "codex", upToEntryIndex: 0 }),
    ]);
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
  });

  it("recovers a workflow reviewer with the same run and reviewer identities", async () => {
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { runId: string; newReviewerSessionId: string };
      return {
        ok: true,
        status: 201,
        data: {
          run: {
            id: body.runId,
            project_id: "worker-project",
            branch: "main",
            source_session_id: "worker-source",
            source_turn_end_index: 4,
            reviewer_session_id: body.newReviewerSessionId,
            review_focus: "tests",
            review_target: null,
            review_span: "this_turn",
            feedback_snapshot: null,
            status: "waiting_reviewer",
            error: null,
            created_at: "",
            updated_at: "",
          },
        },
      };
    });
    upsert.mockRejectedValueOnce(new Error("hub stopped before reviewer mapping"));
    const reviewerParams = {
      projectId,
      agentMode,
      remotePath: "/remote/path",
      branch: "main",
      sourceRemoteSessionId: "worker-source",
      reviewFocus: "tests",
      sourceTurnEndIndex: 4,
      reviewSpan: "this_turn" as const,
      reviewerAgentType: "codex",
      intentBrief: "brief",
      userId: "user-1",
      remoteRunId: "worker-run",
      remoteReviewerSessionId: "worker-reviewer",
      localReviewerSessionId: "front-reviewer",
    };

    await expect(createRemoteWorkflowReviewer(makeDeps(), reviewerParams))
      .rejects.toThrow("hub stopped before reviewer mapping");
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([
      expect.objectContaining({
        remote_run_id: "worker-run",
        remote_reviewer_session_id: "worker-reviewer",
        source_remote_session_id: "worker-source",
      }),
    ]);

    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId, remote_server_id: agentMode, remote_path: "/remote/path",
      sort_order: 0,
    });
    const recovery = await recoverPendingRemoteAgentSessions(makeDeps(), agentMode);

    expect(recovery).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(proxyToRemoteAuto.mock.calls.map((call) => call[2])).toEqual([
      "/api/path/workflow-runs", "/api/path/workflow-runs",
    ]);
    expect(proxyToRemoteAuto.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ runId: "worker-run", newReviewerSessionId: "worker-reviewer" }),
      expect.objectContaining({ runId: "worker-run", newReviewerSessionId: "worker-reviewer" }),
    ]);
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([]);
  });

  it("phase=prepare publishes nothing and leaves the creation intent pending until the post-activation publish", async () => {
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { runId: string; newReviewerSessionId: string };
      expect(args[2]).toBe("/api/path/workflow-runs/prepare");
      return {
        ok: true, status: 201,
        data: { run: {
          id: body.runId, project_id: "worker-project", branch: "main", source_session_id: "worker-source",
          source_turn_end_index: 4, reviewer_session_id: body.newReviewerSessionId, review_focus: null,
          review_target: null, review_span: "this_turn", feedback_snapshot: null, status: "preparing",
          error: null, created_at: "", updated_at: "",
        } },
      };
    });
    const deps = makeDeps();
    const watch = vi.spyOn(deps.remoteSessionMappings, "extendNotificationWatch");
    const result = await createRemoteWorkflowReviewer(deps, {
      projectId, agentMode, remotePath: "/remote/path", branch: "main",
      sourceRemoteSessionId: "worker-source", reviewSpan: "this_turn" as const, reviewerAgentType: "codex",
      userId: "user-1", remoteRunId: "worker-run", remoteReviewerSessionId: "worker-reviewer",
      localReviewerSessionId: "front-reviewer", phase: "prepare",
    });
    expect(result).toMatchObject({ ok: true, localReviewerSessionId: "front-reviewer", remoteReviewerSessionId: "worker-reviewer" });
    // The pending reviewer is not a session on the front yet, and the
    // creation intent stays open until the post-activation publish lands.
    expect(upsert).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(deps.remoteSessionMap.has("front-reviewer")).toBe(false);
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([
      expect.objectContaining({ local_reviewer_session_id: "front-reviewer", remote_run_id: "worker-run" }),
    ]);
  });

  it("hub dies after the mapping but before the watch: recovery tops up the watch and title slot, then confirms — no worker call", async () => {
    await storage.remoteReviewerCreationIntents.begin({
      localReviewerSessionId: "front-reviewer", remoteReviewerSessionId: "worker-reviewer", remoteRunId: "worker-run",
      projectId, remoteServerId: agentMode, branch: "main", remotePath: "/remote/path",
      sourceRemoteSessionId: "worker-source", reviewFocus: null, sourceTurnEndIndex: null, reviewSpan: "this_turn",
      reviewContextMode: null, agentType: "codex", intentBrief: null, userId: "user-1",
    });
    // The publish got as far as the mapping row (bound to a checkout), then the hub died.
    mapping = {
      local_session_id: "front-reviewer", project_id: projectId, remote_server_id: agentMode,
      remote_session_id: "worker-reviewer", branch: "main", workspace_checkout_id: "c-1",
    };
    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId, remote_server_id: agentMode, remote_path: "/remote/path", sort_order: 0,
    });
    const deps = makeDeps();
    const watch = vi.spyOn(deps.remoteSessionMappings, "extendNotificationWatch");
    const title = vi.spyOn(deps.remoteSessionMappings, "markTitleResolved");
    expect(await recoverPendingRemoteAgentSessions(deps, agentMode)).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledWith("front-reviewer", expect.any(Number));
    expect(title).toHaveBeenCalledWith("front-reviewer");
    expect(deps.remoteSessionMap.get("front-reviewer")).toMatchObject({ remoteSessionId: "worker-reviewer" });
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([]);
  });

  it("hub dies after the worker activated but before the publish: boot recovery finds the same live reviewer", async () => {
    // Prepare (phase 1) — intent pending, nothing published.
    proxyToRemoteAuto.mockResolvedValueOnce({
      ok: true, status: 201,
      data: { run: {
        id: "worker-run", project_id: "worker-project", branch: "main", source_session_id: "worker-source",
        source_turn_end_index: 4, reviewer_session_id: "worker-reviewer", review_focus: null, review_target: null,
        review_span: "this_turn", feedback_snapshot: null, status: "preparing", error: null, created_at: "", updated_at: "",
      } },
    });
    await createRemoteWorkflowReviewer(makeDeps(), {
      projectId, agentMode, remotePath: "/remote/path", branch: "main",
      sourceRemoteSessionId: "worker-source", reviewSpan: "this_turn" as const, reviewerAgentType: "codex",
      userId: "user-1", remoteRunId: "worker-run", remoteReviewerSessionId: "worker-reviewer",
      localReviewerSessionId: "front-reviewer", phase: "prepare",
    });
    expect(upsert).not.toHaveBeenCalled();
    // (worker activates; hub crashes before publishRemoteReviewer)

    // Boot recovery replays the pending intent single-shot with the SAME ids;
    // the worker answers with the run it already activated, and only now the
    // front binds the mapping and closes the intent.
    proxyToRemoteAuto.mockImplementationOnce(async (...args: unknown[]) => {
      const body = args[3] as { runId: string; newReviewerSessionId: string };
      expect(args[2]).toBe("/api/path/workflow-runs");
      expect(body).toMatchObject({ runId: "worker-run", newReviewerSessionId: "worker-reviewer" });
      return { ok: true, status: 201, data: { run: {
        id: "worker-run", project_id: "worker-project", branch: "main", source_session_id: "worker-source",
        source_turn_end_index: 4, reviewer_session_id: "worker-reviewer", review_focus: null, review_target: null,
        review_span: "this_turn", feedback_snapshot: null, status: "waiting_reviewer", error: null, created_at: "", updated_at: "",
      } } };
    });
    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId, remote_server_id: agentMode, remote_path: "/remote/path", sort_order: 0,
    });
    const deps = makeDeps();
    expect(await recoverPendingRemoteAgentSessions(deps, agentMode)).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(upsert).toHaveBeenCalledWith("front-reviewer", projectId, agentMode, "worker-reviewer", "main", "from_start");
    expect(deps.remoteSessionMap.get("front-reviewer")).toMatchObject({ remoteSessionId: "worker-reviewer" });
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([]);
  });

  it("accepts an acknowledged old-worker reviewer response but does not leave it replayable", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        run: {
          id: "legacy-run",
          project_id: "worker-project",
          branch: "main",
          source_session_id: "worker-source",
          source_turn_end_index: 4,
          reviewer_session_id: "legacy-reviewer",
          review_focus: null,
          review_target: null,
          review_span: "this_turn",
          feedback_snapshot: null,
          status: "waiting_reviewer",
          error: null,
          created_at: "",
          updated_at: "",
        },
      },
    });

    const result = await createRemoteWorkflowReviewer(makeDeps(), {
      projectId,
      agentMode,
      remotePath: "/remote/path",
      branch: "main",
      sourceRemoteSessionId: "worker-source",
      reviewSpan: "this_turn",
      reviewerAgentType: "claude-code",
      userId: "user-1",
      remoteRunId: "requested-run",
      remoteReviewerSessionId: "requested-reviewer",
      localReviewerSessionId: "requested-local-reviewer",
    });

    expect(result).toMatchObject({
      ok: true,
      localReviewerSessionId: `remote-${agentMode}-${projectId}-legacy-reviewer`,
      remoteReviewerSessionId: "legacy-reviewer",
    });
    expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([]);
  });

  it("coalesces concurrent startup and online recovery sweeps for the same intent", async () => {
    const identity = { remoteSessionId: "worker-single-flight", localSessionId: "front-single-flight" };
    await storage.remoteSessionCreationIntents.begin({
      localSessionId: identity.localSessionId,
      remoteSessionId: identity.remoteSessionId,
      projectId,
      remoteServerId: agentMode,
      branch: "main",
      remotePath: "/remote/path",
      permissionMode: "edit",
      agentType: "claude-code",
      model: null,
      force: false,
      userId: "user-1",
    });
    vi.spyOn(storage.projectRemotes, "getByProjectAndServer").mockResolvedValue({
      project_id: projectId, remote_server_id: agentMode, remote_path: "/remote/path",
      sort_order: 0,
    });
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    proxyToRemoteAuto.mockImplementation(async (...args: unknown[]) => {
      await workerGate;
      const body = args[3] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    const deps = makeDeps();

    const startupSweep = recoverPendingRemoteAgentSessions(deps);
    const onlineSweep = recoverPendingRemoteAgentSessions(deps, agentMode);
    await vi.waitFor(() => expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1));
    releaseWorker();

    await expect(Promise.all([startupSweep, onlineSweep])).resolves.toEqual([
      { attempted: 1, confirmed: 1, failed: 0 },
      { attempted: 1, confirmed: 1, failed: 0 },
    ]);
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
  });

  it("id-echo mismatch: deletes the entry, does NOT upsert, returns status 409", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { session: { id: "a-completely-different-id" }, messages: [] },
    });

    const res = await createRemoteAgentSession(makeDeps(), params());
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("persists status, taskCompleted, and raw error frames before their local EventBus transitions", async () => {
    await storage.projects.create({ id: "stream-project", name: "Stream", path: null }, "user-1");
    const server = await storage.remoteServers.create({ name: "Stream worker", url: "http://worker" }, "user-1");
    await storage.projectRemotes.add({
      project_id: "stream-project", remote_server_id: server.id, remote_path: "/repo",
    });
    const sessionId = `remote-${server.id}-stream-project-worker-session`;
    const remoteInfo = { remoteServerId: server.id, remoteSessionId: "worker-session", branch: "dev" };
    await storage.remoteSessionMappings.upsert(
      sessionId, "stream-project", server.id, "worker-session", "dev", "from_now",
    );
    await storage.searchCache.noteSessionCreated({
      localSessionId: sessionId, projectId: "stream-project", targetId: server.id, branch: "dev",
    });

    let adapter: VirtualWsAdapter | undefined;
    const reverse = {
      isConnected: () => true,
      setChannelAdapter: (_serverId: string, _channelId: string, value: VirtualWsAdapter) => { adapter = value; },
      openVirtualChannel: vi.fn(),
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
    };
    const cache = new RemotePatchCache();
    const bus = new EventBus();
    const updateActivity = vi.spyOn(storage.searchCache, "updateRemoteSessionActivity");
    const observed: Array<{
      event: Extract<GlobalEvent, { type: "session:status" | "session:taskCompleted" }>;
      activity: Promise<Awaited<ReturnType<Storage["searchCache"]["listRemoteSessionActivityByProject"]>>>;
    }> = [];
    bus.subscribe((event) => {
      if (event.type !== "session:status" && event.type !== "session:taskCompleted") return;
      observed.push({
        event,
        activity: storage.searchCache.listRemoteSessionActivityByProject("stream-project", 10),
      });
    });

    connectPersistentRemoteWs(
      sessionId, remoteInfo, cache, reverse as never, bus,
      { emitBranchActivityIfChanged: vi.fn() } as never, storage,
    );
    adapter!.deliverMessage(JSON.stringify({
      JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "running" } }],
    }));

    await vi.waitFor(() => expect(observed[0]?.event).toMatchObject({ sessionId, status: "running" }));
    expect((await observed[0].activity)[0]).toMatchObject({ id: sessionId, status: "running" });

    adapter!.deliverMessage(JSON.stringify({ taskCompleted: { summaryText: "done" } }));
    await vi.waitFor(() => expect(observed[1]?.event).toMatchObject({
      type: "session:taskCompleted", sessionId,
    }));
    expect((await observed[1].activity)[0]).toMatchObject({
      id: sessionId, status: "stopped", lastCompletedAt: expect.any(Number),
    });

    adapter!.deliverMessage(JSON.stringify({ error: "worker failed" }));
    await vi.waitFor(() => expect(observed[2]?.event).toMatchObject({
      type: "session:status", sessionId, status: "error",
    }));
    expect((await observed[2].activity)[0]).toMatchObject({ id: sessionId, status: "error" });

    await storage.remoteSessionMappings.delete(sessionId);
    adapter!.deliverMessage(JSON.stringify({
      JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "running" } }],
    }));
    await vi.waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(4));
    await expect(updateActivity.mock.results[3].value).resolves.toBe(false);
    expect(observed).toHaveLength(3);

    await storage.remoteSessionMappings.upsert(
      sessionId, "stream-project", server.id, "worker-session", "dev", "from_now",
    );
    const association = (await storage.projectRemotes.getByProject("stream-project"))[0];
    await storage.projectRemotes.remove(association.id);
    adapter!.deliverMessage(JSON.stringify({ error: "worker failed again" }));
    await vi.waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(5));
    await expect(updateActivity.mock.results[4].value).resolves.toBe(false);
    expect(observed).toHaveLength(3);

    updateActivity.mockRestore();
    cache.setFinished(sessionId);
    cache.shutdown();
  });
});
