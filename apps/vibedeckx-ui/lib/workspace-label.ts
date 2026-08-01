import type { ProjectRemote } from "@/lib/api";

/**
 * Remote server id → the name the user gave that remote. Activity rows carry
 * the raw server id as their target, which is a uuid and means nothing on
 * screen; the project's own remotes are what translate it.
 */
export function remoteNameMap(remotes: ProjectRemote[]): Map<string, string> {
  return new Map(remotes.map((remote) => [remote.remote_server_id, remote.server_name]));
}

/**
 * Where a session or run lives, branch first: the bare branch locally,
 * "<branch> · <remote>" anywhere else. The branch is what the reader scans
 * for, so it leads and the machine qualifies it. A target with no matching
 * remote left on the project falls back to its id rather than disappearing.
 */
export function workspaceLabel(
  workspace: { target: string; branch: string | null },
  remoteNames: Map<string, string>,
): string {
  const branch = workspace.branch || "main";
  if (workspace.target === "local") return branch;
  return `${branch} · ${remoteNames.get(workspace.target) ?? workspace.target}`;
}
