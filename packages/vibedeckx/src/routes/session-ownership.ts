/**
 * Ownership checks for a session id that may be local or `remote-` prefixed.
 *
 * Shared because more than the lifecycle routes need them: a remote session
 * between `prepare` and `activate` has a creation intent and no mapping, so
 * anything that authorizes it through `remoteSessionMappings` alone 404s for
 * exactly the window in which the composer is still being set up (grants, for
 * one — docs/cross-remote-session-grants-design.md §7).
 */
import type { Storage } from "../storage/types.js";

type OwnershipStorage = Pick<Storage, "agentSessions" | "projects" | "remoteSessionCreationIntents" | "remoteSessionMappings">;

/** Local rows are authorized through their projected project; pending rows are bound, so the projection exists. */
export async function authorizeLocalSession(
  storage: OwnershipStorage,
  sessionId: string,
  authResult: string | undefined,
): Promise<boolean> {
  const activity = await storage.agentSessions.getActivityById(sessionId, "runtime");
  if (!activity) return false;
  return Boolean(await storage.projects.getById(activity.projectId, authResult));
}

/** Remote ids resolve through the durable intent (pending) or the mapping (active). */
export async function authorizeRemoteSession(
  storage: OwnershipStorage,
  sessionId: string,
  authResult: string | undefined,
): Promise<boolean> {
  const { projectId } = await resolveRemoteSessionOwner(storage, sessionId);
  if (!projectId) return false;
  return Boolean(await storage.projects.getById(projectId, authResult));
}

/**
 * The project and the machine a remote session belongs to, from whichever of
 * the intent / mapping exists. Reported separately because they are needed
 * separately: authorization only ever wanted the project, while a caller that
 * must exclude the session's OWN machine from a target list needs the remote.
 */
export async function resolveRemoteSessionOwner(
  storage: OwnershipStorage,
  sessionId: string,
): Promise<{ projectId?: string; remoteServerId?: string }> {
  const [intent, mapping] = await Promise.all([
    storage.remoteSessionCreationIntents.getByLocal(sessionId),
    storage.remoteSessionMappings.getByLocal(sessionId),
  ]);
  return {
    projectId: mapping?.project_id ?? intent?.project_id,
    remoteServerId: mapping?.remote_server_id ?? intent?.remote_server_id,
  };
}
