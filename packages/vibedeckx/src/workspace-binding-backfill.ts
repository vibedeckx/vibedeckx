import type { RegisteredWorkspaceCheckout, Storage, WorkspaceBindingIssueReason } from "./storage/types.js";
import { conventionalWorktreePath, getRegisteredWorktreeBranches } from "./utils/worktree-paths.js";

/**
 * Self-healing migration of legacy `workspace_checkout_id IS NULL` rows.
 *
 * End users never run SQL: the server registers whatever checkouts it can
 * observe, then fills the binding for every row with exactly one candidate.
 * Rows that stay NULL (deleted project, ambiguous incarnation) keep working
 * through the permanent legacy-snapshot fallback — the backfill never guesses.
 */

export interface WorkspaceBindingBackfillSummary {
  scanned: number;
  updated: number;
  reasons: Record<WorkspaceBindingIssueReason, number>;
  /** True when the time/batch budget stopped the sweep before the table ended. */
  incomplete: boolean;
}

/** Worker worktree listing as reported over the tunnel. */
export interface ReportedWorktree {
  branch?: string | null;
  worktreePath?: unknown;
}

const DEFAULT_BUDGET_MS = 5_000;
const DEFAULT_BATCH_SIZE = 200;

const emptyReasons = (): Record<WorkspaceBindingIssueReason, number> => ({
  project_missing: 0,
  workspace_missing: 0,
  checkout_missing: 0,
  main_not_registered: 0,
  target_missing: 0,
  multiple_incarnations: 0,
  dangling_checkout: 0,
  snapshot_mismatch: 0,
});

/**
 * Persist the checkouts a worker reported for one project/target.
 *
 * A worker-reported path is authoritative and may update the live checkout in
 * place; a missing path means an old worker, whose conventional fallback must
 * never overwrite a path a newer worker already reported.
 */
export async function registerReportedWorktrees(
  storage: Storage,
  opts: {
    projectId: string;
    targetId: string;
    remotePath: string;
    worktrees: ReportedWorktree[];
  },
): Promise<void> {
  for (const worktree of opts.worktrees) {
    const branch = worktree.branch ?? "";
    const fallbackPath = branch
      ? conventionalWorktreePath(opts.remotePath, branch)
      : opts.remotePath;
    const reportedPath = typeof worktree.worktreePath === "string" ? worktree.worktreePath : null;
    const existing = await storage.workspaceRegistry.getByProjectBranch(
      opts.projectId, branch, opts.targetId,
    );
    if (existing && (!reportedPath
      || (existing.checkout.path_source === "reported"
        && existing.checkout.worktree_path === reportedPath))) continue;
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: opts.projectId,
      branch,
      targetId: opts.targetId,
      worktreePath: reportedPath ?? fallbackPath,
      expectedBranch: branch,
      pathSource: reportedPath ? "reported" : "conventional",
    });
  }
}

/** What one reconciliation did to the registry, for logs and tests. */
export interface ReconcileSummary {
  registered: number;
  restored: number;
  tombstoned: number;
}

/**
 * The live registry rows of one machine, read *before* asking it for its
 * list. A reconciliation only ever acts on what this snapshot holds, and only
 * through conditional writes keyed on it: anything created or changed after
 * the snapshot — a create that landed while the list was in flight — fails
 * the condition and is left alone. Without that, an older answer would tell
 * the hub to delete a workspace that had just been made.
 */
export async function snapshotLiveCheckouts(
  storage: Storage,
  projectId: string,
  targetId: string,
): Promise<RegisteredWorkspaceCheckout[]> {
  return storage.workspaceRegistry.listByProject(projectId, targetId);
}

/**
 * Make one machine's registry rows agree with the complete worktree list it
 * just reported. Replaces the add-only registration for callers that hold a
 * full list:
 *
 *   - reported, no row       → registered ready (as before)
 *   - reported, row in error → back to ready: the machine has it, so whatever
 *                              failed last time no longer describes it
 *   - row ready, not reported → tombstoned: the worktree was removed by hand,
 *                              and this is how the row stops resurrecting it
 *   - row creating/deleting  → untouched: an operation is under way and the
 *                              list may predate it
 *
 * Restores and tombstones are single conditional writes against the snapshot
 * (see `snapshotLiveCheckouts`). The main workspace ("") is never tombstoned:
 * it is the repository itself.
 */
export async function reconcileReportedWorktrees(
  storage: Storage,
  opts: {
    projectId: string;
    targetId: string;
    remotePath: string;
    worktrees: ReportedWorktree[];
    snapshot: RegisteredWorkspaceCheckout[];
  },
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { registered: 0, restored: 0, tombstoned: 0 };
  const snapshotByBranch = new Map(opts.snapshot.map((row) => [row.workspace.branch, row]));
  const reported = new Set<string>();

  for (const worktree of opts.worktrees) {
    const branch = worktree.branch ?? "";
    reported.add(branch);
    const reportedPath = typeof worktree.worktreePath === "string" ? worktree.worktreePath : null;
    const known = snapshotByBranch.get(branch);

    if (known?.checkout.status === "creating" || known?.checkout.status === "deleting") continue;

    // The worker's path is the true one; a row made from a guess (a create
    // that timed out, say) takes it in the same write. Without a reported
    // path the row keeps what it has.
    const freshPath = reportedPath
      && !(known?.checkout.path_source === "reported" && known.checkout.worktree_path === reportedPath)
      ? { worktreePath: reportedPath, pathSource: "reported" as const }
      : undefined;

    if (known?.checkout.status === "error") {
      const restored = await storage.workspaceRegistry.setCheckoutStatusIfCurrent(
        known.checkout.id,
        { status: "error", updatedAt: known.checkout.updated_at },
        "ready",
        null,
        freshPath,
      );
      if (restored) summary.restored += 1;
      continue;
    }

    if (known) {
      // A ready row with a path worth refreshing. Conditional, like every
      // other write here: a delete that began after the snapshot must not be
      // turned back into ready by an older answer, and one that finished
      // must not be followed by a fresh live row. The reason a delete
      // refused it, if any, stays.
      if (freshPath) {
        await storage.workspaceRegistry.setCheckoutStatusIfCurrent(
          known.checkout.id,
          { status: "ready", updatedAt: known.checkout.updated_at },
          "ready",
          known.checkout.error,
          freshPath,
        );
      }
      continue;
    }

    // Not in the snapshot. A row that has appeared since is someone else's
    // operation, whatever its state; the next listing will see its result.
    const current = await storage.workspaceRegistry.getByProjectBranch(opts.projectId, branch, opts.targetId);
    if (current) continue;
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: opts.projectId,
      branch,
      targetId: opts.targetId,
      worktreePath: reportedPath ?? (branch ? conventionalWorktreePath(opts.remotePath, branch) : opts.remotePath),
      expectedBranch: branch,
      pathSource: reportedPath ? "reported" : "conventional",
    });
    summary.registered += 1;
  }

  for (const row of opts.snapshot) {
    if (row.workspace.branch === "" || reported.has(row.workspace.branch)) continue;
    if (row.checkout.status !== "ready") continue;
    // One conditional write: a claim followed by an unconditional delete
    // would leave a window in which a create that had just reused the row
    // gets its checkout tombstoned from under it.
    const tombstoned = await storage.workspaceRegistry.markCheckoutDeletedIfCurrent(
      row.checkout.id,
      { status: "ready", updatedAt: row.checkout.updated_at },
    );
    if (tombstoned) summary.tombstoned += 1;
  }
  return summary;
}

/**
 * Take in a worker's complete worktree list, and record that the hub has now
 * seen it. With a snapshot of the machine's rows from before the request,
 * the registry is reconciled to the list (see `reconcileReportedWorktrees`);
 * without one, only additions are registered — for a caller whose answer
 * must not move anything (the machine check). Only a real list counts: an
 * odd shape (an old worker, an error body) registers nothing and leaves the
 * remote unconfirmed. So does a list the worker marks `gitError`: Git could
 * not read the repository there, and the root-only answer it fell back to
 * would tombstone every worktree the machine still has. (A worker too old to
 * send the flag cannot be told apart; its fallback still reconciles.)
 */
export async function syncRemoteWorktreeList(
  storage: Storage,
  projectId: string,
  remote: { serverId: string; remotePath: string },
  data: unknown,
  snapshot?: RegisteredWorkspaceCheckout[],
): Promise<boolean> {
  const answer = data as { worktrees?: ReportedWorktree[]; gitError?: unknown } | undefined;
  const worktrees = answer?.worktrees;
  if (!Array.isArray(worktrees)) return false;
  if (typeof answer?.gitError === "string") return false;
  const opts = { projectId, targetId: remote.serverId, remotePath: remote.remotePath, worktrees };
  if (snapshot) await reconcileReportedWorktrees(storage, { ...opts, snapshot });
  else await registerReportedWorktrees(storage, opts);
  await storage.projectRemotes.markWorktreesSynced(projectId, remote.serverId);
  return true;
}

/**
 * Lazily import the local worktrees this machine can still see, so historical
 * sessions have a checkout to bind to.
 *
 * Scoped to projects that actually have unbound sessions — which on a worker
 * means `path:*` pseudo projects, the only kind it has. Per-project failures
 * are non-fatal: a project whose path is gone simply keeps its unbound rows.
 */
export async function syncLocalWorkspaceRegistry(storage: Storage): Promise<void> {
  const projects = await storage.workspaceBindingMigration.listUnboundLocalProjects();
  for (const project of projects) {
    try {
      await getRegisteredWorktreeBranches(storage, project.id, project.path);
    } catch (error) {
      console.warn(`[WorkspaceBinding] Local registry sync failed for ${project.id}:`, error);
    }
  }
}

/**
 * Pull each associated worker's worktree list into the hub registry. Offline
 * workers are skipped silently — the caller re-runs this per remote when the
 * reverse connection comes back online.
 */
export async function syncRemoteWorkspaceRegistry(
  storage: Storage,
  listWorktrees: (
    remoteServerId: string,
    remotePath: string,
  ) => Promise<{ ok: boolean; data: unknown }>,
  opts: { remoteServerId?: string } = {},
): Promise<void> {
  const projects = await storage.projects.getAll();
  for (const project of projects) {
    const remotes = await storage.projectRemotes.getByProject(project.id);
    for (const remote of remotes) {
      if (opts.remoteServerId && remote.remote_server_id !== opts.remoteServerId) continue;
      try {
        const snapshot = await snapshotLiveCheckouts(storage, project.id, remote.remote_server_id);
        const result = await listWorktrees(remote.remote_server_id, remote.remote_path);
        if (!result.ok) continue;
        const worktrees = (result.data as { worktrees?: ReportedWorktree[] })?.worktrees;
        if (!Array.isArray(worktrees)) continue;
        await reconcileReportedWorktrees(storage, {
          projectId: project.id,
          targetId: remote.remote_server_id,
          remotePath: remote.remote_path,
          worktrees,
          snapshot,
        });
        // A complete list has been registered: from here on, a workspace with
        // no row on this remote is known to be absent there, not unconfirmed.
        await storage.projectRemotes.markWorktreesSynced(project.id, remote.remote_server_id);
      } catch (error) {
        console.warn(
          `[WorkspaceBinding] Remote registry sync failed for ${project.id}/${remote.remote_server_id}:`,
          error,
        );
      }
    }
  }
}

/** Drive the batched storage backfill to completion, or until the budget runs out. */
export async function runWorkspaceBindingBackfill(
  storage: Storage,
  kind: "local" | "remote",
  opts: { budgetMs?: number; batchSize?: number; now?: () => number } = {},
): Promise<WorkspaceBindingBackfillSummary> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const summary: WorkspaceBindingBackfillSummary = {
    scanned: 0, updated: 0, reasons: emptyReasons(), incomplete: false,
  };
  let cursor = "";
  for (;;) {
    const batch = await storage.workspaceBindingMigration.backfill({
      kind, dryRun: false, batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE, afterId: cursor,
    });
    summary.scanned += batch.scanned;
    summary.updated += batch.updated;
    for (const [reason, count] of Object.entries(batch.reasons)) {
      summary.reasons[reason as WorkspaceBindingIssueReason] += count;
    }
    if (batch.nextCursor === null) return summary;
    cursor = batch.nextCursor;
    if (now() >= deadline) {
      // Bounded on purpose: the remaining rows are picked up by the next
      // startup, and an unbound row is a working row, not a broken one.
      summary.incomplete = true;
      return summary;
    }
  }
}

/**
 * One self-healing pass: register what can be observed, then bind what can be
 * resolved unambiguously. Safe to call repeatedly; every step is idempotent.
 */
export async function healWorkspaceBindings(
  storage: Storage,
  deps: {
    listRemoteWorktrees?: (
      remoteServerId: string,
      remotePath: string,
    ) => Promise<{ ok: boolean; data: unknown }>;
  } = {},
  opts: { remoteServerId?: string; budgetMs?: number; batchSize?: number } = {},
): Promise<{ local: WorkspaceBindingBackfillSummary; remote: WorkspaceBindingBackfillSummary }> {
  // Cheap probe first. Once every row is bound — the steady state after the
  // migration lands — this whole pass costs two indexed lookups and never
  // shells out to git or the tunnel.
  const probes = await Promise.all((["local", "remote"] as const).map((kind) =>
    storage.workspaceBindingMigration.backfill({ kind, dryRun: true, batchSize: 1 })));
  if (probes.every((probe) => probe.scanned === 0)) {
    return {
      local: { scanned: 0, updated: 0, reasons: emptyReasons(), incomplete: false },
      remote: { scanned: 0, updated: 0, reasons: emptyReasons(), incomplete: false },
    };
  }

  if (!opts.remoteServerId) await syncLocalWorkspaceRegistry(storage);
  if (deps.listRemoteWorktrees) {
    await syncRemoteWorkspaceRegistry(storage, deps.listRemoteWorktrees, {
      remoteServerId: opts.remoteServerId,
    });
  }
  const local = opts.remoteServerId
    ? { scanned: 0, updated: 0, reasons: emptyReasons(), incomplete: false }
    : await runWorkspaceBindingBackfill(storage, "local", opts);
  const remote = await runWorkspaceBindingBackfill(storage, "remote", opts);
  return { local, remote };
}

/** Human-readable one-liner for the startup/reconnect logs. */
export function formatBackfillSummary(
  scope: string,
  result: { local: WorkspaceBindingBackfillSummary; remote: WorkspaceBindingBackfillSummary },
): string | null {
  const updated = result.local.updated + result.remote.updated;
  const merged = emptyReasons();
  for (const reasons of [result.local.reasons, result.remote.reasons]) {
    for (const [reason, count] of Object.entries(reasons)) {
      merged[reason as WorkspaceBindingIssueReason] += count;
    }
  }
  const unresolved = Object.entries(merged).filter(([, count]) => count > 0);
  if (updated === 0 && unresolved.length === 0) return null;
  const detail = unresolved.length > 0
    ? ` unresolved: ${unresolved.map(([reason, count]) => `${reason}=${count}`).join(", ")}`
    : "";
  return `[WorkspaceBinding] ${scope}: bound ${updated} session(s).${detail}`;
}
