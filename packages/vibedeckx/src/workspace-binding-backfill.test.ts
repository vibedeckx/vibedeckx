import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { RegisteredWorkspaceCheckout, Storage } from "./storage/types.js";
import { conventionalWorktreePath } from "./utils/worktree-paths.js";
import {
  formatBackfillSummary,
  healWorkspaceBindings,
  reconcileReportedWorktrees,
  runWorkspaceBindingBackfill,
  snapshotLiveCheckouts,
} from "./workspace-binding-backfill.js";

describe("reconcileReportedWorktrees", () => {
  let dir: string;
  let storage: Storage;
  let remoteId: string;
  const dev = () => conventionalWorktreePath("/repo", "dev");

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-reconcile-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: null });
    remoteId = (await storage.remoteServers.create({ name: "worker" })).id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: remoteId, remote_path: "/repo" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const reconcile = (worktrees: Array<{ branch: string | null; worktreePath?: string }>, snapshot: RegisteredWorkspaceCheckout[]) =>
    reconcileReportedWorktrees(storage, { projectId: "p1", targetId: remoteId, remotePath: "/repo", worktrees, snapshot });
  const row = (branch: string) => storage.workspaceRegistry.getByProjectBranch("p1", branch, remoteId);

  it("tombstones a ready row the machine no longer lists, and restores an error row it does", async () => {
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "gone", targetId: remoteId, worktreePath: conventionalWorktreePath("/repo", "gone"), expectedBranch: "gone",
    });
    const failed = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev",
    });
    await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "lost a race");
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);

    const summary = await reconcile([{ branch: null, worktreePath: "/repo" }, { branch: "dev", worktreePath: dev() }, { branch: "new" }], snapshot);

    expect(summary).toEqual({ registered: 2, restored: 1, tombstoned: 1 });
    expect(await row("gone")).toBeUndefined();
    expect((await row("dev"))?.checkout).toMatchObject({ status: "ready", error: null });
    expect((await row("new"))?.checkout.status).toBe("ready");
  });

  it("leaves an operation in flight alone, listed or not", async () => {
    const creating = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev",
    });
    const deleting = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "old", targetId: remoteId, worktreePath: conventionalWorktreePath("/repo", "old"), expectedBranch: "old",
    });
    await storage.workspaceRegistry.setCheckoutStatus(deleting.checkout.id, "deleting");
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);

    // The list predates the delete (still shows `old`) and postdates the
    // create's start (shows `dev`): neither says anything either way.
    const summary = await reconcile([{ branch: null }, { branch: "dev", worktreePath: dev() }, { branch: "old" }], snapshot);

    // Only the main workspace, which had no row yet, was registered.
    expect(summary).toEqual({ registered: 1, restored: 0, tombstoned: 0 });
    expect((await row("dev"))?.checkout).toMatchObject({ id: creating.checkout.id, status: "creating" });
    expect((await row("old"))?.checkout).toMatchObject({ id: deleting.checkout.id, status: "deleting" });
  });

  it("does not let an older answer delete a row that changed after the snapshot", async () => {
    const ready = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev",
    });
    // A snapshot taken before this row's last change: the conditional write
    // sees a different updated_at and declines.
    const stale = [{ ...ready, checkout: { ...ready.checkout, updated_at: "2000-01-01 00:00:00.000" } }];

    const summary = await reconcile([{ branch: null }], stale);

    expect(summary.tombstoned).toBe(0);
    expect((await row("dev"))?.checkout.status).toBe("ready");
  });

  it("does not tombstone a row that an operation reused after the snapshot", async () => {
    // A create that began after the snapshot reuses the same live row (the
    // active-checkout index makes it the only one). Its status has moved
    // on, so the older answer's "not listed" must not close it.
    const ready = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev",
    });
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);
    await storage.workspaceRegistry.setCheckoutStatus(ready.checkout.id, "creating");

    const summary = await reconcile([{ branch: null }], snapshot);

    expect(summary.tombstoned).toBe(0);
    expect((await row("dev"))?.checkout).toMatchObject({ id: ready.checkout.id, status: "creating" });
  });

  it("restores a failed row with the path the worker reports, not the guess it was made from", async () => {
    // A create that timed out left a conventional path; the worker had put
    // the worktree somewhere else. Restoring the status alone would call a
    // wrong path usable.
    const failed = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev", pathSource: "conventional",
    });
    await storage.workspaceRegistry.setCheckoutStatus(failed.checkout.id, "error", "timed out");
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);

    await reconcile([{ branch: null }, { branch: "dev", worktreePath: "/elsewhere/dev" }], snapshot);

    expect((await row("dev"))?.checkout).toMatchObject({
      id: failed.checkout.id, status: "ready", error: null, worktree_path: "/elsewhere/dev", path_source: "reported",
    });
  });

  it("refreshes a ready row's path only if nothing has touched it since the snapshot", async () => {
    const stale = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev", pathSource: "conventional",
    });
    const refused = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "kept", targetId: remoteId, worktreePath: conventionalWorktreePath("/repo", "kept"), expectedBranch: "kept", pathSource: "conventional",
    });
    await storage.workspaceRegistry.setCheckoutStatus(refused.checkout.id, "ready", "Worktree has uncommitted changes");
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);
    // A delete began after the snapshot.
    await storage.workspaceRegistry.setCheckoutStatus(stale.checkout.id, "deleting");

    await reconcile([
      { branch: null },
      { branch: "dev", worktreePath: "/elsewhere/dev" },
      { branch: "kept", worktreePath: "/elsewhere/kept" },
    ], snapshot);

    // Untouched: an older answer must not turn a delete back into ready.
    expect((await row("dev"))?.checkout).toMatchObject({ id: stale.checkout.id, status: "deleting", worktree_path: dev() });
    // Refreshed, and the reason the delete refused it stays.
    expect((await row("kept"))?.checkout).toMatchObject({
      id: refused.checkout.id, status: "ready", worktree_path: "/elsewhere/kept", path_source: "reported",
      error: "Worktree has uncommitted changes",
    });
  });

  it("does not raise a fresh live row for one that was deleted after the snapshot", async () => {
    const gone = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev", pathSource: "conventional",
    });
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);
    await storage.workspaceRegistry.markCheckoutDeleted(gone.checkout.id);

    const summary = await reconcile([{ branch: null }, { branch: "dev", worktreePath: "/elsewhere/dev" }], snapshot);

    expect(summary.registered).toBe(1); // the main workspace only
    expect(await row("dev")).toBeUndefined();
  });

  it("leaves a row that appeared after the snapshot to the operation that made it", async () => {
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);
    const creating = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: remoteId, worktreePath: dev(), expectedBranch: "dev",
    });

    await reconcile([{ branch: null }, { branch: "dev", worktreePath: "/elsewhere/dev" }], snapshot);

    expect((await row("dev"))?.checkout).toMatchObject({ id: creating.checkout.id, status: "creating", worktree_path: dev() });
  });

  it("never tombstones the main workspace", async () => {
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "", targetId: remoteId, worktreePath: "/repo", expectedBranch: "",
    });
    const snapshot = await snapshotLiveCheckouts(storage, "p1", remoteId);
    await reconcile([], snapshot);
    expect((await row(""))?.checkout.status).toBe("ready");
  });
});

describe("self-healing workspace binding backfill", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-heal-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: null });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers worker-reported checkouts and binds the legacy mappings they explain", async () => {
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remote.id, remote_path: "/repo",
    });
    await storage.remoteSessionMappings.upsert("legacy-main", "p1", remote.id, "worker-main", null);
    await storage.remoteSessionMappings.upsert("legacy-dev", "p1", remote.id, "worker-dev", "dev");

    const result = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({
        ok: true,
        data: {
          worktrees: [
            { branch: null, worktreePath: "/repo" },
            { branch: "dev", worktreePath: "/repo-worktrees/dev" },
          ],
        },
      }),
    });

    expect(result.remote.updated).toBe(2);
    // The main workspace round-trips through the '' sentinel, which the raw
    // join would otherwise miss for a NULL-branch mapping.
    expect((await storage.remoteSessionMappings.getByLocal("legacy-main"))?.workspace_checkout_id)
      .toBe((await storage.workspaceRegistry.getByProjectBranch("p1", "", remote.id))?.checkout.id);
    expect((await storage.remoteSessionMappings.getByLocal("legacy-dev"))?.workspace_checkout_id)
      .toBe((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", remote.id))?.checkout.id);
    expect(await storage.remoteSessionMappings.getByLocal("legacy-dev"))
      .toMatchObject({ remote_session_id: "worker-dev" });
  });

  it("leaves an offline remote untouched and heals it on the next pass", async () => {
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remote.id, remote_path: "/repo",
    });
    await storage.remoteSessionMappings.upsert("offline", "p1", remote.id, "worker-x", "dev");

    const offline = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({ ok: false, data: { error: "not connected" } }),
    });
    expect(offline.remote.updated).toBe(0);
    expect((await storage.remoteSessionMappings.getByLocal("offline"))?.workspace_checkout_id).toBeNull();

    const online = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({
        ok: true, data: { worktrees: [{ branch: "dev", worktreePath: "/repo-worktrees/dev" }] },
      }),
    });
    expect(online.remote.updated).toBe(1);
  });

  it("never guesses an ambiguous incarnation and reports it instead", async () => {
    const first = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "rebuilt", targetId: "local",
      worktreePath: "/tmp/old", expectedBranch: "rebuilt",
    });
    await storage.workspaceRegistry.markCheckoutDeleted(first.checkout.id);
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "rebuilt", targetId: "local",
      worktreePath: "/tmp/new", expectedBranch: "rebuilt",
    });
    await storage.agentSessions.create({ id: "ambiguous", project_id: "p1", branch: "rebuilt" });

    const summary = await runWorkspaceBindingBackfill(storage, "local");

    expect(summary.updated).toBe(0);
    expect(summary.reasons.multiple_incarnations).toBe(1);
    expect((await storage.agentSessions.getById("ambiguous"))?.workspace_checkout_id).toBeNull();
  });

  it("stops on the time budget and resumes from the untouched rows next run", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/tmp/dev", expectedBranch: "dev",
    });
    for (let index = 0; index < 4; index += 1) {
      await storage.agentSessions.create({ id: `s${index}`, project_id: "p1", branch: "dev" });
    }
    let clock = 0;

    const bounded = await runWorkspaceBindingBackfill(storage, "local", {
      batchSize: 1, budgetMs: 1, now: () => (clock += 1),
    });
    expect(bounded.incomplete).toBe(true);
    expect(bounded.updated).toBe(1);

    const rest = await runWorkspaceBindingBackfill(storage, "local");
    expect(rest.incomplete).toBe(false);
    expect(rest.updated).toBe(3);
    for (let index = 0; index < 4; index += 1) {
      expect((await storage.agentSessions.getById(`s${index}`))?.workspace_checkout_id)
        .toBe(registered.checkout.id);
    }
    expect((await runWorkspaceBindingBackfill(storage, "local")).updated).toBe(0);
  });

  it("stays silent and does no registry work when every row is already bound", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/tmp/dev", expectedBranch: "dev",
    });
    await storage.agentSessions.createBound({
      id: "bound", project_id: "p1", branch: "dev", target_id: "local",
      checkout_id: registered.checkout.id,
    });
    const listRemoteWorktrees = vi.fn(async () => ({ ok: true, data: { worktrees: [] } }));

    const quiet = await healWorkspaceBindings(storage, { listRemoteWorktrees });

    expect(formatBackfillSummary("startup", quiet)).toBeNull();
    // Steady state must not shell out to git or the tunnel on every startup.
    expect(listRemoteWorktrees).not.toHaveBeenCalled();
  });

  it("heals a worker, whose projects are all path pseudo projects", async () => {
    // A worker never has anything else: `/api/path/agent-sessions*` creates a
    // `path:` row per workspace. Sourcing the sweep from the user-facing
    // project list would silently skip every one of them.
    const repo = mkdtempSync(path.join(tmpdir(), "vdx-worker-project-"));
    try {
      await storage.projects.create({ id: `path:${repo}`, name: "repo", path: repo });
      await storage.agentSessions.create({ id: "legacy", project_id: `path:${repo}`, branch: "" });

      const result = await healWorkspaceBindings(storage);

      expect(result.local.updated).toBe(1);
      const bound = await storage.agentSessions.getById("legacy");
      const checkout = await storage.workspaceRegistry.getByProjectBranch(`path:${repo}`, "", "local");
      expect(bound?.workspace_checkout_id).toBe(checkout?.checkout.id);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a project whose local path disappeared from failing the whole sweep", async () => {
    await storage.projects.create({ id: "gone", name: "gone", path: "/tmp/vdx-not-a-repo" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(healWorkspaceBindings(storage)).resolves.toMatchObject({
        local: { updated: 0 },
      });
    } finally {
      warn.mockRestore();
    }
  });
});
