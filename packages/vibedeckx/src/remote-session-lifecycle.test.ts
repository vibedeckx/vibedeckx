import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("./utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));
const mint = vi.hoisted(() => vi.fn(async () => ({ url: "https://hub/mcp", token: "t" })));
vi.mock("./cross-remote-mcp-config.js", () => ({ mintCrossRemoteMcpConfig: mint }));
const ensureStream = vi.hoisted(() => vi.fn());
const titleGen = vi.hoisted(() => vi.fn(async () => {}));
const legacyCreate = vi.hoisted(() => vi.fn());
vi.mock("./remote-agent-sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remote-agent-sessions.js")>();
  return {
    ...actual,
    ensureRemoteAgentStream: ensureStream,
    generateAndPushRemoteSessionTitle: titleGen,
    createRemoteAgentSession: legacyCreate,
  };
});

import { LIFECYCLE_PREPARE_CAPABILITY, RemoteSessionLifecycleAdapter } from "./remote-session-lifecycle.js";
import type { SessionLifecycleView } from "./agent-session-lifecycle.js";

/**
 * Hub adapter (design §9.2): the durable intent lands before any worker call;
 * a lost response replays the same ids and key; the ordinary remote
 * projection (mapping, search cache, stream) appears only once the worker
 * reports active; legacy workers get `/new` → `/message` → `discard-if-empty`.
 */
describe("RemoteSessionLifecycleAdapter", () => {
  let dir: string;
  let storage: Storage;
  let remoteSessionMap: Map<string, RemoteSessionInfo>;
  let adapter: RemoteSessionLifecycleAdapter;
  let emitted: unknown[];
  // Real clock: the search cache stamps `written_at` with Date.now(), and an
  // activity write older than that is (correctly) reported stale.
  let now = 0;

  const view = (over: Partial<SessionLifecycleView>): SessionLifecycleView => ({
    sessionId: "r1", projectId: "path:/w", branch: null, state: "pending_first_turn", purpose: "interactive",
    leaseHeld: false, activationKey: null, activationAttempt: 0, activatedAt: null, activationErrorCode: null,
    userEntryIndex: null, expiredReason: null, expiredAt: null, pendingExpiresAt: now + 60_000, ...over,
  });
  const ok = (kind: string, lifecycle: SessionLifecycleView, status = 201) => ({ ok: true, status, data: { kind, lifecycle } });
  const fail = (kind: string, lifecycle: SessionLifecycleView | undefined, status: number) => ({ ok: false, status, data: { kind, lifecycle } });
  const params = (operationId = "op-1") => ({
    projectId: "p1", remoteServerId: "srv", remotePath: "/w", branch: null as string | null,
    permissionMode: "edit" as const, agentType: "claude-code", model: null, purpose: "interactive" as const,
    operationId, userId: "u1",
  });
  const setCapabilities = async (caps: string[]) => {
    const raw = (await import("better-sqlite3")).default;
    const db = new raw(path.join(dir, "db.sqlite"));
    try { db.prepare("UPDATE remote_servers SET worker_capabilities = ? WHERE id = 'srv'").run(JSON.stringify(caps)); } finally { db.close(); }
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-remote-lifecycle-"));
    now = Date.now();
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: null as unknown as string, agent_mode: "srv" } as never);
    const raw = (await import("better-sqlite3")).default;
    const db = new raw(path.join(dir, "db.sqlite"));
    try {
      db.prepare("INSERT INTO remote_servers (id, name, connect_token, status) VALUES ('srv', 'srv', 'tok', 'online')").run();
      db.prepare("INSERT INTO project_remotes (project_id, remote_server_id, remote_path) VALUES ('p1', 'srv', '/w')").run();
    } finally { db.close(); }
    await setCapabilities([LIFECYCLE_PREPARE_CAPABILITY]);
    remoteSessionMap = new Map();
    emitted = [];
    proxyToRemoteAuto.mockReset();
    ensureStream.mockReset();
    titleGen.mockReset();
    legacyCreate.mockReset();
    adapter = new RemoteSessionLifecycleAdapter({
      remoteSessionMap,
      remoteSessionMappings: storage.remoteSessionMappings,
      remotePatchCache: new RemotePatchCache(),
      agentSessionManager: { emitBranchActivityIfChanged: (...args: unknown[]) => emitted.push(args), markTitleResolved: () => true } as never,
      reverseConnectManager: null,
      storage,
      eventBus: null,
      now: () => now,
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepare records the intent before the worker call, replays the same ids on retry, and publishes nothing", async () => {
    proxyToRemoteAuto.mockImplementationOnce(async () => {
      const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
      expect(intent?.prepared_at).toBeNull();
      return ok("prepared", view({ sessionId: intent!.remote_session_id }));
    });
    const first = await adapter.prepare(params());
    expect(first.kind).toBe("prepared");
    const localId = (first as { view: SessionLifecycleView }).view.sessionId;
    const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
    expect(localId).toBe(intent!.local_session_id);
    expect(localId.startsWith("remote-srv-p1-")).toBe(true);
    expect((first as { view: SessionLifecycleView }).view.remoteSessionId).toBe(intent!.remote_session_id);
    expect(intent?.prepared_at).toBe(now);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith("srv", "POST", "/api/path/agent-sessions/prepare",
      expect.objectContaining({ path: "/w", sessionId: intent!.remote_session_id, operationId: "op-1", purpose: "interactive" }), expect.anything());
    // Nothing visible yet.
    expect(await storage.remoteSessionMappings.getByLocal(localId)).toBeUndefined();
    expect(remoteSessionMap.has(localId)).toBe(false);
    expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]); // lifecycle intents are never boot-replayed

    proxyToRemoteAuto.mockResolvedValueOnce(ok("replayed", view({ sessionId: intent!.remote_session_id }), 200));
    const again = await adapter.prepare(params());
    expect(again.kind).toBe("replayed");
    expect((again as { view: SessionLifecycleView }).view.sessionId).toBe(localId);
    expect(proxyToRemoteAuto.mock.calls[1][3]).toMatchObject({ sessionId: intent!.remote_session_id });

    expect((await adapter.prepare({ ...params(), branch: "other" })).kind).toBe("idempotency_conflict");
  });

  it("a lost prepare response keeps the intent so the retry reuses the same remote id", async () => {
    proxyToRemoteAuto.mockResolvedValueOnce({ ok: false, status: 0, errorCode: "network_error", data: null });
    const lost = await adapter.prepare(params());
    expect(lost.kind).toBe("remote_unreachable");
    const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
    expect(intent?.error).toMatch(/network_error/);
    proxyToRemoteAuto.mockResolvedValueOnce(ok("prepared", view({ sessionId: intent!.remote_session_id })));
    const retried = await adapter.prepare(params());
    expect(retried.kind).toBe("prepared");
    expect(proxyToRemoteAuto.mock.calls[1][3]).toMatchObject({ sessionId: intent!.remote_session_id });
  });

  it("activate pre-registers, mints a token for the local id, and publishes the projection only on activated", async () => {
    proxyToRemoteAuto.mockImplementationOnce(async () => ok("prepared", view({ sessionId: (await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1"))!.remote_session_id })));
    const prepared = await adapter.prepare(params());
    const localId = (prepared as { view: SessionLifecycleView }).view.sessionId;
    const remoteId = (await storage.remoteSessionCreationIntents.getByLocal(localId))!.remote_session_id;

    proxyToRemoteAuto.mockImplementationOnce(async (_srv, method, apiPath, body) => {
      expect(method).toBe("POST");
      expect(apiPath).toBe(`/api/agent-sessions/${remoteId}/activate`);
      expect(body).toMatchObject({ activationKey: "op-1", instruction: "hello", crossRemoteMcp: { url: "https://hub/mcp", token: "t" } });
      expect(remoteSessionMap.get(localId)).toMatchObject({ remoteServerId: "srv", remoteSessionId: remoteId });
      return ok("activated", view({ sessionId: remoteId, state: "active", activationKey: "op-1", activatedAt: now }));
    });
    const result = await adapter.activate({ localSessionId: localId, activationKey: "op-1", instruction: "hello", userId: "u1" });
    expect(result.kind).toBe("activated");
    expect((result as { view: SessionLifecycleView }).view).toMatchObject({ sessionId: localId, projectId: "p1", state: "active", remoteSessionId: remoteId });
    expect(mint).toHaveBeenCalledWith(expect.anything(), { userId: "u1", sessionId: localId, sourceRemoteServerId: "srv" });

    const mapping = await storage.remoteSessionMappings.getByLocal(localId);
    expect(mapping).toMatchObject({ remote_server_id: "srv", remote_session_id: remoteId, notification_sync_start: "from_start" });
    expect(mapping?.notification_watch_until).toBeGreaterThan(now);
    expect((await storage.remoteSessionCreationIntents.getByLocal(localId))?.status).toBe("confirmed");
    expect(ensureStream).toHaveBeenCalledWith(localId, expect.anything());
    expect(titleGen).toHaveBeenCalled();
    expect(emitted[0]).toEqual(["p1", null, { activity: "working", since: now, sessionId: localId }]);
  });

  it("a rejected activation undoes the pre-registration and leaves no projection", async () => {
    proxyToRemoteAuto.mockImplementationOnce(async () => ok("prepared", view({ sessionId: (await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1"))!.remote_session_id })));
    const localId = ((await adapter.prepare(params())) as { view: SessionLifecycleView }).view.sessionId;

    proxyToRemoteAuto.mockResolvedValueOnce(fail("resident_limit", view({ activationKey: "op-1" }), 409));
    const limited = await adapter.activate({ localSessionId: localId, activationKey: "op-1", instruction: "x", userId: "u1" });
    expect(limited.kind).toBe("resident_limit");
    expect(remoteSessionMap.has(localId)).toBe(false);
    expect(await storage.remoteSessionMappings.getByLocal(localId)).toBeUndefined();

    proxyToRemoteAuto.mockResolvedValueOnce({ ok: false, status: 0, errorCode: "timeout", data: null });
    const lost = await adapter.activate({ localSessionId: localId, activationKey: "op-1", instruction: "x", userId: "u1" });
    expect(lost.kind).toBe("remote_unreachable");
    expect(remoteSessionMap.has(localId)).toBe(false);

    proxyToRemoteAuto.mockResolvedValueOnce(fail("expired", view({ state: "expired", expiredReason: "ttl" }), 410));
    expect((await adapter.activate({ localSessionId: localId, activationKey: "op-1", instruction: "x", userId: "u1" })).kind).toBe("expired");
    expect(ensureStream).not.toHaveBeenCalled();
  });

  it("start is one worker round trip and publishes like activate", async () => {
    proxyToRemoteAuto.mockImplementationOnce(async (_srv, method, apiPath, body) => {
      expect(apiPath).toBe("/api/path/agent-sessions/start");
      const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
      expect(body).toMatchObject({ sessionId: intent!.remote_session_id, operationId: "op-1", instruction: "go", purpose: "commander" });
      return ok("activated", view({ sessionId: intent!.remote_session_id, state: "active", purpose: "commander", activationKey: "op-1" }));
    });
    const result = await adapter.start({ ...params(), purpose: "commander", instruction: "go" });
    expect(result.kind).toBe("activated");
    const localId = (result as { view: SessionLifecycleView }).view.sessionId;
    expect(await storage.remoteSessionMappings.getByLocal(localId)).toBeDefined();
    expect((await storage.remoteSessionCreationIntents.getByLocal(localId))).toMatchObject({ status: "confirmed", prepared_at: now });
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
  });

  it("cancel proxies DELETE /preparation and drops the pre-registration", async () => {
    proxyToRemoteAuto.mockImplementationOnce(async () => ok("prepared", view({ sessionId: (await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1"))!.remote_session_id })));
    const localId = ((await adapter.prepare(params())) as { view: SessionLifecycleView }).view.sessionId;
    const remoteId = (await storage.remoteSessionCreationIntents.getByLocal(localId))!.remote_session_id;
    proxyToRemoteAuto.mockImplementationOnce(async (_srv, method, apiPath, body) => {
      expect(method).toBe("DELETE");
      expect(apiPath).toBe(`/api/agent-sessions/${remoteId}/preparation`);
      expect(body).toEqual({ reason: "cancelled" });
      return ok("cancelled", view({ state: "expired", expiredReason: "cancelled" }), 200);
    });
    const cancelled = await adapter.cancel({ localSessionId: localId, reason: "cancelled" });
    expect(cancelled.kind).toBe("cancelled");
    proxyToRemoteAuto.mockResolvedValueOnce(fail("expired", view({ state: "expired" }), 410));
    expect((await adapter.activate({ localSessionId: localId, activationKey: "op-1", instruction: "x", userId: "u1" })).kind).toBe("expired");
    expect((await adapter.cancel({ localSessionId: "remote-nope", reason: "cancelled" })).kind).toBe("not_found");
  });

  it("legacy worker: prepare creates via /new, activate sends /message, cancel discards-if-empty", async () => {
    await setCapabilities(["http:POST /api/path/agent-sessions/new", "http:POST /api/agent-sessions/:param/discard-if-empty"]);
    legacyCreate.mockImplementationOnce(async (_deps, p: { localSessionId: string; remoteSessionId: string; prepareOperationId?: string }) => {
      // Mirror the real create's durable-intent write: it re-`begin`s the row
      // this adapter already keyed by the operation, and `begin` rejects a
      // row whose identity disagrees — so dropping the key here is the 500
      // every legacy-worker first send used to hit.
      await storage.remoteSessionCreationIntents.begin({
        localSessionId: p.localSessionId, remoteSessionId: p.remoteSessionId, projectId: "p1",
        remoteServerId: "srv", branch: null, remotePath: "/w", permissionMode: "edit",
        agentType: "claude-code", model: null, force: false, userId: "u1",
        prepareOperationId: p.prepareOperationId,
      });
      await storage.remoteSessionMappings.upsert(p.localSessionId, "p1", "srv", p.remoteSessionId, null, "from_start");
      remoteSessionMap.set(p.localSessionId, { remoteServerId: "srv", remoteSessionId: p.remoteSessionId, branch: null });
      return { ok: true, localSessionId: p.localSessionId, remoteSession: { id: p.remoteSessionId }, messages: [] };
    });
    const prepared = await adapter.prepare(params());
    expect(prepared.kind).toBe("prepared");
    const v = (prepared as { view: SessionLifecycleView }).view;
    expect(v).toMatchObject({ state: "active", legacy: true });
    expect(legacyCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      localSessionId: v.sessionId, operationId: "op-1", prepareOperationId: "op-1", purpose: "interactive",
    }));
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();

    proxyToRemoteAuto.mockImplementationOnce(async (_srv, method, apiPath, body) => {
      expect(apiPath).toBe(`/api/agent-sessions/${v.remoteSessionId}/message`);
      expect(body).toEqual({ content: "hello", idempotencyKey: "op-1" });
      return { ok: true, status: 200, data: { success: true } };
    });
    const activated = await adapter.activate({ localSessionId: v.sessionId, activationKey: "op-1", instruction: "hello", userId: "u1" });
    expect(activated).toMatchObject({ kind: "activated", view: { legacy: true, state: "active" } });
    expect(ensureStream).toHaveBeenCalledWith(v.sessionId, expect.anything());

    proxyToRemoteAuto.mockImplementationOnce(async (_srv, method, apiPath) => {
      expect(method).toBe("POST");
      expect(apiPath).toBe(`/api/agent-sessions/${v.remoteSessionId}/discard-if-empty`);
      return { ok: true, status: 200, data: { discarded: true } };
    });
    expect((await adapter.cancel({ localSessionId: v.sessionId, reason: "cancelled" })).kind).toBe("cancelled");
    expect(await storage.remoteSessionMappings.getByLocal(v.sessionId)).toBeUndefined();
    expect(remoteSessionMap.has(v.sessionId)).toBe(false);
  });

  it("legacy worker: a definite /message rejection discards the /new-spawned session; a transport blip keeps it", async () => {
    await setCapabilities(["http:POST /api/path/agent-sessions/new", "http:POST /api/agent-sessions/:param/discard-if-empty"]);
    legacyCreate.mockImplementationOnce(async (_deps, p: { localSessionId: string; remoteSessionId: string }) => {
      await storage.remoteSessionMappings.upsert(p.localSessionId, "p1", "srv", p.remoteSessionId, null, "from_start");
      remoteSessionMap.set(p.localSessionId, { remoteServerId: "srv", remoteSessionId: p.remoteSessionId, branch: null });
      return { ok: true, localSessionId: p.localSessionId, remoteSession: { id: p.remoteSessionId }, messages: [] };
    });
    const v = ((await adapter.prepare(params())) as { view: SessionLifecycleView }).view;

    // Tunnel blip: outcome unknown, identity kept for replay, nothing discarded.
    proxyToRemoteAuto.mockResolvedValueOnce({ ok: false, status: 0, errorCode: "network_error", data: null });
    const blip = await adapter.activate({ localSessionId: v.sessionId, activationKey: "op-1", instruction: "hello", userId: "u1" });
    expect(blip.kind).toBe("remote_unreachable");
    expect(await storage.remoteSessionMappings.getByLocal(v.sessionId)).toBeDefined();
    expect(proxyToRemoteAuto.mock.calls.some((c) => String(c[2]).endsWith("/discard-if-empty"))).toBe(false);

    // Worker answered and refused: the spawned session is the orphan the
    // compensation exists for — discard-if-empty runs, mapping and intent go.
    proxyToRemoteAuto
      .mockResolvedValueOnce({ ok: false, status: 503, data: { error: "agent not accepting input" } })
      .mockImplementationOnce(async (_srv, method, apiPath) => {
        expect(method).toBe("POST");
        expect(apiPath).toBe(`/api/agent-sessions/${v.remoteSessionId}/discard-if-empty`);
        return { ok: true, status: 200, data: { discarded: true } };
      });
    const rejected = await adapter.activate({ localSessionId: v.sessionId, activationKey: "op-1", instruction: "hello", userId: "u1" });
    expect(rejected).toMatchObject({ kind: "retryable_failure", errorCode: "legacy_message_503", view: { state: "expired", legacy: true } });
    expect(await storage.remoteSessionMappings.getByLocal(v.sessionId)).toBeUndefined();
    expect(remoteSessionMap.has(v.sessionId)).toBe(false);
    expect(ensureStream).not.toHaveBeenCalled();
  });

  /** docs/cross-remote-session-grants-design.md §6, §7. */
  describe("cross-remote session grants", () => {
    const machine = async (name: string) => {
      const row = await storage.remoteServers.create({ name }, "u1");
      await storage.remoteServers.update(row.id, { cross_remote_access: "exec" }, "u1");
      return row.id;
    };

    it("persists the grants with the intent, before any worker call", async () => {
      const target = await machine("ubuntu-1");
      let grantsAtCall: string[] = [];
      proxyToRemoteAuto.mockImplementationOnce(async () => {
        const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
        grantsAtCall = await storage.sessionRemoteGrants.list(intent!.local_session_id);
        return ok("activated", view({ sessionId: intent!.remote_session_id, state: "active" }));
      });

      const result = await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [target] });
      expect(result.kind).toBe("activated");
      expect(grantsAtCall).toEqual([target]);
    });

    it("sends a byte-identical instruction on a retry after the grants changed", async () => {
      // `resident_limit` leaves the worker's content hash in place, so the
      // retry the UI invites (fail → grant another machine → send again) must
      // not look like different content.
      const a = await machine("ubuntu-1");
      const b = await machine("mac-mini");
      proxyToRemoteAuto.mockResolvedValueOnce(fail("resident_limit", view({ sessionId: "r1" }), 409));
      const first = await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [a] });
      expect(first.kind).toBe("resident_limit");
      const sentFirst = proxyToRemoteAuto.mock.calls[0][3].instruction;
      expect(sentFirst).toContain("ubuntu-1");

      const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
      await storage.sessionRemoteGrants.replace(intent!.local_session_id, "u1", [a, b]);
      await storage.remoteServers.update(a, { name: "renamed" }, "u1");

      proxyToRemoteAuto.mockResolvedValueOnce(ok("activated", view({ sessionId: intent!.remote_session_id, state: "active" })));
      const retry = await adapter.start({ ...params(), instruction: "hello" });
      expect(retry.kind).toBe("activated");
      // Neither the new grant nor the rename may move the delivered bytes.
      expect(proxyToRemoteAuto.mock.calls[1][3].instruction).toBe(sentFirst);
    });

    it("freezes an empty block just as firmly as a populated one", async () => {
      const a = await machine("ubuntu-1");
      proxyToRemoteAuto.mockResolvedValueOnce(fail("resident_limit", view({ sessionId: "r1" }), 409));
      const first = await adapter.start({ ...params(), instruction: "hello" });
      expect(first.kind).toBe("resident_limit");
      expect(proxyToRemoteAuto.mock.calls[0][3].instruction).toBe("hello");

      const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
      await storage.sessionRemoteGrants.replace(intent!.local_session_id, "u1", [a]);
      proxyToRemoteAuto.mockResolvedValueOnce(ok("activated", view({ sessionId: intent!.remote_session_id, state: "active" })));

      const retry = await adapter.start({ ...params(), instruction: "hello" });
      expect(retry.kind).toBe("activated");
      expect(proxyToRemoteAuto.mock.calls[1][3].instruction).toBe("hello");
    });

    it("records the grants before the intent a replay could activate", async () => {
      const target = await machine("ubuntu-1");
      let grantsWhenIntentAppeared: string[] | null = null;
      const realBegin = storage.remoteSessionCreationIntents.begin.bind(storage.remoteSessionCreationIntents);
      vi.spyOn(storage.remoteSessionCreationIntents, "begin").mockImplementationOnce(async (intent) => {
        grantsWhenIntentAppeared = await storage.sessionRemoteGrants.list(intent.localSessionId);
        return realBegin(intent);
      });
      proxyToRemoteAuto.mockResolvedValueOnce(ok("activated", view({ sessionId: "r1", state: "active" })));

      await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [target] });
      expect(grantsWhenIntentAppeared).toEqual([target]);
    });

    it("refuses to start at all when the grants cannot be recorded", async () => {
      const target = await machine("ubuntu-1");
      vi.spyOn(storage.sessionRemoteGrants, "replace").mockRejectedValueOnce(new Error("disk full"));

      await expect(adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [target] }))
        .rejects.toThrow("disk full");
      // Nothing was created and nothing was sent: an agent must not spawn with
      // an allowlist the hub failed to write down.
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();
      expect(await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1")).toBeUndefined();
    });

    it("sends nothing when the first-turn block cannot be frozen, so the retry stays byte-identical", async () => {
      const target = await machine("ubuntu-1");
      vi.spyOn(storage.remoteSessionCreationIntents, "setFirstTurnGrantContext")
        .mockRejectedValueOnce(new Error("db busy"));

      const failed = await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [target] });
      expect(failed.kind).toBe("remote_unreachable");
      expect(proxyToRemoteAuto).not.toHaveBeenCalled();

      // The retry is the first delivery, so it defines the bytes.
      proxyToRemoteAuto.mockResolvedValueOnce(ok("activated", view({ sessionId: "r1", state: "active" })));
      const retry = await adapter.start({ ...params(), instruction: "hello" });
      expect(retry.kind).toBe("activated");
      expect(proxyToRemoteAuto.mock.calls[0][3].instruction).toContain("ubuntu-1");
    });

    it("a retried start does not overwrite grants the user edited in between", async () => {
      const a = await machine("ubuntu-1");
      const b = await machine("mac-mini");
      proxyToRemoteAuto.mockResolvedValueOnce({ ok: false, status: 0, errorCode: "network_error", data: null });
      expect((await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [a] })).kind).toBe("remote_unreachable");

      const intent = await storage.remoteSessionCreationIntents.getByPrepareOperationId("op-1");
      await storage.sessionRemoteGrants.replace(intent!.local_session_id, "u1", [b]);

      proxyToRemoteAuto.mockResolvedValueOnce(ok("activated", view({ sessionId: intent!.remote_session_id, state: "active" })));
      await adapter.start({ ...params(), instruction: "hello", grantedRemoteIds: [a] });
      expect(await storage.sessionRemoteGrants.list(intent!.local_session_id)).toEqual([b]);
    });
  });
});
