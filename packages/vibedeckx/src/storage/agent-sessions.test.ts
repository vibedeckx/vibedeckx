import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";
import { getWorkspaceBindingReadMetrics, resetWorkspaceBindingReadMetrics } from "../workspace-binding-metrics.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("agentSessions/remoteSessionMappings storage", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-as-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("agentSessions.create", () => {
    it("applies defaults: status running, permission_mode edit, agent_type claude-code, title null, no activity timestamps", async () => {
      const s = await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      expect(s.id).toBe("s1");
      expect(s.project_id).toBe("p1");
      expect(s.branch).toBe("dev");
      expect(s.status).toBe("running");
      expect(s.permission_mode).toBe("edit");
      expect(s.agent_type).toBe("claude-code");
      expect(s.title ?? null).toBeNull();
      expect(s.last_user_message_at ?? null).toBeNull();
      expect(s.last_completed_at ?? null).toBeNull();
      expect(s.favorited_at ?? null).toBeNull();
      expect(s.created_at).toBeTruthy();
      expect(s.updated_at).toBeTruthy();
    });

    it("honors explicit permission_mode/agent_type", async () => {
      const s = await storage.agentSessions.create({
        id: "s1", project_id: "p1", branch: "dev", permission_mode: "plan", agent_type: "codex",
      });
      expect(s.permission_mode).toBe("plan");
      expect(s.agent_type).toBe("codex");
    });
  });

  describe("agentSessions.createBound", () => {
    it("persists the exact ready checkout incarnation", async () => {
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "dev", targetId: "local",
        worktreePath: "/tmp/p-dev", expectedBranch: "dev",
      });
      const result = await storage.agentSessions.createBound({
        id: "bound", project_id: "p1", branch: "dev", target_id: "local",
      });

      expect(result.checkout.id).toBe(registered.checkout.id);
      expect(result.session.workspace_checkout_id).toBe(registered.checkout.id);
      expect((await storage.agentSessions.getById("bound"))?.workspace_checkout_id)
        .toBe(registered.checkout.id);
    });

    it("rejects a tombstoned checkout without inserting a session", async () => {
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "gone", targetId: "local",
        worktreePath: "/tmp/p-gone", expectedBranch: "gone",
      });
      await storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);

      await expect(storage.agentSessions.createBound({
        id: "rejected", project_id: "p1", branch: "gone", target_id: "local",
        checkout_id: registered.checkout.id,
      })).rejects.toThrow("not available");
      expect(await storage.agentSessions.getById("rejected")).toBeUndefined();
    });

    it("projects bound activity from the exact checkout, including its tombstone history", async () => {
      await storage.projects.create({ id: "snapshot-project", name: "snapshot", path: "/tmp/snapshot" });
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "historical", targetId: "local",
        worktreePath: "/tmp/p-historical", expectedBranch: "historical",
      });
      await storage.agentSessions.createBound({
        id: "bound-history", project_id: "p1", branch: "historical", target_id: "local",
        checkout_id: registered.checkout.id,
      });
      const raw = new Database(dbPath);
      try {
        // Simulate stale compatibility snapshots. Projection ownership must
        // remain attached to the immutable checkout incarnation.
        raw.prepare("UPDATE agent_sessions SET project_id = ?, branch = ? WHERE id = ?")
          .run("snapshot-project", "wrong-branch", "bound-history");
      } finally {
        raw.close();
      }
      await storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);

      expect(await storage.agentSessions.listRecentActivityByProject("snapshot-project", 10))
        .toEqual([]);
      expect(await storage.agentSessions.getProjectedByProjectId("snapshot-project")).toEqual([]);
      expect(await storage.agentSessions.getProjectedByProjectId("p1")).toEqual([
        expect.objectContaining({
          id: "bound-history", project_id: "p1", branch: "historical",
          workspace_checkout_id: registered.checkout.id,
        }),
      ]);
      expect(await storage.agentSessions.listRecentActivityByProject("p1", 10))
        .toEqual([expect.objectContaining({
          id: "bound-history",
          projectId: "p1",
          branch: "historical",
          target: "local",
          worktreePath: "/tmp/p-historical",
          checkoutDeletedAt: expect.any(String),
          binding: "checkout",
        })]);
    });

    it("falls back only for genuinely unbound legacy activity and omits dangling bindings", async () => {
      resetWorkspaceBindingReadMetrics();
      await storage.agentSessions.create({ id: "legacy", project_id: "p1", branch: "legacy" });
      await storage.agentSessions.create({ id: "dangling", project_id: "p1", branch: "dangling" });
      const raw = new Database(dbPath);
      try {
        // The foreign key makes this unreachable through the app, but not
        // impossible: a restored backup, or a database that refused to tighten,
        // still carries dangling bindings. The read path must survive them.
        raw.pragma("foreign_keys = OFF");
        raw.prepare("UPDATE agent_sessions SET workspace_checkout_id = ? WHERE id = ?")
          .run("missing-checkout", "dangling");
      } finally {
        raw.close();
      }

      const rows = await storage.agentSessions.listRecentActivityByProject("p1", 10, "project-activity");
      expect(rows).toEqual([expect.objectContaining({
        id: "legacy", branch: "legacy", target: "local",
        worktreePath: null, checkoutDeletedAt: null, binding: "legacy",
      })]);
      expect(await storage.agentSessions.countRunningActivityByProject("p1")).toBe(1);
      expect(getWorkspaceBindingReadMetrics()).toEqual(expect.arrayContaining([
        { consumer: "project-activity", outcome: "legacy-fallback", count: 1 },
        { consumer: "project-activity", outcome: "dangling", count: 1 },
      ]));
    });

    it("records snapshot mismatches separately from clean checkout hits", async () => {
      resetWorkspaceBindingReadMetrics();
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "dev", targetId: "local",
        worktreePath: "/tmp/p-dev", expectedBranch: "dev",
      });
      await storage.agentSessions.createBound({
        id: "clean", project_id: "p1", branch: "dev", target_id: "local",
        checkout_id: registered.checkout.id,
      });
      await storage.agentSessions.createBound({
        id: "mismatch", project_id: "p1", branch: "dev", target_id: "local",
        checkout_id: registered.checkout.id,
      });
      const raw = new Database(dbPath);
      try {
        raw.prepare("UPDATE agent_sessions SET branch = ? WHERE id = ?").run("stale", "mismatch");
      } finally {
        raw.close();
      }

      await storage.agentSessions.getProjectedByProjectId("p1", "search");
      expect(getWorkspaceBindingReadMetrics()).toEqual(expect.arrayContaining([
        { consumer: "search", outcome: "checkout-hit", count: 1 },
        { consumer: "search", outcome: "mismatch", count: 1 },
      ]));
    });
  });

  describe("workspace checkout binding backfill", () => {
    it("normalizes remote main NULL to the empty workspace branch and is idempotent", async () => {
      const checkout = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "", targetId: "remote-a",
        worktreePath: "/remote/p", expectedBranch: "main",
      });
      await storage.remoteSessionMappings.upsert("remote-main", "p1", "remote-a", "worker-main", null);

      const dryRun = await storage.workspaceBindingMigration.backfill({ kind: "remote", dryRun: true });
      expect(dryRun).toMatchObject({ scanned: 1, updated: 0 });
      const applied = await storage.workspaceBindingMigration.backfill({ kind: "remote", dryRun: false });
      expect(applied.updated).toBe(1);
      expect((await storage.remoteSessionMappings.getByLocal("remote-main"))?.workspace_checkout_id)
        .toBe(checkout.checkout.id);
      expect((await storage.workspaceBindingMigration.backfill({ kind: "remote", dryRun: false })).updated)
        .toBe(0);
    });

    it("leaves an ambiguous historical incarnation unbound", async () => {
      const oldCheckout = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "rebuilt", targetId: "local",
        worktreePath: "/tmp/old", expectedBranch: "rebuilt",
      });
      await storage.workspaceRegistry.markCheckoutDeleted(oldCheckout.checkout.id);
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "rebuilt", targetId: "local",
        worktreePath: "/tmp/new", expectedBranch: "rebuilt",
      });
      await storage.agentSessions.create({ id: "legacy-ambiguous", project_id: "p1", branch: "rebuilt" });

      const result = await storage.workspaceBindingMigration.backfill({ kind: "local", dryRun: false });
      expect(result.reasons.multiple_incarnations).toBe(1);
      expect((await storage.agentSessions.getById("legacy-ambiguous"))?.workspace_checkout_id).toBeNull();
    });

    it("classifies a mixed legacy database and keeps unresolved results stable on rerun", async () => {
      const localMain = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "", targetId: "local",
        worktreePath: "/tmp/p", expectedBranch: "main",
      });
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "local-branch", targetId: "local",
        worktreePath: "/tmp/local-branch", expectedBranch: "local-branch",
      });
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "", targetId: "remote-a",
        worktreePath: "/remote/a/p", expectedBranch: "main", pathSource: "reported",
      });
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "shared", targetId: "remote-a",
        worktreePath: "/remote/a/shared", expectedBranch: "shared", pathSource: "reported",
      });
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "shared", targetId: "remote-b",
        worktreePath: "/remote/b/shared", expectedBranch: "shared", pathSource: "reported",
      });
      const old = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "rebuilt", targetId: "local",
        worktreePath: "/tmp/rebuilt-old", expectedBranch: "rebuilt",
      });
      await storage.workspaceRegistry.markCheckoutDeleted(old.checkout.id);
      await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "rebuilt", targetId: "local",
        worktreePath: "/tmp/rebuilt-new", expectedBranch: "rebuilt",
      });
      await storage.projects.create({ id: "p2", name: "p2", path: "/tmp/p2" });

      const raw = new Database(dbPath);
      raw.prepare("INSERT INTO workspaces (id, project_id, branch, status, error) VALUES (?, ?, ?, 'archived', NULL)")
        .run("empty-workspace", "p1", "empty");
      raw.close();

      await storage.agentSessions.create({ id: "local-main", project_id: "p1", branch: "" });
      await storage.agentSessions.create({ id: "local-ok", project_id: "p1", branch: "local-branch" });
      await storage.agentSessions.create({ id: "local-workspace-missing", project_id: "p1", branch: "unknown" });
      await storage.agentSessions.create({ id: "local-checkout-missing", project_id: "p1", branch: "empty" });
      await storage.agentSessions.create({ id: "local-ambiguous", project_id: "p1", branch: "rebuilt" });
      await storage.remoteSessionMappings.upsert("remote-main", "p1", "remote-a", "wm", null);
      await storage.remoteSessionMappings.upsert("remote-a", "p1", "remote-a", "wa", "shared");
      await storage.remoteSessionMappings.upsert("remote-b", "p1", "remote-b", "wb", "shared");
      await storage.remoteSessionMappings.upsert("remote-target-missing", "p1", "remote-c", "wc", "shared");
      await storage.remoteSessionMappings.upsert("remote-main-missing", "p2", "remote-a", "wmm", null);
      await storage.remoteSessionMappings.upsert("remote-project-missing", "missing-project", "remote-a", "wpm", "dev");

      const localFirst = await storage.workspaceBindingMigration.backfill({ kind: "local", dryRun: false });
      const remoteFirst = await storage.workspaceBindingMigration.backfill({ kind: "remote", dryRun: false });
      expect(localFirst.updated).toBe(2);
      expect(remoteFirst.updated).toBe(3);
      expect(localFirst.reasons).toMatchObject({
        workspace_missing: 1, checkout_missing: 1, multiple_incarnations: 1,
      });
      expect(remoteFirst.reasons).toMatchObject({
        target_missing: 1, main_not_registered: 1, project_missing: 1,
      });
      expect((await storage.agentSessions.getById("local-main"))?.workspace_checkout_id)
        .toBe(localMain.checkout.id);

      const localSecond = await storage.workspaceBindingMigration.backfill({ kind: "local", dryRun: false });
      const remoteSecond = await storage.workspaceBindingMigration.backfill({ kind: "remote", dryRun: false });
      expect(localSecond.updated).toBe(0);
      expect(remoteSecond.updated).toBe(0);
      expect(localSecond.reasons).toEqual(localFirst.reasons);
      expect(remoteSecond.reasons).toEqual(remoteFirst.reasons);

      const diagnosis = await storage.workspaceBindingMigration.diagnose();
      expect(diagnosis.reasons).toMatchObject({
        project_missing: 1,
        workspace_missing: 1,
        checkout_missing: 1,
        main_not_registered: 1,
        target_missing: 1,
        multiple_incarnations: 1,
      });
      expect(diagnosis.issues).toEqual(expect.arrayContaining([
        { kind: "local", id: "local-workspace-missing", reason: "workspace_missing" },
        { kind: "remote", id: "remote-project-missing", reason: "project_missing" },
      ]));
    });

    it("reports dangling bindings and snapshot mismatches with concrete session ids", async () => {
      const checkout = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "dev", targetId: "local",
        worktreePath: "/tmp/dev", expectedBranch: "dev",
      });
      await storage.agentSessions.create({ id: "dangling", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "mismatch", project_id: "p1", branch: "other" });
      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = OFF"); // simulate a restored/corrupt database
      raw.prepare("UPDATE agent_sessions SET workspace_checkout_id = ? WHERE id = 'dangling'").run("missing-checkout");
      raw.prepare("UPDATE agent_sessions SET workspace_checkout_id = ? WHERE id = 'mismatch'").run(checkout.checkout.id);
      raw.close();

      const diagnosis = await storage.workspaceBindingMigration.diagnose();
      expect(diagnosis.reasons.dangling_checkout).toBe(1);
      expect(diagnosis.reasons.snapshot_mismatch).toBe(1);
      expect(diagnosis.issues).toEqual(expect.arrayContaining([
        { kind: "local", id: "dangling", reason: "dangling_checkout" },
        { kind: "local", id: "mismatch", reason: "snapshot_mismatch" },
      ]));
    });
  });

  describe("remote session creation intents", () => {
    const intent = {
      localSessionId: "local-intent",
      remoteSessionId: "worker-intent",
      projectId: "p1",
      remoteServerId: "remote-a",
      branch: null,
      remotePath: "/remote/p",
      permissionMode: "edit" as const,
      agentType: "claude-code",
      model: null,
      force: false,
      userId: "user-1",
    };

    it("persists pending before confirmation and supports idempotent replay", async () => {
      const first = await storage.remoteSessionCreationIntents.begin(intent);
      const replay = await storage.remoteSessionCreationIntents.begin(intent);
      expect(first).toMatchObject({ status: "pending", error: null });
      expect(first).toMatchObject({
        operation_kind: "new", source_remote_session_id: null, up_to_entry_index: null,
      });
      expect(replay.local_session_id).toBe(first.local_session_id);

      await storage.remoteSessionCreationIntents.recordError(intent.localSessionId, "transport lost");
      expect(await storage.remoteSessionCreationIntents.listPending("remote-a"))
        .toEqual([expect.objectContaining({ local_session_id: intent.localSessionId, error: "transport lost" })]);

      await storage.remoteSessionCreationIntents.confirm(intent.localSessionId);
      expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
    });

    it("removes terminal worker rejection from the pending recovery set", async () => {
      await storage.remoteSessionCreationIntents.begin(intent);
      await storage.remoteSessionCreationIntents.discard(intent.localSessionId);
      expect(await storage.remoteSessionCreationIntents.listPending()).toEqual([]);
    });

    it("rejects reuse of a durable local id with conflicting identity", async () => {
      await storage.remoteSessionCreationIntents.begin(intent);
      await expect(storage.remoteSessionCreationIntents.begin({
        ...intent,
        remoteSessionId: "different-worker-id",
      })).rejects.toThrow("conflicting identity");
    });
  });

  describe("remote reviewer creation intents", () => {
    const intent = {
      localReviewerSessionId: "local-reviewer",
      remoteReviewerSessionId: "worker-reviewer",
      remoteRunId: "worker-run",
      projectId: "p1",
      remoteServerId: "remote-a",
      branch: "dev",
      remotePath: "/remote/p",
      sourceRemoteSessionId: "worker-source",
      reviewFocus: "tests",
      sourceTurnEndIndex: 4,
      reviewSpan: "this_turn" as const,
      agentType: "codex",
      intentBrief: "brief",
      userId: "user-1",
    };

    it("persists the complete replay identity and confirms idempotently", async () => {
      const first = await storage.remoteReviewerCreationIntents.begin(intent);
      const replay = await storage.remoteReviewerCreationIntents.begin(intent);
      expect(first).toMatchObject({
        local_reviewer_session_id: "local-reviewer",
        remote_reviewer_session_id: "worker-reviewer",
        remote_run_id: "worker-run",
        source_remote_session_id: "worker-source",
        source_turn_end_index: 4,
        status: "pending",
      });
      expect(replay).toEqual(first);

      await storage.remoteReviewerCreationIntents.recordError("local-reviewer", "response lost");
      expect(await storage.remoteReviewerCreationIntents.listPending("remote-a"))
        .toEqual([expect.objectContaining({ error: "response lost" })]);
      await storage.remoteReviewerCreationIntents.confirm("local-reviewer");
      expect(await storage.remoteReviewerCreationIntents.listPending()).toEqual([]);
    });

    it("rejects conflicting replay payloads", async () => {
      await storage.remoteReviewerCreationIntents.begin(intent);
      await expect(storage.remoteReviewerCreationIntents.begin({
        ...intent, sourceTurnEndIndex: 8,
      })).rejects.toThrow("conflicting identity");
    });
  });

  it("keeps the same project/branch isolated across remote targets", async () => {
    const a = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "shared", targetId: "remote-a",
      worktreePath: "/a/shared", expectedBranch: "shared", pathSource: "reported",
    });
    const b = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "shared", targetId: "remote-b",
      worktreePath: "/b/shared", expectedBranch: "shared", pathSource: "reported",
    });
    await storage.remoteSessionMappings.upsertBound({
      localSessionId: "session-a", projectId: "p1", remoteServerId: "remote-a",
      remoteSessionId: "worker-a", branch: "shared", checkoutId: a.checkout.id,
    });
    await storage.remoteSessionMappings.upsertBound({
      localSessionId: "session-b", projectId: "p1", remoteServerId: "remote-b",
      remoteSessionId: "worker-b", branch: "shared", checkoutId: b.checkout.id,
    });

    expect(a.checkout.id).not.toBe(b.checkout.id);
    expect((await storage.remoteSessionMappings.getByLocal("session-a"))?.workspace_checkout_id)
      .toBe(a.checkout.id);
    expect((await storage.remoteSessionMappings.getByLocal("session-b"))?.workspace_checkout_id)
      .toBe(b.checkout.id);
  });

  describe("agentSessions reads", () => {
    it("persists semantic activity and uses its project index for bounded recents", async () => {
      await storage.agentSessions.create({ id: "activity-a", project_id: "p1", branch: "a" });
      await storage.agentSessions.create({ id: "activity-z", project_id: "p1", branch: "z" });
      const futureActivity = Date.now() + 60_000;
      await storage.agentSessions.markUserMessage("activity-a", futureActivity);
      await storage.agentSessions.markCompleted("activity-a", futureActivity - 1_000);

      const raw = new Database(path.join(dir, "test.sqlite"));
      try {
        const rows = raw.prepare(
          "SELECT id, activity_at FROM agent_sessions WHERE id IN ('activity-a', 'activity-z') ORDER BY id",
        ).all() as Array<{ id: string; activity_at: number }>;
        expect(rows[0]).toEqual({ id: "activity-a", activity_at: futureActivity });
        expect(rows[1].activity_at).toBeGreaterThan(0);

        raw.exec("ANALYZE");
        const indexes = new Set((raw.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index'",
        ).all() as Array<{ name: string }>).map((row) => row.name));
        expect(indexes.has("idx_agent_sessions_project_activity_id")).toBe(true);
        const plan = (raw.prepare(`
          EXPLAIN QUERY PLAN
          SELECT * FROM agent_sessions
          WHERE project_id = ?
          ORDER BY activity_at DESC, id DESC
          LIMIT ?
        `).all("p1", 8) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
        expect(plan).toContain("idx_agent_sessions_project_activity_id");
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      } finally {
        raw.close();
      }

      expect((await storage.agentSessions.listRecentByProject("p1", 2)).map((row) => row.id))
        .toEqual(["activity-a", "activity-z"]);
    });

    it("backfills activity_at from the semantic maximum when upgrading a legacy database", async () => {
      await storage.agentSessions.create({ id: "legacy-activity", project_id: "p1", branch: "legacy" });
      await storage.close();
      const dbPath = path.join(dir, "test.sqlite");
      const legacy = new Database(dbPath);
      try {
        legacy.prepare(`UPDATE agent_sessions
          SET created_at = ?, updated_at = ?, last_user_message_at = ?, last_completed_at = ?
          WHERE id = ?`).run(
          "2026-01-01 00:00:00", "2026-01-02 00:00:00", 2_000, 3_000, "legacy-activity",
        );
        legacy.exec("DROP INDEX idx_agent_sessions_project_activity_id");
        legacy.exec("ALTER TABLE agent_sessions DROP COLUMN activity_at");
      } finally {
        legacy.close();
      }

      storage = await createSqliteStorage(dbPath);
      const check = new Database(dbPath, { readonly: true });
      try {
        const row = check.prepare("SELECT activity_at FROM agent_sessions WHERE id = ?")
          .get("legacy-activity") as { activity_at: number };
        expect(row.activity_at).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
      } finally {
        check.close();
      }
    });

    it("getById returns undefined for a nonexistent id", async () => {
      expect(await storage.agentSessions.getById("nonexistent")).toBeUndefined();
    });

    it("getAll returns all sessions across projects/branches, ordered by updated_at desc", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await wait(5);
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "main" });
      const all = await storage.agentSessions.getAll();
      expect(all.map((s) => s.id)).toEqual(["s2", "s1"]);
    });

    it("getByProjectId scopes to the project, ordered by updated_at desc", async () => {
      await storage.projects.create({ id: "p2", name: "p2", path: "/tmp/p2" });
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await wait(5);
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "main" });
      await storage.agentSessions.create({ id: "s3", project_id: "p2", branch: "dev" });

      const list = await storage.agentSessions.getByProjectId("p1");
      expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
    });

    it("getByBranch (deprecated) returns the most recently updated session for (project, branch)", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await wait(5);
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      expect((await storage.agentSessions.getByBranch("p1", "dev"))?.id).toBe("s2");
      expect(await storage.agentSessions.getByBranch("p1", "does-not-exist")).toBeUndefined();
    });

    it("listByBranch returns every session for (project, branch), newest first", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await wait(5);
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s3", project_id: "p1", branch: "main" });

      const list = await storage.agentSessions.listByBranch("p1", "dev");
      expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
    });

    it("listByBranch scopes bound sessions through checkout ownership and omits dangling bindings", async () => {
      await storage.projects.create({ id: "snapshot-project", name: "snapshot", path: "/tmp/snapshot" });
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "dev", targetId: "local",
        worktreePath: "/tmp/p-dev", expectedBranch: "dev",
      });
      await storage.agentSessions.createBound({
        id: "bound", project_id: "p1", branch: "dev", target_id: "local",
        checkout_id: registered.checkout.id,
      });
      await storage.agentSessions.create({ id: "dangling", project_id: "p1", branch: "dev" });
      const raw = new Database(dbPath);
      try {
        raw.pragma("foreign_keys = OFF"); // simulate a restored/corrupt database
        raw.prepare("UPDATE agent_sessions SET project_id = ?, branch = ? WHERE id = ?")
          .run("snapshot-project", "wrong", "bound");
        raw.prepare("UPDATE agent_sessions SET workspace_checkout_id = ? WHERE id = ?")
          .run("missing-checkout", "dangling");
      } finally {
        raw.close();
      }

      expect(await storage.agentSessions.listByBranch("snapshot-project", "wrong")).toEqual([]);
      expect(await storage.agentSessions.listByBranch("p1", "dev")).toEqual([
        expect.objectContaining({ id: "bound", project_id: "p1", branch: "dev" }),
      ]);
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("bound");
    });

    // Adapted from the task brief's characterization skeleton, which asserted
    // a hardcoded "s2 wins" outcome. Empirically (see task-7-report.md), two
    // back-to-back `create()` calls with no intervening delay are a genuine
    // RACE on this hardware: most runs land in the exact same millisecond
    // (created_at/updated_at tie), but occasionally the second call lands a
    // millisecond later. A hardcoded winner is therefore flaky (~1 fail in
    // 15 runs measured). The ORDER BY has no rowid/id tiebreak, so on a
    // genuine tie the query falls back to whatever stable order the engine's
    // scan naturally produces — ascending insertion order here, i.e. the
    // FIRST-inserted row (s1) wins on tie, not the most-recently-inserted
    // one. This matches Task 6's note that engine tie behavior is quirky.
    // Asserting on the measured tie state (instead of hardcoding a winner)
    // characterizes BOTH real behaviors deterministically: tie -> first
    // wins; genuine timestamp difference -> newest wins. The Kysely port
    // must reproduce the identical ORDER BY (no added tiebreak) to preserve
    // both.
    it("getLatestByBranch/listByBranch: a genuine same-millisecond tie favors the FIRST-inserted session; a genuine timestamp difference favors the newest", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      const [r1, r2] = await Promise.all([storage.agentSessions.getById("s1"), storage.agentSessions.getById("s2")]);
      const tied = r1!.updated_at === r2!.updated_at;
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe(tied ? "s1" : "s2");
      expect((await storage.agentSessions.listByBranch("p1", "dev")).map((s) => s.id)).toEqual(
        tied ? ["s1", "s2"] : ["s2", "s1"]
      );
    });

    it("getLatestByBranch/getByBranch return undefined for an unknown branch", async () => {
      expect(await storage.agentSessions.getLatestByBranch("p1", "nope")).toBeUndefined();
    });
  });

  describe("agentSessions timestamp-touching mutations and their effect on recency ordering", () => {
    // Each of these creates two sessions on the same branch (s2 newer than
    // s1), then mutates s1, and asserts whether getLatestByBranch's ordering
    // flips to s1 (mutation bumped updated_at) or stays s2 (mutation did
    // not touch updated_at). This directly exercises the branch-activity /
    // session-dropdown recency contract described in CLAUDE.md, which is
    // exactly what the millisecond-timestamp design is for.
    const setupTwoSessions = async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await wait(5);
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
      await wait(5);
    };

    it("updateStatus bumps updated_at (recency ordering flips to the updated session)", async () => {
      await setupTwoSessions();
      await storage.agentSessions.updateStatus("s1", "stopped");
      const latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s1");
      expect(latest?.status).toBe("stopped");
    });

    // Adapted from the task brief's characterization skeleton, which asserted
    // a hardcoded "s2" stays latest. As above, back-to-back creates with no
    // delay genuinely tie on updated_at here, so "s2" was never actually the
    // pre-update latest (see the tie-behavior test above — s1 is). Comparing
    // before/after instead of hardcoding a winner makes this test assert
    // exactly what it's meant to (the preserving update doesn't change WHO
    // is latest) without depending on which side of the tie-break quirk the
    // environment happens to land on.
    it("updateStatusPreservingTimestamp does not disturb getLatestByBranch ordering", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      const before = await storage.agentSessions.getLatestByBranch("p1", "dev");
      await storage.agentSessions.updateStatusPreservingTimestamp("s1", "stopped");
      const after = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(after?.id).toBe(before?.id);
    });

    it("updateStatusPreservingTimestamp still updates the status column itself", async () => {
      await setupTwoSessions();
      await storage.agentSessions.updateStatusPreservingTimestamp("s1", "error");
      expect((await storage.agentSessions.getById("s1"))?.status).toBe("error");
    });

    it("updatePermissionMode bumps updated_at and persists the new mode", async () => {
      await setupTwoSessions();
      await storage.agentSessions.updatePermissionMode("s1", "plan");
      const latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s1");
      expect(latest?.permission_mode).toBe("plan");
    });

    it("updateAgentType bumps updated_at and persists the new type", async () => {
      await setupTwoSessions();
      await storage.agentSessions.updateAgentType("s1", "codex");
      const latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s1");
      expect(latest?.agent_type).toBe("codex");
    });

    it("updateTitle bumps updated_at, persists the new title, and can clear it back to null", async () => {
      await setupTwoSessions();
      await storage.agentSessions.updateTitle("s1", "My Session");
      let latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s1");
      expect(latest?.title).toBe("My Session");

      await wait(5);
      await storage.agentSessions.updateTitle("s2", null);
      latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s2");
      expect(latest?.title ?? null).toBeNull();
    });

    it("setFavorited does not touch updated_at, and toggles favorited_at between a timestamp and null", async () => {
      await setupTwoSessions();
      await storage.agentSessions.setFavorited("s1", true);
      // Recency ordering must be unaffected — favoriting is a passive bookmark.
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
      const favorited = await storage.agentSessions.getById("s1");
      expect(favorited?.favorited_at).toEqual(expect.any(Number));

      await storage.agentSessions.setFavorited("s1", false);
      const unfavorited = await storage.agentSessions.getById("s1");
      expect(unfavorited?.favorited_at ?? null).toBeNull();
    });

    it("setNativeSessionId keeps the newest pointer AND the full history of native ids", async () => {
      await setupTwoSessions();
      await storage.agentSessions.setNativeSessionId("s1", "first-native-id", "claude-code");
      // Protocol bookkeeping, not user activity — recency ordering unaffected.
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
      expect((await storage.agentSessions.getById("s1"))?.native_session_id).toBe("first-native-id");

      // A wake/mode-switch/restart spawns a fresh CLI session. The column
      // moves to the newest transcript, but the old association MUST survive:
      // the earlier transcript still holds the turns that ran in it, and if
      // the new process dies before receiving context, the old pointer is the
      // only usable one.
      await storage.agentSessions.setNativeSessionId("s1", "second-native-id", "claude-code");
      expect((await storage.agentSessions.getById("s1"))?.native_session_id).toBe("second-native-id");
      // Re-recording the current id (claude re-emits it every turn) is a no-op.
      await storage.agentSessions.setNativeSessionId("s1", "second-native-id", "claude-code");

      expect((await storage.agentSessions.getNativeSessionIds("s1")).map((r) => r.native_session_id))
        .toEqual(["first-native-id", "second-native-id"]);

      // History is scoped per session and cascades with it.
      expect(await storage.agentSessions.getNativeSessionIds("s2")).toEqual([]);
      await storage.agentSessions.delete("s1");
      expect(await storage.agentSessions.getNativeSessionIds("s1")).toEqual([]);
    });

    it("touchUpdatedAt bumps updated_at without changing any other column", async () => {
      await setupTwoSessions();
      const before = await storage.agentSessions.getById("s1");
      await storage.agentSessions.touchUpdatedAt("s1");
      const latest = await storage.agentSessions.getLatestByBranch("p1", "dev");
      expect(latest?.id).toBe("s1");
      const after = await storage.agentSessions.getById("s1");
      expect(after?.status).toBe(before?.status);
      expect(after?.permission_mode).toBe(before?.permission_mode);
      expect(after?.title ?? null).toBe(before?.title ?? null);
    });

    it("markUserMessage sets last_user_message_at without touching updated_at", async () => {
      await setupTwoSessions();
      await storage.agentSessions.markUserMessage("s1", 12345);
      // Does not bump recency ordering.
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
      expect((await storage.agentSessions.getById("s1"))?.last_user_message_at).toBe(12345);
    });

    it("markCompleted sets last_completed_at without touching updated_at", async () => {
      await setupTwoSessions();
      await storage.agentSessions.markCompleted("s1", 67890);
      expect((await storage.agentSessions.getLatestByBranch("p1", "dev"))?.id).toBe("s2");
      expect((await storage.agentSessions.getById("s1"))?.last_completed_at).toBe(67890);
    });

    it("increments the history epoch without touching existing entries", async () => {
      await setupTwoSessions();
      await storage.agentSessions.upsertEntry("s1", 0, JSON.stringify({ type: "user", content: "old" }));
      expect((await storage.agentSessions.getById("s1"))?.history_epoch).toBe(0);
      expect(await storage.agentSessions.incrementHistoryEpoch("s1")).toBe(1);
      expect(await storage.agentSessions.incrementHistoryEpoch("s1")).toBe(2);
      expect((await storage.agentSessions.getEntries("s1"))).toHaveLength(1);
    });
  });

  describe("agentSessions.delete", () => {
    it("removes the session row", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.delete("s1");
      expect(await storage.agentSessions.getById("s1")).toBeUndefined();
    });

    it("cascades to agent_session_entries (FK ON DELETE CASCADE)", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.upsertEntry("s1", 0, "hello");
      await storage.agentSessions.delete("s1");
      expect(await storage.agentSessions.getEntries("s1")).toEqual([]);
    });
  });

  describe("agent_session_entries", () => {
    // Verbatim from the task brief's characterization skeleton.
    it("upsertEntry overwrites the same index, getEntries returns index order", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.upsertEntry("s1", 1, "one");
      await storage.agentSessions.upsertEntry("s1", 0, "zero");
      await storage.agentSessions.upsertEntry("s1", 1, "one-v2");
      const entries = await storage.agentSessions.getEntries("s1");
      expect(entries).toEqual([{ entry_index: 0, data: "zero" }, { entry_index: 1, data: "one-v2" }]);
      expect(await storage.agentSessions.countEntries()).toEqual([{ session_id: "s1", cnt: 2 }]);
    });

    it("deleteEntries removes all entries for a session without affecting other sessions", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      await storage.agentSessions.upsertEntry("s1", 0, "a");
      await storage.agentSessions.upsertEntry("s1", 1, "b");
      await storage.agentSessions.upsertEntry("s2", 0, "c");

      await storage.agentSessions.deleteEntries("s1");
      expect(await storage.agentSessions.getEntries("s1")).toEqual([]);
      expect(await storage.agentSessions.getEntries("s2")).toEqual([{ entry_index: 0, data: "c" }]);
    });

    it("countEntries groups counts across multiple sessions", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      await storage.agentSessions.upsertEntry("s1", 0, "a");
      await storage.agentSessions.upsertEntry("s1", 1, "b");
      await storage.agentSessions.upsertEntry("s1", 2, "c");
      await storage.agentSessions.upsertEntry("s2", 0, "d");

      const counts = await storage.agentSessions.countEntries();
      expect(counts.slice().sort((a, b) => a.session_id.localeCompare(b.session_id))).toEqual([
        { session_id: "s1", cnt: 3 },
        { session_id: "s2", cnt: 1 },
      ]);
    });

    // Startup restores a session's runtime state from this alone — never from
    // the transcript (docs/plans/2026-09-05-session-history-lazy-hydration-b.md).
    it("getEntryMetaAll reports count and highest index per session, skipping empty ones", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s3", project_id: "p1", branch: "dev" });
      // Sparse on purpose: indices are allocated, not contiguous, so `count`
      // and `max` are two different facts and restore needs both.
      await storage.agentSessions.upsertEntry("s1", 0, "a");
      await storage.agentSessions.upsertEntry("s1", 7, "b");
      await storage.agentSessions.upsertEntry("s2", 3, "c");

      const meta = await storage.agentSessions.getEntryMetaAll();
      expect(meta.slice().sort((a, b) => a.session_id.localeCompare(b.session_id))).toEqual([
        { session_id: "s1", cnt: 2, max_index: 7 },
        { session_id: "s2", cnt: 1, max_index: 3 },
      ]);
    });

    it("getEntriesBefore pages backwards from the tail, exclusive of the cursor", async () => {
      await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.create({ id: "s2", project_id: "p1", branch: "dev" });
      for (const index of [0, 1, 2, 3, 4]) {
        await storage.agentSessions.upsertEntry("s1", index, `e${index}`);
      }
      await storage.agentSessions.upsertEntry("s2", 9, "other");

      // null cursor = start at the tail, descending.
      expect(await storage.agentSessions.getEntriesBefore("s1", null, 2)).toEqual([
        { entry_index: 4, data: "e4" },
        { entry_index: 3, data: "e3" },
      ]);
      // Strictly before the cursor, so pages never overlap or repeat a row.
      expect(await storage.agentSessions.getEntriesBefore("s1", 3, 2)).toEqual([
        { entry_index: 2, data: "e2" },
        { entry_index: 1, data: "e1" },
      ]);
      // Walking off the front terminates the caller's loop.
      expect(await storage.agentSessions.getEntriesBefore("s1", 0, 2)).toEqual([]);
      // Scoped to one session.
      expect(await storage.agentSessions.getEntriesBefore("s2", null, 10)).toEqual([
        { entry_index: 9, data: "other" },
      ]);
    });
  });

  describe("remoteSessionMappings", () => {
    // Verbatim from the task brief's characterization skeleton.
    it("upsert + title_resolved lifecycle", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r2", "dev"); // overwrite
      const all = await storage.remoteSessionMappings.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].remote_session_id).toBe("r2");
      expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(false);
      await storage.remoteSessionMappings.markTitleResolved("l1");
      expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(true);
    });

    it("upsert overwrites project_id/remote_server_id/remote_session_id/branch but preserves title_resolved across a re-upsert", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
      await storage.remoteSessionMappings.markTitleResolved("l1");
      expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(true);

      // Re-upsert with entirely different values for every overwritable column.
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs2", "r2", "main");
      const all = await storage.remoteSessionMappings.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        local_session_id: "l1",
        project_id: "p1",
        remote_server_id: "rs2",
        remote_session_id: "r2",
        branch: "main",
      });
      // title_resolved is NOT in the ON CONFLICT SET clause — it must survive the overwrite.
      expect(await storage.remoteSessionMappings.isTitleResolved("l1")).toBe(true);
    });

    it("upsert accepts a null branch", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", null);
      const all = await storage.remoteSessionMappings.getAll();
      expect(all[0].branch).toBeNull();
    });

    it("getAll returns routing + notification-sync fields but never title_resolved", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
      const all = await storage.remoteSessionMappings.getAll();
      expect(Object.keys(all[0]).sort()).toEqual(
        [
          "branch",
          "local_session_id",
          "notification_sync_start",
          "notification_watch_until",
          "project_id",
          "remote_server_id",
          "remote_session_id",
          "workspace_checkout_id",
        ].sort()
      );
    });

    it("isTitleResolved returns false for a mapping that doesn't exist", async () => {
      expect(await storage.remoteSessionMappings.isTitleResolved("nonexistent")).toBe(false);
    });

    it("delete removes the mapping", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
      await storage.remoteSessionMappings.delete("l1");
      expect(await storage.remoteSessionMappings.getAll()).toEqual([]);
    });

    it("supports multiple independent mappings", async () => {
      await storage.remoteSessionMappings.upsert("l1", "p1", "rs1", "r1", "dev");
      await storage.remoteSessionMappings.upsert("l2", "p1", "rs1", "r2", "main");
      const all = await storage.remoteSessionMappings.getAll();
      expect(all.map((m) => m.local_session_id).sort()).toEqual(["l1", "l2"]);
    });

    it("projects notification candidates from checkout ownership while preserving routing ids", async () => {
      resetWorkspaceBindingReadMetrics();
      await storage.projects.create({ id: "snapshot-project", name: "snapshot", path: "/tmp/snapshot" });
      const remote = await storage.remoteServers.create({ name: "worker" });
      await storage.projectRemotes.add({
        project_id: "p1", remote_server_id: remote.id, remote_path: "/repo",
      });
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "p1", branch: "actual", targetId: remote.id,
        worktreePath: "/repo/actual", expectedBranch: "actual", pathSource: "reported",
      });
      await storage.remoteSessionMappings.upsertBound({
        localSessionId: "bound-notification", projectId: "p1", remoteServerId: remote.id,
        remoteSessionId: "worker-routing-id", branch: "actual", checkoutId: registered.checkout.id,
      });
      const raw = new Database(dbPath);
      try {
        raw.prepare("UPDATE remote_session_mappings SET project_id = ?, branch = ? WHERE local_session_id = ?")
          .run("snapshot-project", "wrong", "bound-notification");
      } finally {
        raw.close();
      }
      await storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);

      expect(await storage.remoteSessionMappings.getNotificationSyncCandidates({
        now: Date.now(), includeExpired: true,
      }, "notification")).toEqual([expect.objectContaining({
        local_session_id: "bound-notification",
        remote_session_id: "worker-routing-id",
        project_id: "p1",
        remote_server_id: remote.id,
        branch: "actual",
        workspace_checkout_id: registered.checkout.id,
      })]);
      expect(getWorkspaceBindingReadMetrics()).toContainEqual({
        consumer: "notification", outcome: "mismatch", count: 1,
      });
    });
  });
});
