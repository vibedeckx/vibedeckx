import type { Worktree } from "./api";
import type { WorkspaceMissingOnRemote } from "@/components/project/workspace-missing-on-remote-dialog";

/**
 * A workspace/session target staged while its project is being switched to.
 * `projectId` is what makes the target self-describing: the staging site and
 * the site that applies it are a render apart, so the applier has to be able
 * to tell "this is for the project I'm now showing" from "this is left over
 * from a navigation that was superseded".
 */
export interface PendingWorkspaceNavigation {
  projectId: string;
  branch: string | null;
  sessionId: string | null;
  /**
   * Open it the way a sidebar row click would: look at where the workspace is
   * placed on the project's current remote before selecting it. Such a target
   * is not applied optimistically — the answer needs the loaded list.
   */
  checkPlacement?: boolean;
}

export interface WorkspaceSelection {
  branch: string | null;
  sessionId: string | null;
}

/**
 * What the workspace selection becomes the instant the project changes.
 *
 * Branch names and session ids are per-project, so the previous project's
 * selection can never carry over — but nulling it unconditionally means every
 * cross-project jump spends the worktree round-trip parked on the main branch,
 * and every branch-scoped consumer (session list, rules, commands) fetches
 * main's data before fetching the data actually asked for.
 *
 * So when the switch is itself a jump, apply the jump's target immediately.
 * It is optimistic — nothing has confirmed the branch exists in the new
 * project yet — and the worktrees-loaded effect still validates it and falls
 * back with a warning if it is gone. That trade is deliberate: a target that
 * vanished costs one wasted query on a branch that isn't there, whereas the
 * null window costs a wasted query on the wrong branch every single time.
 */
export function selectionForProjectSwitch(
  pending: PendingWorkspaceNavigation | undefined,
  nextProjectId: string | undefined,
): WorkspaceSelection {
  if (pending && !pending.checkPlacement && nextProjectId !== undefined && pending.projectId === nextProjectId) {
    return { branch: pending.branch, sessionId: pending.sessionId };
  }
  return { branch: null, sessionId: null };
}

export type WorkspacePlacement =
  | { kind: "present" }
  | { kind: "creating"; machineName: string }
  | { kind: "absent"; missing: WorkspaceMissingOnRemote };

/**
 * Where a workspace stands on the remote sessions would run on, as the hub
 * last saw it. Absent is a prompt, not a wall (the record can be stale);
 * creating only gets a word; anything unknown opens normally.
 */
export function workspacePlacement(
  worktree: Worktree | undefined,
  currentRemoteId: string,
): WorkspacePlacement {
  const current = worktree?.machines?.find((machine) => machine.serverId === currentRemoteId);
  if (worktree?.branch && current?.state === "absent") {
    return {
      kind: "absent",
      missing: {
        branch: worktree.branch,
        current,
        presentOn: worktree.machines!.filter((machine) => machine.state === "present"),
      },
    };
  }
  if (current?.state === "creating") return { kind: "creating", machineName: current.name };
  return { kind: "present" };
}
