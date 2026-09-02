import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

/**
 * Repository half of the prepared-session lifecycle (design §6, §8.1, §11):
 * the CAS statements the service relies on, and the visibility scope every
 * ordinary projection embeds. Pure storage — no manager, no service.
 */
describe("agentSessions lifecycle repository", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;
  const now = 1_700_000_000_000;

  const pending = (id: string, operationId = `op-${id}`) => storage.agentSessions.createPending({
    id, project_id: "p1", branch: "dev", target_id: "local", permission_mode: "edit", agent_type: "claude-code",
    model: null, purpose: "interactive", owner_kind: null, owner_id: null,
    prepare_operation_id: operationId, pending_expires_at: now + 60_000,
  });
  const row = (id: string) => storage.agentSessions.getLifecycleById(id);
  const claim = (id: string, leaseOwner: string, leaseExpiresAt = now + 30_000, activationKey = "k") =>
    storage.agentSessions.claimActivation({
      id, activationKey, contentHash: "h", contentJson: '"x"', leaseOwner, leaseExpiresAt, now,
    });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-lifecycle-repo-"));
    dbPath = path.join(dir, "db.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local", worktreePath: "/tmp/p-dev", expectedBranch: "dev",
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("legacy rows read as active; createPending writes an invisible stopped identity", async () => {
    await storage.agentSessions.create({ id: "legacy", project_id: "p1", branch: "dev" });
    expect((await storage.agentSessions.getById("legacy"))?.lifecycle_state).toBe("active");

    const { session, checkout } = await pending("s1");
    expect(session).toMatchObject({ id: "s1", status: "stopped", lifecycle_state: "pending_first_turn", purpose: "interactive" });
    expect(checkout.worktree_path).toBe("/tmp/p-dev");
    expect(await row("s1")).toMatchObject({ prepare_operation_id: "op-s1", pending_expires_at: now + 60_000, activation_attempt: 0 });
    expect((await storage.agentSessions.getLifecycleByPrepareOperationId("op-s1"))?.id).toBe("s1");
  });

  it("prepare_operation_id is unique", async () => {
    await pending("s1", "op-shared");
    await expect(pending("s2", "op-shared")).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await row("s2")).toBeUndefined();
  });

  it("every projection hides pending and expired rows and shows active/uncertain ones", async () => {
    await storage.agentSessions.create({ id: "active", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus("active", "stopped");
    await pending("pending");
    await pending("tomb");
    await storage.agentSessions.expirePending({ id: "tomb", reason: "cancelled", now });
    await pending("unsure");
    await claim("unsure", "o");
    await storage.agentSessions.markActivationUncertain({ id: "unsure", expectLeaseOwner: "o", errorCode: "stdin_write_failed" });

    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE agent_sessions SET activity_at = ?").run(now - 1_000_000);
    } finally { raw.close(); }

    const visible = new Set(["active", "unsure"]);
    const check = (name: string, ids: string[]) => {
      expect(ids.filter((id) => visible.has(id)).sort(), name).toEqual([...visible].sort());
      expect(ids, name).not.toContain("pending");
      expect(ids, name).not.toContain("tomb");
    };
    check("getAll", (await storage.agentSessions.getAll()).map((s) => s.id));
    check("getByProjectId", (await storage.agentSessions.getByProjectId("p1")).map((s) => s.id));
    check("getProjectedByProjectId", (await storage.agentSessions.getProjectedByProjectId("p1")).map((s) => s.id));
    check("listByProject", (await storage.agentSessions.listByProject("p1", 10)).map((s) => s.id));
    check("listRecentByProject", (await storage.agentSessions.listRecentByProject("p1", 10)).map((s) => s.id));
    check("listRecentActivityByProject", (await storage.agentSessions.listRecentActivityByProject("p1", 10)).map((s) => s.id));
    check("listByBranch", (await storage.agentSessions.listByBranch("p1", "dev")).map((s) => s.id));
    check("listIdsByProject", await storage.agentSessions.listIdsByProject("p1"));
    check("listRetentionCandidates", (await storage.agentSessions.listRetentionCandidates({ cutoff: now, limit: 10 })).map((s) => s.id));
    expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).not.toBe("pending");
    // Exact-id reads are unscoped by design.
    expect((await storage.agentSessions.getById("pending"))?.lifecycle_state).toBe("pending_first_turn");
    expect((await storage.agentSessions.getActivityById("tomb"))?.id).toBe("tomb");
    // Neither retention nor the legacy empty-discard can remove non-active rows.
    expect(await storage.agentSessions.deleteIfExpired("pending", now)).toBe(false);
    expect(await storage.agentSessions.deleteIfEmpty("pending")).toBe(false);
    expect(await storage.agentSessions.deleteIfEmpty("tomb")).toBe(false);
  });

  it("claim is a single-winner CAS; the lease gates re-claim; the key sticks", async () => {
    await pending("s1");
    expect(await claim("s1", "a")).toBe(true);
    expect(await claim("s1", "b")).toBe(false);                       // live lease
    expect(await row("s1")).toMatchObject({ activation_lease_owner: "a", activation_attempt: 1, activation_key: "k" });
    expect(await storage.agentSessions.claimActivation({
      id: "s1", activationKey: "other", contentHash: "h", contentJson: '"x"', leaseOwner: "c", leaseExpiresAt: now + 1, now: now + 40_000,
    })).toBe(false);                                                   // different key never claims
    expect(await storage.agentSessions.claimActivation({
      id: "s1", activationKey: "k", contentHash: "h", contentJson: '"x"', leaseOwner: "c", leaseExpiresAt: now + 60_000, now: now + 40_000,
    })).toBe(true);                                                    // lapsed lease, same key
    expect(await row("s1")).toMatchObject({ activation_lease_owner: "c", activation_attempt: 2 });
  });

  it("renew / release / user-entry-index respect the lease owner", async () => {
    await pending("s1");
    await claim("s1", "a");
    expect(await storage.agentSessions.renewActivationLease({ id: "s1", leaseOwner: "b", leaseExpiresAt: now + 1 })).toBe(false);
    expect(await storage.agentSessions.renewActivationLease({ id: "s1", leaseOwner: "a", leaseExpiresAt: now + 99 })).toBe(true);
    expect((await row("s1"))?.activation_lease_expires_at).toBe(now + 99);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "b", entryIndex: 0, now })).toBe(false);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "a", entryIndex: 3, now })).toBe(true);
    expect(await storage.agentSessions.releaseActivationLease({ id: "s1", expectLeaseOwner: "b", errorCode: "x" })).toBe(false);
    expect(await storage.agentSessions.releaseActivationLease({ id: "s1", expectLeaseOwner: "a", errorCode: "resident_limit_reached" })).toBe(true);
    expect(await row("s1")).toMatchObject({
      lifecycle_state: "pending_first_turn", activation_lease_owner: null, activation_lease_expires_at: null,
      activation_error_code: "resident_limit_reached", activation_key: "k", activation_user_entry_index: 3,
    });
    // s1 now carries evidence, so it can never be claimed again (§8.3).
    expect(await claim("s1", "dead")).toBe(false);
    // Recovery form: no owner check (on a clean row).
    await pending("s1r", "op-s1r");
    await claim("s1r", "dead");
    expect(await storage.agentSessions.releaseActivationLease({ id: "s1r", errorCode: null })).toBe(true);
  });

  it("completeActivation and markActivationUncertain are terminal for the pending state", async () => {
    await pending("s1");
    await claim("s1", "a");
    expect(await storage.agentSessions.completeActivation({ id: "s1", expectLeaseOwner: "b", activatedAt: now, status: "running" })).toBe(false);
    expect(await storage.agentSessions.completeActivation({ id: "s1", expectLeaseOwner: "a", activatedAt: now, status: "running" })).toBe(true);
    expect(await row("s1")).toMatchObject({ lifecycle_state: "active", status: "running", activated_at: now, activation_lease_owner: null });
    expect(await storage.agentSessions.markActivationUncertain({ id: "s1", errorCode: "x" })).toBe(false);
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now })).toBe("not_pending");

    await pending("s2");
    await claim("s2", "a");
    expect(await storage.agentSessions.markActivationUncertain({ id: "s2", expectLeaseOwner: "a", errorCode: "stdin_write_failed" })).toBe(true);
    expect(await row("s2")).toMatchObject({ lifecycle_state: "activation_uncertain", activation_error_code: "stdin_write_failed" });
    expect(await storage.agentSessions.completeActivation({ id: "s2", activatedAt: now, status: "running" })).toBe(false);
  });

  it("expirePending names why it did not apply", async () => {
    expect(await storage.agentSessions.expirePending({ id: "nope", reason: "cancelled", now })).toBe("not_found");
    await pending("s1");
    await claim("s1", "a");
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now })).toBe("lease_held");
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now: now + 30_001 })).toBe("expired");
    expect(await row("s1")).toMatchObject({ lifecycle_state: "expired", expired_reason: "cancelled", expired_at: now + 30_001, activation_lease_owner: null });
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now })).toBe("already_expired");
  });

  it("TTL expiry, tombstone GC and payload clearing are bounded and lease-aware", async () => {
    await pending("stale");
    await pending("fresh");
    await pending("leased");
    await claim("leased", "a", now + 10 * 60_000);
    // `fresh` gets a later deadline.
    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE agent_sessions SET pending_expires_at = ? WHERE id = 'fresh'").run(now + 120_000);
    } finally { raw.close(); }

    expect(await storage.agentSessions.expirePendingOlderThan({ now: now + 61_000, limit: 10 })).toBe(1);
    expect((await row("stale"))?.lifecycle_state).toBe("expired");
    expect((await row("fresh"))?.lifecycle_state).toBe("pending_first_turn");
    expect((await row("leased"))?.lifecycle_state).toBe("pending_first_turn");

    expect(await storage.agentSessions.deleteExpiredTombstones({ cutoff: now + 61_000, limit: 10 })).toBe(0);
    expect(await storage.agentSessions.deleteExpiredTombstones({ cutoff: now + 61_001, limit: 10 })).toBe(1);
    expect(await row("stale")).toBeUndefined();

    await pending("done");
    await claim("done", "a");
    await storage.agentSessions.completeActivation({ id: "done", expectLeaseOwner: "a", activatedAt: now, status: "running" });
    expect(await storage.agentSessions.clearActivationPayloads({ cutoff: now, limit: 10 })).toBe(0);
    expect(await storage.agentSessions.clearActivationPayloads({ cutoff: now + 1, limit: 10 })).toBe(1);
    expect(await row("done")).toMatchObject({ activation_content_json: null, activation_content_hash: "h" });
  });

  it("the FK rebuild preserves lifecycle columns and their data", async () => {
    // A database that predates the workspace_checkout foreign key but already
    // carries lifecycle columns must come through the rebuild intact.
    await pending("keep");
    await storage.agentSessions.expirePending({ id: "keep", reason: "cancelled", now });
    await storage.close();
    const raw = new Database(dbPath);
    try {
      raw.pragma("foreign_keys = OFF");
      const indexes = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_sessions' AND sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql);
      const columns = (raw.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[]).map((c) => c.name).join(", ");
      // Recreate the table WITHOUT the checkout FK (the pre-Phase-7 shape).
      raw.exec(`
        CREATE TABLE agent_sessions_old AS SELECT * FROM agent_sessions;
        DROP TABLE agent_sessions;
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
          workspace_checkout_id TEXT DEFAULT NULL, status TEXT NOT NULL DEFAULT 'running',
          permission_mode TEXT DEFAULT 'edit', agent_type TEXT DEFAULT 'claude-code', title TEXT DEFAULT NULL,
          model TEXT DEFAULT NULL, created_at TEXT, updated_at TEXT, activity_at INTEGER,
          last_user_message_at INTEGER, last_completed_at INTEGER, favorited_at INTEGER, native_session_id TEXT,
          history_epoch INTEGER NOT NULL DEFAULT 0, branched_from_session_id TEXT, branched_from_entry_index INTEGER,
          lifecycle_state TEXT NOT NULL DEFAULT 'active', purpose TEXT NOT NULL DEFAULT 'interactive',
          owner_kind TEXT, owner_id TEXT, prepare_operation_id TEXT, pending_expires_at INTEGER, activated_at INTEGER,
          expired_reason TEXT, expired_at INTEGER, activation_key TEXT, activation_content_hash TEXT,
          activation_content_json TEXT, activation_lease_owner TEXT, activation_lease_expires_at INTEGER,
          activation_attempt INTEGER NOT NULL DEFAULT 0, activation_user_entry_index INTEGER, activation_error_code TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        INSERT INTO agent_sessions (${columns}) SELECT ${columns} FROM agent_sessions_old;
        DROP TABLE agent_sessions_old;
      `);
      for (const sql of indexes) raw.exec(sql);
    } finally { raw.close(); }

    storage = await createSqliteStorage(dbPath);
    expect(await row("keep")).toMatchObject({ lifecycle_state: "expired", expired_reason: "cancelled", prepare_operation_id: "op-keep" });
    const rebuilt = new Database(dbPath);
    try {
      const ddl = (rebuilt.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get() as { sql: string }).sql;
      expect(ddl).toMatch(/REFERENCES workspace_checkouts/);
      const idx = (rebuilt.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_sessions'").all() as { name: string }[]).map((r) => r.name);
      expect(idx).toContain("idx_agent_sessions_prepare_operation");
    } finally { rebuilt.close(); }
  });

  it("expirePending never tombstones a row with first-turn evidence: it becomes activation_uncertain", async () => {
    await pending("s1");
    expect(await claim("s1", "owner-a")).toBe(true);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "owner-a", entryIndex: 0, now })).toBe(true);
    // Live lease: held.
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now })).toBe("lease_held");
    // Lapsed lease + evidence: uncertain, not expired; re-claim refused.
    const later = now + 60_000;
    expect(await storage.agentSessions.claimActivation({
      id: "s1", activationKey: "k", contentHash: "h", contentJson: '"x"', leaseOwner: "owner-b", leaseExpiresAt: later + 30_000, now: later,
    })).toBe(false);
    expect(await storage.agentSessions.expirePendingOlderThan({ now: later + 10 * 60_000, limit: 10 })).toBe(0);
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now: later })).toBe("uncertain");
    expect(await row("s1")).toMatchObject({ lifecycle_state: "activation_uncertain", activation_error_code: "lease_lost_after_entry", activation_lease_owner: null });
    expect(await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now: later })).toBe("not_pending");
  });

  it("the evidence CAS fails once its own lease has lapsed, even with no competitor", async () => {
    await pending("s1");
    expect(await claim("s1", "owner-a", now + 1)).toBe(true);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "owner-a", entryIndex: 0, now: now + 1 })).toBe(false);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "owner-a", entryIndex: 0, now })).toBe(true);
  });

  it("the TTL sweep's final UPDATE re-checks evidence written after its SELECT", async () => {
    await pending("s1");
    await storage.agentSessions.expirePending({ id: "s1", reason: "cancelled", now }); // sanity: cancel works on a clean row
    await pending("s2", "op-s2");
    expect(await claim("s2", "owner-a", now + 30_000)).toBe(true);
    // Evidence lands with a live lease; the lease then lapses past the TTL.
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s2", leaseOwner: "owner-a", entryIndex: 0, now })).toBe(true);
    const later = now + 24 * 60 * 60_000;
    expect(await storage.agentSessions.expirePendingOlderThan({ now: later, limit: 10 })).toBe(0);
    expect((await row("s2"))?.lifecycle_state).toBe("pending_first_turn");
  });

  it("the evidence CAS fails once the lease belongs to someone else", async () => {
    await pending("s1");
    expect(await claim("s1", "owner-a", now + 1)).toBe(true);
    // Lease lapsed; owner-b claims.
    expect(await storage.agentSessions.claimActivation({
      id: "s1", activationKey: "k", contentHash: "h", contentJson: '"x"', leaseOwner: "owner-b", leaseExpiresAt: now + 30_000, now: now + 2,
    })).toBe(true);
    expect(await storage.agentSessions.setActivationUserEntryIndex({ id: "s1", leaseOwner: "owner-a", entryIndex: 0, now })).toBe(false);
    expect((await row("s1"))?.activation_user_entry_index).toBeNull();
  });
});
