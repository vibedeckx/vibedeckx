import type { RegisteredWorkspaceCheckout, WorkspaceCheckoutStatus } from "../storage/types.js";

/** What one machine holds for a workspace. */
export interface WorkspaceTargetState {
  targetId: string;
  /** Name to show for that machine: the remote's name, or "local". */
  label: string;
  /** `present`: a live checkout is registered here. `deleted`: it was removed here. */
  state: "present" | "deleted";
  /** Only for a present target. */
  status?: WorkspaceCheckoutStatus;
  error?: string | null;
}

export interface WorkspaceHealth {
  /** Workspace identity as the worktree list spells it — null for the main workspace. */
  branch: string | null;
  targets: WorkspaceTargetState[];
  /** Deleted on some machines, still there on others. */
  unfinishedDelete: boolean;
}

/**
 * Workspaces whose machines disagree with each other.
 *
 * The worktree list is one machine's Git talking — the project's primary
 * remote, or the local path. That makes a multi-machine workspace visible or
 * invisible by accident of which machine happens to be first: a delete that
 * failed on the primary leaves the row in place (and its Delete button is the
 * retry), while the same failure on any other machine makes the workspace
 * vanish from the UI while it is still on disk over there. The registry is the
 * only place that knows all the machines at once, so the disagreements are read
 * from it and merged into the list.
 *
 * Only disagreements are reported, never the healthy majority. Registry rows
 * for a non-primary machine are refreshed just when someone lists that machine,
 * so they can lag reality; a rule like "list anything the registry calls alive"
 * would resurrect workspaces the user removed by hand and never let them go.
 * Both shapes reported here instead require a *contradiction* between machines,
 * which only a failed multi-machine operation can produce:
 *
 *   - `unfinishedDelete` — a tombstone on one machine, a live checkout on
 *     another. Exactly the state a partial delete leaves.
 *   - an `error` checkout — the machine kept a reason why it could not comply
 *     (a create that lost a race with an existing branch, say).
 *
 * Both clear themselves: finishing the delete tombstones the rest, and a
 * successful retry clears the error.
 */
export function findUnhealthyWorkspaces(
  rows: RegisteredWorkspaceCheckout[],
  labelOf: (targetId: string) => string,
): WorkspaceHealth[] {
  const byWorkspace = new Map<string, RegisteredWorkspaceCheckout[]>();
  for (const row of rows) {
    const group = byWorkspace.get(row.workspace.id);
    if (group) group.push(row);
    else byWorkspace.set(row.workspace.id, [row]);
  }

  const unhealthy: WorkspaceHealth[] = [];
  for (const group of byWorkspace.values()) {
    const byTarget = new Map<string, WorkspaceTargetState>();
    for (const row of group) {
      const targetId = row.checkout.target_id;
      const live = row.checkout.deleted_at === null;
      const existing = byTarget.get(targetId);
      // A machine can hold several rows — one per create/delete cycle. A live
      // one wins: the workspace was made again after those deletes.
      if (existing?.state === "present" && !live) continue;
      byTarget.set(targetId, live
        ? {
          targetId,
          label: labelOf(targetId),
          state: "present",
          status: row.checkout.status,
          error: row.checkout.error,
        }
        : { targetId, label: labelOf(targetId), state: "deleted" });
    }

    const targets = [...byTarget.values()];
    const present = targets.filter((target) => target.state === "present");
    const unfinishedDelete = present.length > 0 && present.length < targets.length;
    const hasError = present.some((target) => target.status === "error");
    if (!unfinishedDelete && !hasError) continue;

    unhealthy.push({
      // The registry stores the main workspace as "", the list calls it null.
      branch: group[0].workspace.branch === "" ? null : group[0].workspace.branch,
      targets,
      unfinishedDelete,
    });
  }
  return unhealthy;
}
