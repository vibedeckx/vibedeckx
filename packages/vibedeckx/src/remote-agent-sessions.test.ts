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

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("./utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import {
  connectPersistentRemoteWs, createRemoteAgentSession, createRemoteProjectChatSessionWithInstruction,
  entryPatchFrames, isEntryPatchFrame,
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
    } as unknown as Storage["remoteSessionMappings"],
    remotePatchCache: new RemotePatchCache(),
    agentSessionManager: { emitBranchActivityIfChanged } as never,
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

  it("failure cleanup — !ok: deletes the map entry and returns { ok: false, status }", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 503, data: { error: "boom" } });

    const res = await createRemoteAgentSession(makeDeps(), params());
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
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
  });

  it("recreates a lost frontend mapping and only then delivers the initial instruction with the stable key", async () => {
    const activitySpy = vi.spyOn(storage.searchCache, "updateRemoteSessionActivity").mockResolvedValue(true);
    proxyToRemoteAuto.mockImplementation(async (
      _serverId: string, _method: string, apiPath: string, body: Record<string, unknown>,
    ) => apiPath === "/api/path/agent-sessions/new"
      ? { ok: true, status: 200, data: { session: { id: body.sessionId, status: "running" }, messages: [] } }
      : { ok: true, status: 200, data: { accepted: true } });
    upsert.mockRejectedValueOnce(new Error("frontend crashed before mapping"));
    const input = {
      projectId, userId: "user-1", remoteServerId: agentMode,
      remoteConfig: { remote_path: "/remote/path" }, sessionId: "front-preallocated",
      workerSessionId: "550e8400-e29b-41d4-a716-446655440000",
      branch: "main", permissionMode: "edit" as const, agentType: "claude-code", model: null,
      instruction: "Implement", idempotencyKey: "stable-delivery-key",
    };

    await expect(createRemoteProjectChatSessionWithInstruction(makeDeps(), input))
      .rejects.toThrow("frontend crashed before mapping");
    await expect(createRemoteProjectChatSessionWithInstruction(makeDeps(), input))
      .resolves.toEqual({ sessionId: "front-preallocated" });

    expect(upsert).toHaveBeenLastCalledWith(
      "front-preallocated", projectId, agentMode,
      "550e8400-e29b-41d4-a716-446655440000", "main", "from_start",
    );
    expect(proxyToRemoteAuto.mock.calls.filter((call) => call[2] === "/api/path/agent-sessions/new"))
      .toHaveLength(2);
    expect(proxyToRemoteAuto).toHaveBeenLastCalledWith(
      agentMode, "POST", "/api/agent-sessions/550e8400-e29b-41d4-a716-446655440000/message",
      { content: "Implement", idempotencyKey: "stable-delivery-key" },
      expect.objectContaining({ reverseConnectManager: undefined }),
    );
    activitySpy.mockRestore();
  });

  it("rejects an existing frontend mapping whose branch does not match the requested scope", async () => {
    mapping = {
      local_session_id: "preallocated", project_id: projectId, remote_server_id: agentMode,
      remote_session_id: "preallocated", branch: "other",
    };

    await expect(createRemoteProjectChatSessionWithInstruction(makeDeps(), {
      projectId, userId: "user-1", remoteServerId: agentMode,
      remoteConfig: { remote_path: "/remote/path" }, sessionId: "preallocated",
      workerSessionId: "worker-preallocated",
      branch: "main", permissionMode: "edit", agentType: "claude-code", model: null,
      instruction: "No", idempotencyKey: "key",
    })).rejects.toThrow("Session identity is already in use");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("timestamps an initial instruction before its ACK so a concurrent completion stays newer", async () => {
    mapping = {
      local_session_id: "preallocated", project_id: projectId, remote_server_id: agentMode,
      remote_session_id: "worker-preallocated", branch: "main",
    };
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const updateActivity = vi.spyOn(storage.searchCache, "updateRemoteSessionActivity").mockResolvedValue(true);
    proxyToRemoteAuto.mockImplementationOnce(async () => {
      clock = 2_000;
      return { ok: true, status: 200, data: { accepted: true } };
    });

    await createRemoteProjectChatSessionWithInstruction(makeDeps(), {
      projectId, userId: "user-1", remoteServerId: agentMode,
      remoteConfig: { remote_path: "/remote/path" }, sessionId: "preallocated",
      workerSessionId: "worker-preallocated", branch: "main", permissionMode: "edit",
      agentType: "claude-code", model: null, instruction: "Implement", idempotencyKey: "delivery-key",
    });

    expect(updateActivity).toHaveBeenCalledWith(expect.objectContaining({
      status: "running", activityAt: 1_000, lastUserMessageAt: 1_000,
    }));
    updateActivity.mockRestore();
    now.mockRestore();
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
