import type { Storage } from "../storage/types.js";

/**
 * Agent-session provenance shared by things an agent proposes from a session
 * (schedules via propose_schedule, tasks via propose_task).
 */

const SOURCE_ID_MAX = 200;

export interface SourceSessionSummary {
  id: string;
  title: string | null;
  branch: string | null;
  exists: boolean;
}

export const validSourceId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= SOURCE_ID_MAX && value.trim() === value;

/**
 * Whether `sessionId` is a session of `projectId`. A source pair is a GLOBAL
 * idempotency key, so the caller must own the session it names. Otherwise one
 * project could squat the key that another project's confirmation needs: its
 * insert would hit the unique index, find no row of its own, and fail — the
 * real proposal could never be accepted.
 *
 * Both kinds of session must be checked. A local session is a row in
 * agent_sessions; a remote one is not — the server holds it as a
 * remote_session_mappings row keyed by the `remote-` local id, resolved here
 * through the project-scoped lookup. A source that resolves to neither is
 * rejected rather than trusted.
 */
export async function isProjectSourceSession(storage: Storage, sessionId: string, projectId: string): Promise<boolean> {
  const sourceSession = await storage.agentSessions.getById(sessionId);
  return sourceSession
    ? sourceSession.project_id === projectId
    : !!(await storage.remoteSessionMappings.getAuthorizedByLocal(sessionId, projectId));
}

/**
 * Where each proposed row came from, for the source link on the listing page.
 * A deleted source (manual delete, or retention before the hold existed) comes
 * back with exists=false rather than disappearing, so the page can say so.
 * Remote titles come from the search cache — the hub has no other copy, and a
 * missing title just renders as "Untitled".
 */
export async function resolveSourceSessions(storage: Storage, ids: string[]): Promise<Map<string, SourceSessionSummary>> {
  const unique = [...new Set(ids)];
  const remoteIds = unique.filter((id) => id.startsWith("remote-"));
  const remoteTitles = await storage.searchCache.getCachedSessionTitles(remoteIds);
  // Checkout-first branch, like the sidebar's projection: a re-anchored
  // workspace moves its sessions, the snapshot branch column doesn't.
  const branchOf = async (row: { branch: string | null; workspace_checkout_id?: string | null } | undefined) => {
    if (!row) return null;
    const registered = row.workspace_checkout_id
      ? await storage.workspaceRegistry.getCheckoutById(row.workspace_checkout_id)
      : undefined;
    return (registered ? registered.workspace.branch : row.branch) || null;
  };
  const out = new Map<string, SourceSessionSummary>();
  await Promise.all(unique.map(async (id) => {
    if (id.startsWith("remote-")) {
      const mapping = await storage.remoteSessionMappings.getByLocal(id);
      out.set(id, {
        id, exists: !!mapping, branch: await branchOf(mapping), title: remoteTitles.get(id) ?? null,
      });
      return;
    }
    const session = await storage.agentSessions.getById(id);
    out.set(id, { id, exists: !!session, branch: await branchOf(session), title: session?.title ?? null });
  }));
  return out;
}
