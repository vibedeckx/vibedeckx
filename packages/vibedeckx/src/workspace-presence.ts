import type { Storage } from "./storage/types.js";
import { computeWorkspaceMachines } from "./utils/workspace-health.js";

/** A remote the hub knows does not have the workspace a session was asked for on it. */
export interface WorkspaceMissingOnRemote {
  serverId: string;
  name: string;
  branch: string;
}

/**
 * Whether the hub's registry says `branch` is absent on the remote the
 * project's sessions run on. A session needs a checkout there — the worker
 * refuses to make one — so this turns an opaque worker failure into an
 * answer the UI can act on. Only a *known* absence counts: a remote the hub
 * has never listed, or one holding any live row, is let through, since the
 * worker is the authority and the hub's record may be stale.
 */
export async function findWorkspaceMissingOnRemote(
  storage: Storage,
  opts: { projectId: string; remoteServerId: string; branch: string | null },
): Promise<WorkspaceMissingOnRemote | null> {
  // The main workspace is the repository itself; it is always there.
  if (!opts.branch) return null;
  const remote = await storage.projectRemotes.getByProjectAndServer(opts.projectId, opts.remoteServerId);
  if (!remote) return null;
  const machine = { serverId: remote.remote_server_id, name: remote.server_name, synced: remote.worktrees_synced_at !== null };
  const rows = (await storage.workspaceRegistry.listByProject(opts.projectId, opts.remoteServerId, { includeDeleted: true }))
    .filter((row) => row.workspace.branch === opts.branch);
  const state = computeWorkspaceMachines(rows, [machine]).get(opts.branch)?.[0]?.state
    ?? (machine.synced ? "absent" : "unknown");
  if (state !== "absent") return null;
  return { serverId: machine.serverId, name: machine.name, branch: opts.branch };
}

/** The 409 body for a session refused because its workspace is not on the remote. */
export function workspaceMissingOnRemoteBody(missing: WorkspaceMissingOnRemote) {
  return {
    error: `'${missing.branch}' is not on ${missing.name}. Create it there from the workspace's row menu, or switch to a remote that has it.`,
    errorCode: "workspace-missing-on-remote",
    serverId: missing.serverId,
    name: missing.name,
    branch: missing.branch,
  };
}
