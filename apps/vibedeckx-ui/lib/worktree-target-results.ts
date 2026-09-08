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

export interface WorkspaceTargetLine {
  label: string;
  /** That machine's state, in one phrase. */
  text: string;
  /** `text` is the reason the machine gave for refusing, not a state. */
  failed: boolean;
  /** Why the last operation on that machine failed, when its state alone does not say. */
  reason?: string;
}

/**
 * One line per machine for a workspace whose machines disagree — the sidebar
 * marker's tooltip.
 *
 * A machine that simply has the workspace means opposite things in the two
 * ways machines can disagree, so `unfinishedDelete` picks the wording: while a
 * delete is half-done it is the machine that did NOT comply, and otherwise it
 * is the one that did get the workspace, against a machine that did not.
 *
 * `failed` is kept apart from the text so the caller can show a machine's own
 * error as an error. Unmarked, a raw Git message sits in the list looking like
 * one more state ("Mac: Branch 'dev' already exists" reads as a description of
 * Mac), and the one line that says why something is broken is the one that
 * blends in.
 */
export function describeWorkspaceTargets(
  targets: WorkspaceTargetState[],
  opts?: { unfinishedDelete?: boolean },
): WorkspaceTargetLine[] {
  return targets.map((target) => {
    if (target.state === "deleted") {
      return { label: target.label, text: "Deleted successfully", failed: false };
    }
    if (target.status === "error") {
      return { label: target.label, text: target.error || "failed", failed: true };
    }
    return {
      label: target.label,
      text: opts?.unfinishedDelete ? "Not deleted" : "Created successfully",
      failed: false,
      // A usable checkout that still carries a reason is one a delete could not
      // take: the state is fine, the last attempt was not.
      reason: target.error ?? undefined,
    };
  });
}
