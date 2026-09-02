import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createSqliteStorage } from "./storage/sqlite.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { AgentSessionLifecycleService } from "./agent-session-lifecycle.js";
import type { Storage } from "./storage/types.js";

/**
 * Phase 1 exit criteria (design §12): a pending identity never spawns and
 * never enters a projection; activation is the only way in; the same
 * operation/activation key replays instead of creating a second session;
 * cancel/expiry leave a tombstone that a late replay cannot resurrect.
 *
 * Real SQLite, real AgentSessionManager with only `spawnAgent` stubbed.
 */
describe("AgentSessionLifecycleService (local, integrated)", () => {
  let dir: string;
  let storage: Storage;
  let manager: AgentSessionManager;
  let service: AgentSessionLifecycleService;
  let spawn: ReturnType<typeof vi.fn>;
  let stdinWrite: ReturnType<typeof vi.fn>;
  let now: number;

  const base = {
    projectId: "p1", branch: null as string | null, permissionMode: "edit" as const,
    agentType: "claude-code" as const, model: null,
  };

  /** Every list projection the sidebar/search/dashboard/retention read from. */
  const projectionIds = async (): Promise<Record<string, string[]>> => ({
    listByBranch: (await storage.agentSessions.listByBranch("p1", "")).map((s) => s.id),
    latestByBranch: [await storage.agentSessions.getLatestByBranch("p1", "")].flatMap((s) => (s ? [s.id] : [])),
    projectedByProject: (await storage.agentSessions.getProjectedByProjectId("p1")).map((s) => s.id),
    recentActivity: (await storage.agentSessions.listRecentActivityByProject("p1", 10)).map((s) => s.id),
    listByProject: (await storage.agentSessions.listByProject("p1", 10)).map((s) => s.id),
    idsByProject: await storage.agentSessions.listIdsByProject("p1"),
    getAll: (await storage.agentSessions.getAll()).map((s) => s.id),
    retention: (await storage.agentSessions.listRetentionCandidates({ cutoff: now + 1e9, limit: 10 })).map((s) => s.id),
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-lifecycle-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    stdinWrite = vi.fn();
    spawn = vi.fn(async (session: { process: unknown }) => {
      session.process = { exitCode: null, kill: vi.fn(), stdin: { write: stdinWrite } };
    });
    (manager as unknown as { spawnAgent: typeof spawn }).spawnAgent = spawn;
    now = Date.now();
    service = new AgentSessionLifecycleService({
      storage, runtime: manager, now: () => now, replayWindowMs: 60_000,
      pendingTtlMs: { interactive: 10_000, workflow_review: 10_000 },
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepare persists an invisible identity: no spawn, no runtime, no projection", async () => {
    const prepared = await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    expect(prepared.kind).toBe("prepared");
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.getSession("s1")).toBeNull();

    const row = await storage.agentSessions.getLifecycleById("s1");
    expect(row).toMatchObject({
      lifecycle_state: "pending_first_turn", status: "stopped", purpose: "interactive",
      prepare_operation_id: "op-1", activation_key: null,
    });
    expect(row?.workspace_checkout_id).toBeTruthy();
    expect(row?.pending_expires_at).toBe(now + 10_000);

    for (const [name, ids] of Object.entries(await projectionIds())) {
      expect(ids, name).not.toContain("s1");
    }
    // Exact-id reads still reach it: that is how routes authorize activate/cancel.
    expect((await storage.agentSessions.getById("s1"))?.lifecycle_state).toBe("pending_first_turn");
  });

  it("prepare is idempotent on the operation id and rejects a different configuration", async () => {
    const first = await service.prepare({ ...base, operationId: "op-1", purpose: "interactive" });
    const again = await service.prepare({ ...base, operationId: "op-1", purpose: "interactive" });
    expect(first.kind).toBe("prepared");
    expect(again.kind).toBe("replayed");
    expect((again as { view: { sessionId: string } }).view.sessionId).toBe((first as { view: { sessionId: string } }).view.sessionId);
    expect((await storage.agentSessions.getLifecycleByPrepareOperationId("op-1"))?.id).toBeDefined();

    const conflict = await service.prepare({ ...base, branch: "other", operationId: "op-1", purpose: "interactive" });
    expect(conflict.kind).toBe("idempotency_conflict");
    const taken = await service.prepare({ ...base, operationId: "op-2", sessionId: (first as { view: { sessionId: string } }).view.sessionId, purpose: "interactive" });
    expect(taken.kind).toBe("idempotency_conflict");
  });

  it("activate hydrates, spawns once, persists the first user entry, writes stdin, and publishes the session", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    const result = await service.activate({ sessionId: "s1", activationKey: "op-1", instruction: "hello" });
    expect(result.kind).toBe("activated");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stdinWrite).toHaveBeenCalledTimes(1);

    const row = await storage.agentSessions.getLifecycleById("s1");
    expect(row).toMatchObject({
      lifecycle_state: "active", status: "running", activation_key: "op-1",
      activation_user_entry_index: 0, activation_lease_owner: null, activation_attempt: 1, activated_at: now,
    });
    expect(row?.activation_content_hash).toHaveLength(64);
    const entries = await storage.agentSessions.getEntries("s1");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].data)).toMatchObject({ type: "user", content: "hello" });
    expect(manager.getSession("s1")).toMatchObject({ id: "s1", status: "running", dormant: false });

    for (const [name, ids] of Object.entries(await projectionIds())) {
      if (name === "retention") continue; // running rows are never retention candidates
      expect(ids, name).toContain("s1");
    }
  });

  it("activates a prepared row that chose a model: the stored model rides hydrate into the identity CAS", async () => {
    await service.prepare({ ...base, model: "claude-opus-5", operationId: "op-m", sessionId: "sm", purpose: "interactive" });
    const result = await service.activate({ sessionId: "sm", activationKey: "op-m", instruction: "hello" });
    expect(result.kind).toBe("activated");
    expect(manager.getSession("sm")).toMatchObject({ id: "sm", model: "claude-opus-5", status: "running" });
  });

  it("a stale pending row gets its tombstone at activation, not hours later in maintenance", async () => {
    await service.prepare({ ...base, operationId: "op-t", sessionId: "st", purpose: "interactive" });
    now += 10 * 60_000 + 1; // past the interactive pending TTL
    const result = await service.activate({ sessionId: "st", activationKey: "op-t", instruction: "late" });
    expect(result.kind).toBe("expired");
    expect(spawn).not.toHaveBeenCalled();
    expect(stdinWrite).not.toHaveBeenCalled();
    expect(await storage.agentSessions.getLifecycleById("st")).toMatchObject({
      lifecycle_state: "expired", expired_reason: "ttl",
    });
  });

  it("an entry-write failure aborts before stdin and before any announcement; the same key retries cleanly", async () => {
    const emit = vi.fn();
    manager.setEventBus({ emit } as unknown as Parameters<typeof manager.setEventBus>[0]);
    await service.prepare({ ...base, operationId: "op-a", sessionId: "sa", purpose: "commander" });
    // Storage refuses the first user entry: the "entry durable, then stdin"
    // contract (§8.2) means nothing may be delivered or surfaced.
    const failing = vi.spyOn(storage.agentSessions, "upsertEntry").mockRejectedValueOnce(new Error("disk full"));
    const failed = await service.activate({ sessionId: "sa", activationKey: "op-a", instruction: "hi", announceRunning: true });
    expect(failed.kind).toBe("retryable_failure");
    expect(stdinWrite).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session:status" }));
    expect(await storage.agentSessions.getEntries("sa")).toHaveLength(0);
    expect(await storage.agentSessions.getLifecycleById("sa")).toMatchObject({
      lifecycle_state: "pending_first_turn", activation_lease_owner: null, activation_user_entry_index: null,
    });
    failing.mockRestore();

    const retried = await service.activate({ sessionId: "sa", activationKey: "op-a", instruction: "hi", announceRunning: true });
    expect(retried.kind).toBe("activated");
    expect(stdinWrite).toHaveBeenCalledTimes(1);
    // The commander announcement fires only once the first turn is committed.
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "session:status", sessionId: "sa", status: "running" }));
    expect((await storage.agentSessions.getEntries("sa")).filter((e) => (JSON.parse(e.data) as { type: string }).type === "user")).toHaveLength(1);
  });

  it("lease lapses between the real pushEntry and the evidence CAS: one user entry, no stdin, no retryable orphan", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    const original = storage.agentSessions.setActivationUserEntryIndex.bind(storage.agentSessions);
    const cas = vi.spyOn(storage.agentSessions, "setActivationUserEntryIndex").mockImplementationOnce(async (opts) => {
      now += 30_001; // the lease lapsed while the manager was persisting the entry
      return original({ ...opts, now });
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "hello" });
    expect(cas).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("uncertain");
    expect(stdinWrite).not.toHaveBeenCalled();
    const entries = await storage.agentSessions.getEntries("s1");
    expect(entries.filter((e) => (JSON.parse(e.data) as { type: string }).type === "user")).toHaveLength(1);
    expect(await storage.agentSessions.getLifecycleById("s1")).toMatchObject({
      lifecycle_state: "activation_uncertain", activation_error_code: "lease_lost_after_entry",
    });
    // The orphan entry can never be doubled: the same key replays uncertain,
    // hydrate does not run again, stdin stays untouched.
    cas.mockRestore();
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "hello" })).kind).toBe("uncertain");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stdinWrite).not.toHaveBeenCalled();
    expect((await storage.agentSessions.getEntries("s1")).filter((e) => (JSON.parse(e.data) as { type: string }).type === "user")).toHaveLength(1);
  });

  it("replays the same key+content, and conflicts on a different content or key", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "hello" });

    const replay = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "hello" });
    expect(replay.kind).toBe("replayed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stdinWrite).toHaveBeenCalledTimes(1);
    expect(await storage.agentSessions.getEntries("s1")).toHaveLength(1);

    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "other" })).kind).toBe("idempotency_conflict");
    expect((await service.activate({ sessionId: "s1", activationKey: "k2", instruction: "hello" })).kind).toBe("activation_conflict");
  });

  it("a key sticks to a pending row: a different key is refused before any claim", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    // Seed a prior attempt's key without completing it.
    await storage.agentSessions.claimActivation({
      id: "s1", activationKey: "k1", contentHash: "h", contentJson: '"x"', leaseOwner: "gone", leaseExpiresAt: now - 1, now,
    });
    const other = await service.activate({ sessionId: "s1", activationKey: "k2", instruction: "x" });
    expect(other.kind).toBe("activation_conflict");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancel writes a tombstone: activate → 410, prepare replay → expired, cancel again → already_expired", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "workflow_review", owner: { kind: "workflow_run", id: "run-1" } });
    const cancelled = await service.cancel({ sessionId: "s1", reason: "cancelled" });
    expect(cancelled.kind).toBe("cancelled");
    expect(await storage.agentSessions.getLifecycleById("s1")).toMatchObject({
      lifecycle_state: "expired", expired_reason: "cancelled", expired_at: now, owner_kind: "workflow_run", owner_id: "run-1",
    });

    expect((await service.activate({ sessionId: "s1", activationKey: "op-1", instruction: "x" })).kind).toBe("expired");
    expect(spawn).not.toHaveBeenCalled();
    expect((await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "workflow_review", owner: { kind: "workflow_run", id: "run-1" } })).kind).toBe("expired");
    expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("already_expired");
    expect((await service.cancel({ sessionId: "nope", reason: "cancelled" })).kind).toBe("not_found");
    // Still invisible.
    for (const [name, ids] of Object.entries(await projectionIds())) expect(ids, name).not.toContain("s1");
  });

  it("cancel never touches an active session", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    await service.activate({ sessionId: "s1", activationKey: "op-1", instruction: "hello" });
    expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("not_pending");
    expect((await storage.agentSessions.getLifecycleById("s1"))?.lifecycle_state).toBe("active");
    expect(manager.getSession("s1")).not.toBeNull();
  });

  it("start = prepare + activate under one operation id; a retried start replays", async () => {
    const first = await service.start({ ...base, operationId: "op-1", purpose: "commander", instruction: "do it" });
    expect(first.kind).toBe("activated");
    const sessionId = (first as { view: { sessionId: string } }).view.sessionId;
    expect(spawn).toHaveBeenCalledTimes(1);

    const retry = await service.start({ ...base, operationId: "op-1", purpose: "commander", instruction: "do it" });
    expect(retry.kind).toBe("replayed");
    expect((retry as { view: { sessionId: string } }).view.sessionId).toBe(sessionId);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await storage.agentSessions.getEntries(sessionId)).toHaveLength(1);

    const changed = await service.start({ ...base, operationId: "op-1", purpose: "commander", instruction: "do something else" });
    expect(changed.kind).toBe("idempotency_conflict");
  });

  it("TTL expires an unactivated pending row on maintenance; tombstones are GC'd only past the replay window", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    now += 10_001;
    const first = await service.maintain();
    expect(first).toEqual({ expiredByTtl: 1, tombstonesDeleted: 0, payloadsCleared: 0 });
    expect(await storage.agentSessions.getLifecycleById("s1")).toMatchObject({ lifecycle_state: "expired", expired_reason: "ttl" });
    expect((await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" })).kind).toBe("expired");

    now += 59_999;
    expect((await service.maintain()).tombstonesDeleted).toBe(0);
    now += 2;
    expect((await service.maintain()).tombstonesDeleted).toBe(1);
    expect(await storage.agentSessions.getLifecycleById("s1")).toBeUndefined();
  });

  it("maintenance clears activation payloads of long-active rows, keeping hash and outcome", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    await service.activate({ sessionId: "s1", activationKey: "op-1", instruction: "hello" });
    expect((await storage.agentSessions.getLifecycleById("s1"))?.activation_content_json).toBe('"hello"');
    now += 60_001;
    expect((await service.maintain()).payloadsCleared).toBe(1);
    const row = await storage.agentSessions.getLifecycleById("s1");
    expect(row?.activation_content_json).toBeNull();
    expect(row?.activation_content_hash).toHaveLength(64);
    expect(row?.lifecycle_state).toBe("active");
  });

  it("legacy createNewSession refuses to spawn a pending or expired identity", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    await expect(manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "s1" }))
      .rejects.toThrow(/pending_first_turn/);
    await service.cancel({ sessionId: "s1", reason: "cancelled" });
    await expect(manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "s1" }))
      .rejects.toThrow(/expired/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("legacy discard-if-empty cannot delete a pending row", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "s1", purpose: "interactive" });
    expect(await storage.agentSessions.deleteIfEmpty("s1")).toBe(false);
    expect(await manager.discardSessionIfEmpty("s1")).toBe(false);
    expect((await storage.agentSessions.getLifecycleById("s1"))?.lifecycle_state).toBe("pending_first_turn");
  });

  it("startup restore never rebuilds a pending row; recovery + restore bring a crashed activation back honestly", async () => {
    await service.prepare({ ...base, operationId: "op-1", sessionId: "pending", purpose: "interactive" });
    await service.prepare({ ...base, operationId: "op-2", sessionId: "crashed", purpose: "interactive" });
    // Crash after the user entry was persisted but before any agent output.
    await storage.agentSessions.claimActivation({
      id: "crashed", activationKey: "op-2", contentHash: "h", contentJson: '"x"', leaseOwner: "dead", leaseExpiresAt: now + 30_000, now,
    });
    await storage.agentSessions.upsertEntry("crashed", 0, JSON.stringify({ type: "user", content: "x", timestamp: now }));
    await storage.agentSessions.setActivationUserEntryIndex({ id: "crashed", leaseOwner: "dead", entryIndex: 0, now });

    // New process: recover, then restore — the order shared-services uses.
    await manager.shutdown();
    const manager2 = new AgentSessionManager(storage);
    (manager2 as unknown as { spawnAgent: typeof spawn }).spawnAgent = spawn;
    const service2 = new AgentSessionLifecycleService({ storage, runtime: manager2, now: () => now });
    expect(await service2.recover()).toEqual({ leaseCleared: 0, promotedActive: 0, markedUncertain: 1, expiredByTtl: 0 });
    await manager2.restoreSessionsFromDb();

    expect(manager2.getSession("pending")).toBeNull();
    expect(manager2.getSession("crashed")).toMatchObject({ id: "crashed", dormant: true });
    expect(await storage.agentSessions.getLifecycleById("crashed")).toMatchObject({
      lifecycle_state: "activation_uncertain", activation_error_code: "crash_during_activation", activation_lease_owner: null,
    });
    // Uncertain is visible (with its warning), pending still is not.
    const ids = (await storage.agentSessions.listByBranch("p1", "")).map((s) => s.id);
    expect(ids).toContain("crashed");
    expect(ids).not.toContain("pending");
    // And a replay of the crashed activation reports uncertain rather than re-sending.
    const replay = await service2.activate({ sessionId: "crashed", activationKey: "op-2", instruction: "x" });
    expect(replay.kind).toBe("idempotency_conflict"); // hash "h" was seeded, not hashInstruction("x")
    expect(spawn).not.toHaveBeenCalled();
    await manager2.shutdown();
  });
});
