import type { Storage, WorkspaceBindingIssueReason } from "./storage/types.js";
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
        const result = await listWorktrees(remote.remote_server_id, remote.remote_path);
        if (!result.ok) continue;
        const worktrees = (result.data as { worktrees?: ReportedWorktree[] })?.worktrees;
        if (!Array.isArray(worktrees)) continue;
        await registerReportedWorktrees(storage, {
          projectId: project.id,
          targetId: remote.remote_server_id,
          remotePath: remote.remote_path,
          worktrees,
        });
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
