import type { RegisteredWorkspaceCheckout } from "../storage/types.js";

/** What one linked machine holds for a workspace, for every linked machine. */
export interface WorkspaceMachineState {
  /** "local" or a remote server id. */
  serverId: string;
  /** The remote's name (or "local"), shown as-is. */
  name: string;
  /**
   * `present`: a ready checkout. `error`: the last operation here failed and
   * the machine kept why. `creating` / `deleting`: an operation is under way.
   * `absent`: the hub knows this machine does not have it. `unknown`: the hub
   * has never seen this machine's full list, so it cannot say.
   */
  state: "present" | "creating" | "deleting" | "error" | "absent" | "unknown";
  /**
   * For `error`: the machine's own reason. For `present`: why the last
   * operation on a still-usable checkout failed — a delete it refused.
   */
  error?: string | null;
  /** For `absent`: it was deleted here, as opposed to never having been made. */
  deleted?: true;
}

/** A machine the project is linked to, as `computeWorkspaceMachines` needs it. */
export interface LinkedMachine {
  serverId: string;
  name: string;
  /**
   * The hub has registered this machine's complete worktree list at least
   * once. Without that, "no row" is not evidence of anything: rows also arrive
   * singly, from a create or a session binding.
   */
  synced: boolean;
}

function groupByWorkspace(rows: RegisteredWorkspaceCheckout[]): Map<string, RegisteredWorkspaceCheckout[]> {
  const byWorkspace = new Map<string, RegisteredWorkspaceCheckout[]>();
  for (const row of rows) {
    const group = byWorkspace.get(row.workspace.id);
    if (group) group.push(row);
    else byWorkspace.set(row.workspace.id, [row]);
  }
  return byWorkspace;
}

/** The registry's view of one machine for one workspace, from that machine's rows (possibly none). */
function machineStateFromRows(
  rows: RegisteredWorkspaceCheckout[],
  machine: LinkedMachine,
): WorkspaceMachineState {
  const base = { serverId: machine.serverId, name: machine.name };
  // A machine can hold several rows — one per create/delete cycle. A live one
  // wins: the workspace was made again after those deletes.
  const live = rows.find((row) => row.checkout.deleted_at === null);
  if (live) {
    switch (live.checkout.status) {
      case "ready":
        // A usable checkout can still carry a reason: the delete it refused
        // (uncommitted changes, say). The state is fine, the last attempt
        // was not, and the UI has to be able to say which.
        return live.checkout.error ? { ...base, state: "present", error: live.checkout.error } : { ...base, state: "present" };
      case "error":
        return { ...base, state: "error", error: live.checkout.error };
      case "creating":
      case "deleting":
        return { ...base, state: live.checkout.status };
    }
  }
  if (rows.length > 0) return { ...base, state: "absent", deleted: true };
  return { ...base, state: machine.synced ? "absent" : "unknown" };
}

/**
 * Per-machine state of every workspace the registry knows, keyed by branch
 * ("" for the main workspace, which callers leave out: it exists on every
 * machine by definition). Each entry lists every linked machine, in the
 * order given, so the UI's coverage badge, tooltip and repair dialog all read
 * one array.
 *
 * Unlike `findUnhealthyWorkspaces`, this reports `absent` — a machine the
 * user chose to leave out is a normal state, not a contradiction, and gets
 * its own neutral marker rather than the amber warning.
 */
export function computeWorkspaceMachines(
  rows: RegisteredWorkspaceCheckout[],
  linked: LinkedMachine[],
): Map<string, WorkspaceMachineState[]> {
  const machines = new Map<string, WorkspaceMachineState[]>();
  for (const group of groupByWorkspace(rows).values()) {
    const byTarget = new Map<string, RegisteredWorkspaceCheckout[]>();
    for (const row of group) {
      const list = byTarget.get(row.checkout.target_id);
      if (list) list.push(row);
      else byTarget.set(row.checkout.target_id, [row]);
    }
    machines.set(
      group[0].workspace.branch,
      linked.map((machine) => machineStateFromRows(byTarget.get(machine.serverId) ?? [], machine)),
    );
  }
  return machines;
}

/** `present` count over linked count — the coverage badge's numbers. */
export function workspaceCoverage(machines: WorkspaceMachineState[]): { present: number; total: number } {
  return {
    present: machines.filter((machine) => machine.state === "present").length,
    total: machines.length,
  };
}
