import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createSqliteStorage } from "./storage/sqlite.js";
import { AgentSessionManager, WorkspaceCheckoutUnavailableError } from "./agent-session-manager.js";
import { AgentSessionLifecycleService, hashInstruction, type LifecycleRuntime } from "./agent-session-lifecycle.js";
import { ResidentProcessLimitError } from "./resident-agent-processes.js";
import type { Storage } from "./storage/types.js";

/**
 * Fault injection at every boundary of §13.2, through a scripted runtime.
 * The row-creation half stays real (manager.prepareSessionRow against SQLite)
 * so the CAS statements under test are the production ones; only the
 * process side — hydrate, first send, teardown — is scripted.
 *
 * The invariant checked after every fault: the row is in exactly one of
 * pending (no lease), active, activation_uncertain or expired, and a runtime
 * exists only for active/uncertain.
 */
describe("AgentSessionLifecycleService fault injection", () => {
  let dir: string;
  let storage: Storage;
  let manager: AgentSessionManager;
  let now: number;
  let runtime: LifecycleRuntime & {
    hydrate: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    drop: ReturnType<typeof vi.fn>;
    alive: Set<string>;
  };
  let service: AgentSessionLifecycleService;

  const base = {
    projectId: "p1", branch: null as string | null, permissionMode: "edit" as const,
    agentType: "claude-code" as const, model: null,
  };

  const deferred = <T,>() => {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-lifecycle-faults-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    now = Date.now();
    const alive = new Set<string>();
    const hydrate = vi.fn(async (sessionId: string) => { alive.add(sessionId); });
    const send = vi.fn(async () => true);
    const drop = vi.fn(async (sessionId: string) => alive.delete(sessionId));
    runtime = {
      alive, hydrate, send, drop,
      prepareSessionRow: (input) => manager.prepareSessionRow(input),
      hydratePendingSession: (sessionId, row, opts) => hydrate(sessionId, row, opts),
      sendUserMessage: (sessionId, content, projectPath, userId, opts) => send(sessionId, content, projectPath, userId, opts),
      dropRuntime: (sessionId) => drop(sessionId),
      getSession: (sessionId) => (alive.has(sessionId) ? { status: "running" } : null),
    };
    service = new AgentSessionLifecycleService({ storage, runtime, now: () => now, leaseMs: 30_000 });
  });

  afterEach(async () => {
    await manager.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const prepared = async (id = "s1", key = "op-1") => {
    const r = await service.prepare({ ...base, operationId: key, sessionId: id, purpose: "interactive" });
    expect(r.kind).toBe("prepared");
    return id;
  };
  const row = (id = "s1") => storage.agentSessions.getLifecycleById(id);
  const pendingUnleased = async (id = "s1") => {
    const r = await row(id);
    expect(r?.lifecycle_state).toBe("pending_first_turn");
    expect(r?.activation_lease_owner).toBeNull();
    expect(runtime.alive.has(id)).toBe(false);
    return r!;
  };

  it("resident limit: row stays pending with its key; the same key retries once capacity exists", async () => {
    await prepared();
    runtime.hydrate.mockRejectedValueOnce(new ResidentProcessLimitError(2, []));
    const limited = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(limited.kind).toBe("resident_limit");
    const r = await pendingUnleased();
    expect(r).toMatchObject({ activation_key: "k1", activation_error_code: "resident_limit_reached", activation_attempt: 1 });
    expect(runtime.drop).toHaveBeenCalledWith("s1");

    const retried = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(retried.kind).toBe("activated");
    expect((await row())?.activation_attempt).toBe(2);
    expect(runtime.send).toHaveBeenCalledTimes(1);
  });

  it("spawn failure before any entry is retryable; the row is handed back", async () => {
    await prepared();
    runtime.hydrate.mockRejectedValueOnce(new Error("boom"));
    const failed = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(failed).toMatchObject({ kind: "retryable_failure", errorCode: "spawn_failed" });
    await pendingUnleased();
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it("workspace gone is permanent: 422, row stays pending for TTL, nothing delivered", async () => {
    await prepared();
    runtime.hydrate.mockRejectedValueOnce(new WorkspaceCheckoutUnavailableError("gone"));
    const failed = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(failed).toMatchObject({ kind: "permanent_failure", errorCode: "workspace_unavailable" });
    await pendingUnleased();
  });

  it("spawn that errored in place (missing cwd) is treated as permanent, runtime dropped", async () => {
    await prepared();
    runtime.getSession = () => ({ status: "error" });
    const failed = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(failed).toMatchObject({ kind: "permanent_failure", errorCode: "workspace_unavailable" });
    expect(runtime.drop).toHaveBeenCalledWith("s1");
    expect((await row())?.lifecycle_state).toBe("pending_first_turn");
  });

  it("provider rejected before persisting the entry: provably no side effect → retryable, runtime dropped", async () => {
    await prepared();
    runtime.send.mockResolvedValueOnce(false);
    const failed = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(failed).toMatchObject({ kind: "retryable_failure", errorCode: "provider_rejected" });
    const r = await pendingUnleased();
    expect(r.activation_user_entry_index).toBeNull();
  });

  it("send threw before the entry existed: retryable", async () => {
    await prepared();
    runtime.send.mockRejectedValueOnce(new Error("stdin closed"));
    const failed = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(failed).toMatchObject({ kind: "retryable_failure", errorCode: "send_threw" });
    await pendingUnleased();
  });

  it("entry persisted, stdin write failed: activation_uncertain, runtime kept, replay returns uncertain, never re-sends", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      await opts?.onUserEntryPersisted?.(0);
      return false;
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(result.kind).toBe("uncertain");
    const r = await row();
    expect(r).toMatchObject({
      lifecycle_state: "activation_uncertain", activation_user_entry_index: 0,
      activation_error_code: "stdin_write_failed", activation_lease_owner: null,
    });
    expect(runtime.drop).not.toHaveBeenCalled();
    expect(runtime.alive.has("s1")).toBe(true);

    const replay = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(replay.kind).toBe("uncertain");
    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "y" })).kind).toBe("idempotency_conflict");
    expect((await service.activate({ sessionId: "s1", activationKey: "k2", instruction: "x" })).kind).toBe("activation_conflict");
    expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("not_pending");
  });

  it("entry persisted, then send threw: activation_uncertain with send_threw", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      await opts?.onUserEntryPersisted?.(0);
      throw new Error("EPIPE");
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(result.kind).toBe("uncertain");
    expect((await row())?.activation_error_code).toBe("send_threw");
  });

  it("concurrent activation with the same key sees 202 while the lease is live, then replays the winner", async () => {
    await prepared();
    const gate = deferred<void>();
    runtime.hydrate.mockImplementationOnce(async (id: string) => { await gate.promise; runtime.alive.add(id); });
    const first = service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    await vi.waitFor(async () => expect((await row())?.activation_lease_owner).not.toBeNull());

    const second = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(second.kind).toBe("in_progress");
    expect((second as { view: { leaseHeld: boolean } }).view.leaseHeld).toBe(true);
    expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("activation_in_progress");

    gate.resolve();
    expect((await first).kind).toBe("activated");
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" })).kind).toBe("replayed");
    expect(runtime.hydrate).toHaveBeenCalledTimes(1);
    expect(runtime.send).toHaveBeenCalledTimes(1);
  });

  it("cancel that wins after a lapsed lease makes the activation stop its runtime and answer 410", async () => {
    await prepared();
    const gate = deferred<void>();
    runtime.hydrate.mockImplementationOnce(async (id: string) => { await gate.promise; runtime.alive.add(id); });
    const activation = service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    await vi.waitFor(async () => expect((await row())?.activation_lease_owner).not.toBeNull());

    // The lease lapses (clock jumps past it) and a cancel lands.
    now += 30_001;
    expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("cancelled");
    gate.resolve();
    const result = await activation;
    expect(result.kind).toBe("expired");
    expect(runtime.drop).toHaveBeenCalledWith("s1");
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.alive.has("s1")).toBe(false);
    expect((await row())?.lifecycle_state).toBe("expired");
  });

  it("evidence CAS lost (lease lapsed, cancel won between the pre-send check and the entry): stdin is never written", async () => {
    await prepared();
    let cancelOutcome: string | undefined;
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      // The entry is durable; before the evidence line lands the lease lapses
      // and a cancel wins the row.
      now += 30_001;
      cancelOutcome = (await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind;
      await opts?.onUserEntryPersisted?.(0); // throws ActivationLeaseLostError → no stdin
      throw new Error("unreachable: stdin must not be written after a lost lease");
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(cancelOutcome).toBe("cancelled");
    expect(result.kind).toBe("expired");
    expect(runtime.drop).toHaveBeenCalledWith("s1");
    expect((await row())).toMatchObject({ lifecycle_state: "expired", activation_user_entry_index: null });
  });

  it("lease lapses while the entry is being persisted (no competitor): evidence refused, stdin never written, outcome uncertain", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      now += 30_001; // pushEntry took longer than the lease
      await opts?.onUserEntryPersisted?.(0); // throws: lease no longer valid
      throw new Error("unreachable: stdin must not be written on a lapsed lease");
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    // The transcript already holds the user entry: a clean re-claim would
    // hydrate it and deliver the same instruction twice. Uncertain, no re-send.
    expect(result.kind).toBe("uncertain");
    expect(runtime.drop).not.toHaveBeenCalled();
    expect((await row())).toMatchObject({ lifecycle_state: "activation_uncertain", activation_error_code: "lease_lost_after_entry" });
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" })).kind).toBe("uncertain");
    expect(runtime.send).toHaveBeenCalledTimes(1);
  });

  it("lease lost after the entry, and a cancel lands between the re-read and the uncertain CAS: expired wins, runtime dropped", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      now += 30_001;
      await opts?.onUserEntryPersisted?.(0); // throws: lease lapsed
      throw new Error("unreachable");
    });
    const original = storage.agentSessions.markActivationUncertain.bind(storage.agentSessions);
    vi.spyOn(storage.agentSessions, "markActivationUncertain").mockImplementationOnce(async (opts) => {
      // Evidence was never recorded, so the row is still a plain unleased
      // pending row to a concurrent cancel — it wins the race here.
      expect((await service.cancel({ sessionId: "s1", reason: "cancelled" })).kind).toBe("cancelled");
      return original(opts);
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(result.kind).toBe("expired");
    expect(runtime.drop).toHaveBeenCalledWith("s1");
    expect(runtime.alive.has("s1")).toBe(false);
    expect((await row())).toMatchObject({ lifecycle_state: "expired", expired_reason: "cancelled" });
  });

  it("lease lost after the entry, and a same-key activation completes before the uncertain CAS: replayed, not a conflict", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      now += 30_001;
      await opts?.onUserEntryPersisted?.(0); // throws: lease lapsed
      throw new Error("unreachable");
    });
    const original = storage.agentSessions.markActivationUncertain.bind(storage.agentSessions);
    vi.spyOn(storage.agentSessions, "markActivationUncertain").mockImplementationOnce(async (opts) => {
      // A retry of the SAME operation (same key, same content) claims the
      // unleased row and completes its activation first.
      expect(await storage.agentSessions.claimActivation({
        id: "s1", activationKey: "k1", contentHash: hashInstruction("x"), contentJson: '"x"',
        leaseOwner: "retry", leaseExpiresAt: now + 30_000, now,
      })).toBe(true);
      expect(await storage.agentSessions.completeActivation({ id: "s1", expectLeaseOwner: "retry", activatedAt: now, status: "running" })).toBe(true);
      return original(opts);
    });
    const result = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    // The operation succeeded — just not through this holder.
    expect(result.kind).toBe("replayed");
    expect((await row())).toMatchObject({ lifecycle_state: "active", activation_key: "k1" });
    // Different content under the same key is still an idempotency conflict.
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "y" })).kind).toBe("idempotency_conflict");
  });

  it("a row with first-turn evidence and a lapsed lease can only become uncertain: cancel, TTL and re-claim all refuse", async () => {
    await prepared();
    runtime.send.mockImplementationOnce(async (_id, _c, _p, _u, opts) => {
      await opts?.onUserEntryPersisted?.(0);
      // Holder dies here: lease still recorded, entry evidence in place.
      return new Promise<boolean>(() => {});
    });
    void service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    await vi.waitFor(async () => expect((await row())?.activation_user_entry_index).toBe(0));
    now += 30_001;

    // Another activation cannot take the row for a second first send.
    const again = await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" });
    expect(again.kind).toBe("in_progress");
    expect(runtime.send).toHaveBeenCalledTimes(1);
    // TTL sweep leaves it alone.
    now += 60 * 60_000;
    await service.maintain();
    expect((await row())?.lifecycle_state).toBe("pending_first_turn");
    // Cancel turns it into the honest outcome, not a tombstone.
    const cancelled = await service.cancel({ sessionId: "s1", reason: "cancelled" });
    expect(cancelled.kind).toBe("not_pending");
    expect((await row())).toMatchObject({ lifecycle_state: "activation_uncertain", activation_error_code: "lease_lost_after_entry" });
    expect((await service.activate({ sessionId: "s1", activationKey: "k1", instruction: "x" })).kind).toBe("uncertain");
  });

  it("recover: lease with no entry → pending; user entry only → uncertain; agent activity → active", async () => {
    for (const id of ["clean", "user-only", "ran"]) {
      await prepared(id, `op-${id}`);
      await storage.agentSessions.claimActivation({
        id, activationKey: `op-${id}`, contentHash: hashInstruction("x"), contentJson: '"x"',
        leaseOwner: "dead-process", leaseExpiresAt: now + 30_000, now,
      });
    }
    await storage.agentSessions.upsertEntry("user-only", 0, JSON.stringify({ type: "user", content: "x", timestamp: now }));
    await storage.agentSessions.setActivationUserEntryIndex({ id: "user-only", leaseOwner: "dead-process", entryIndex: 0, now });
    await storage.agentSessions.upsertEntry("ran", 0, JSON.stringify({ type: "user", content: "x", timestamp: now }));
    await storage.agentSessions.setActivationUserEntryIndex({ id: "ran", leaseOwner: "dead-process", entryIndex: 0, now });
    await storage.agentSessions.upsertEntry("ran", 1, JSON.stringify({ type: "assistant", content: "hi", timestamp: now }));

    const summary = await service.recover();
    expect(summary).toEqual({ leaseCleared: 1, promotedActive: 1, markedUncertain: 1, expiredByTtl: 0 });
    expect(await row("clean")).toMatchObject({ lifecycle_state: "pending_first_turn", activation_lease_owner: null, activation_key: "op-clean" });
    expect(await row("user-only")).toMatchObject({ lifecycle_state: "activation_uncertain", activation_error_code: "crash_during_activation" });
    expect(await row("ran")).toMatchObject({ lifecycle_state: "active", status: "stopped", activation_lease_owner: null });

    // The cleaned row is safely retryable with the same key.
    expect((await service.activate({ sessionId: "clean", activationKey: "op-clean", instruction: "x" })).kind).toBe("activated");
    // The uncertain one replays as uncertain.
    expect((await service.activate({ sessionId: "user-only", activationKey: "op-user-only", instruction: "x" })).kind).toBe("uncertain");
    // The promoted one replays as active.
    expect((await service.activate({ sessionId: "ran", activationKey: "op-ran", instruction: "x" })).kind).toBe("replayed");
    expect(runtime.send).toHaveBeenCalledTimes(1);
  });

  it("recover also TTL-expires stale unleased pending rows", async () => {
    await prepared("old", "op-old");
    now += 11 * 60_000;
    expect((await service.recover()).expiredByTtl).toBe(1);
    expect(await row("old")).toMatchObject({ lifecycle_state: "expired", expired_reason: "ttl" });
  });

  it("a live lease is never TTL-expired underneath its holder", async () => {
    await prepared("busy", "op-busy");
    await storage.agentSessions.claimActivation({
      id: "busy", activationKey: "k", contentHash: "h", contentJson: '"x"', leaseOwner: "me", leaseExpiresAt: now + 60 * 60_000, now,
    });
    now += 11 * 60_000;
    expect((await service.maintain()).expiredByTtl).toBe(0);
    expect((await row("busy"))?.lifecycle_state).toBe("pending_first_turn");
  });
});
