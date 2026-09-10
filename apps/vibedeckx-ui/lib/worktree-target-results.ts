/**
 * Multi-target worktree create/delete results.
 *
 * The server keys per-target results by "local", by "remote" when the project
 * has exactly one remote, and by the *remote server id* when it has several.
 * Reading only `results.remote` therefore goes blind on multi-remote projects
 * and reports the wrong target with no error text, so everything here works off
 * the whole map and uses the server-supplied `label` to name each key.
 */

export interface RetainedBranch {
  branch: string;
  /** Git refused to delete it because it holds commits nothing else has. */
  unmerged: boolean;
}

export interface WorktreeTargetOutcome {
  success: boolean;
  /** Display name for this target. Absent on servers older than this field. */
  label?: string;
  /** The machine itself ("local" or a remote server id), for acting on it. */
  targetId?: string;
  /** The target reused a branch that already existed there, ignoring the base branch. */
  adopted?: boolean;
  /** Set when a delete left the branch behind, so the name stays taken there. */
  branchRetained?: RetainedBranch | null;
  error?: string;
  errorCode?: string;
  requestId?: string;
}

export type WorktreeTargetResults = Record<string, WorktreeTargetOutcome | undefined>;

/** Name for a result key: server label first, then the two well-known keys, then the raw id. */
export function targetLabel(key: string, outcome?: WorktreeTargetOutcome): string {
  if (outcome?.label) return outcome.label;
  if (key === "local") return "local";
  if (key === "remote") return "remote";
  return key;
}

/** Why one target failed, phrased to read after "<label>: ". */
export function targetFailureReason(outcome: WorktreeTargetOutcome): string {
  const detail = outcome.error || "Unknown error";
  let reason: string;
  switch (outcome.errorCode) {
    case "timeout":
      reason = "connection timed out — the remote may be slow or unreachable";
      break;
    case "network_error":
      reason = "remote is not connected — run the connect command on that machine (Settings → Remote Servers → connect token)";
      break;
    case "auth_error":
      reason = "authentication failed — re-run the connect command on that machine (Settings → Remote Servers → connect token)";
      break;
    default:
      reason = detail;
      break;
  }
  return outcome.requestId ? `${reason} (Request ID: ${outcome.requestId})` : reason;
}

function partition(results: WorktreeTargetResults | undefined) {
  const entries = Object.entries(results ?? {}).filter(
    (entry): entry is [string, WorktreeTargetOutcome] => !!entry[1],
  );
  return {
    succeeded: entries.filter(([, r]) => r.success).map(([key, r]) => targetLabel(key, r)),
    failed: entries.filter(([, r]) => !r.success).map(([key, r]) => `${targetLabel(key, r)}: ${targetFailureReason(r)}`),
  };
}

/**
 * One sentence covering every target: what worked, what didn't, and why.
 * Returns null when nothing failed. `verb` is the past participle ("created").
 */
export function describeTargetResults(
  results: WorktreeTargetResults | undefined,
  verb: string,
): string | null {
  const { succeeded, failed } = partition(results);
  if (failed.length === 0) return null;
  const failures = failed.join("; ");
  if (succeeded.length === 0) return `Failed on ${failures}`;
  return `Workspace ${verb} on ${succeeded.join(", ")}, but failed on ${failures}`;
}

/** Same detail, appended to an outright failure message (no target succeeded). */
export function appendTargetFailures(message: string, results: WorktreeTargetResults | undefined): string {
  const { failed } = partition(results);
  return failed.length > 0 ? `${message} — ${failed.join("; ")}` : message;
}

/**
 * Targets that reused an existing branch instead of cutting a new one. The user
 * picked a base branch that did not apply there, so this is worth saying out loud.
 */
export function adoptedTargets(results: WorktreeTargetResults | undefined): string[] {
  return Object.entries(results ?? {})
    .filter((entry): entry is [string, WorktreeTargetOutcome] => !!entry[1]?.adopted)
    .map(([key, outcome]) => targetLabel(key, outcome));
}

/**
 * A delete that removed the workspace but left its branch. Worth telling the
 * user: unmerged work survived, and the branch keeps that name occupied — a
 * later workspace of the same name will reuse it rather than start clean.
 */
export function describeRetainedBranches(
  results: WorktreeTargetResults | undefined,
  flat?: RetainedBranch | null,
): string | null {
  const entries = Object.entries(results ?? {}).filter(
    (entry): entry is [string, WorktreeTargetOutcome & { branchRetained: RetainedBranch }] =>
      !!entry[1]?.branchRetained,
  );
  const retained = entries.length > 0
    ? entries[0][1].branchRetained
    : flat ?? null;
  if (!retained) return null;
  const where = entries.length > 0
    ? ` on ${entries.map(([key, outcome]) => targetLabel(key, outcome)).join(", ")}`
    : "";
  const why = retained.unmerged ? " — it has commits that are not merged anywhere else" : "";
  return `Kept the branch '${retained.branch}'${where}${why}`;
}

export interface TargetOutcomeLine {
  key: string;
  label: string;
  /** The machine, when the server named it: "local" or a remote server id. */
  targetId?: string;
  ok: boolean;
  /** Why it failed. Absent for a target that succeeded. */
  detail?: string;
}

/** One line per target, for a result view that shows the whole picture at once. */
export function targetOutcomeLines(results: WorktreeTargetResults | undefined): TargetOutcomeLine[] {
  return Object.entries(results ?? {})
    .filter((entry): entry is [string, WorktreeTargetOutcome] => !!entry[1])
    .map(([key, outcome]) => ({
      key,
      label: targetLabel(key, outcome),
      targetId: outcome.targetId,
      ok: outcome.success,
      detail: outcome.success ? undefined : targetFailureReason(outcome),
    }));
}

/** What one machine holds for a workspace, as the worktree list reports it. */
export interface WorkspaceTargetState {
  targetId: string;
  label: string;
  state: "present" | "deleted";
  status?: "creating" | "ready" | "deleting" | "error";
  error?: string | null;
}

/**
 * What one linked machine holds for a workspace — every linked machine, as
 * the worktree list reports it. `unknown` means the hub has never seen that
 * machine's full worktree list, so it cannot say either way.
 */
export interface WorkspaceMachineState {
  /** "local" or a remote server id. */
  serverId: string;
  /** The remote's name, shown as-is. */
  name: string;
  state: "present" | "creating" | "deleting" | "error" | "absent" | "unknown";
  /**
   * For `error`: the machine's own reason. For `present`: why the last
   * operation on a still-usable checkout failed — a delete it refused.
   */
  error?: string | null;
  /** For `absent`: it was deleted here, as opposed to never having been made. */
  deleted?: true;
}

/** A machine's live answer, or its last-known state when it could not be asked. */
export interface WorkspaceMachineCheck extends WorkspaceMachineState {
  /** The worker was actually asked. False = `state` is what the hub last knew. */
  checked: boolean;
  /** Why it could not be asked: offline, timed out, or the worker's own error. */
  checkError?: string;
}

/** `present` count over linked count, and whether any machine is known to lack it. */
export function workspaceCoverage(machines: WorkspaceMachineState[]): {
  present: number;
  total: number;
  missing: boolean;
} {
  return {
    present: machines.filter((machine) => machine.state === "present").length,
    total: machines.length,
    missing: machines.some((machine) => machine.state === "absent"),
  };
}

/**
 * The older per-machine shape (only machines holding registry rows) read as
 * the newer one, for a server that sends `targets` but not `machines`.
 */
export function machinesFromTargets(targets: WorkspaceTargetState[]): WorkspaceMachineState[] {
  return targets.map((target) => {
    const base = { serverId: target.targetId, name: target.label };
    if (target.state === "deleted") return { ...base, state: "absent", deleted: true };
    switch (target.status) {
      case "error":
        return { ...base, state: "error", error: target.error };
      case "creating":
      case "deleting":
        return { ...base, state: target.status };
      default:
        // A usable checkout may still carry the reason a delete refused it.
        return target.error ? { ...base, state: "present", error: target.error } : { ...base, state: "present" };
    }
  });
}

/** One machine's state in a word or two, for a tooltip line or a row label. */
export function machineStateText(machine: WorkspaceMachineState): string {
  switch (machine.state) {
    case "present":
      return "Present";
    case "absent":
      return machine.deleted ? "Deleted here" : "Missing";
    case "error":
      return `Failed — ${machine.error || "the last attempt failed here"}`;
    case "creating":
      return "Creating…";
    case "deleting":
      return "Deleting…";
    case "unknown":
      return "Not checked yet";
  }
}

/**
 * The two ways a workspace's machines can contradict each other — the amber
 * warning's business, as opposed to a deliberate gap:
 *
 *   - `unfinishedDelete`: a tombstone on one machine, a live checkout on
 *     another. Exactly the state a partial delete leaves; the fix is to
 *     delete again.
 *   - `hasError`: a machine kept a reason why it could not comply; the fix is
 *     to create again there.
 */
export function workspaceContradiction(machines: WorkspaceMachineState[]): {
  unfinishedDelete: boolean;
  hasError: boolean;
} {
  const deletedSomewhere = machines.some((machine) => machine.state === "absent" && machine.deleted);
  const heldSomewhere = machines.some((machine) => machine.state !== "absent" && machine.state !== "unknown");
  return {
    unfinishedDelete: deletedSomewhere && heldSomewhere,
    hasError: machines.some((machine) => machine.state === "error"),
  };
}

export interface WorkspaceMachineLine {
  name: string;
  /** That machine's state, in one phrase. */
  text: string;
  /** `text` is the reason the machine gave for refusing, not a state. */
  failed: boolean;
  /** Why the last operation on that machine failed, when its state alone does not say. */
  reason?: string;
}

/**
 * One line per machine for the amber warning's tooltip. A machine that has
 * the workspace means opposite things in the two contradictions, so
 * `unfinishedDelete` picks the wording: while a delete is half-done it is the
 * machine that did NOT comply.
 */
export function describeWorkspaceMachines(
  machines: WorkspaceMachineState[],
  opts?: { unfinishedDelete?: boolean },
): WorkspaceMachineLine[] {
  return machines.map((machine) => {
    if (machine.state === "error") {
      return { name: machine.name, text: machine.error || "failed", failed: true };
    }
    if (machine.state === "present" && opts?.unfinishedDelete) {
      // A usable checkout that still carries a reason is one a delete could
      // not take: the state is fine, the last attempt was not.
      return { name: machine.name, text: "Not deleted", failed: false, ...(machine.error ? { reason: machine.error } : {}) };
    }
    if (machine.state === "absent" && machine.deleted && opts?.unfinishedDelete) {
      return { name: machine.name, text: "Deleted successfully", failed: false };
    }
    return { name: machine.name, text: machineStateText(machine), failed: false };
  });
}
