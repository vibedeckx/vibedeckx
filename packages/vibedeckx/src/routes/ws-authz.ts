import type { FastifyInstance } from "fastify";

/**
 * The authenticated principal behind a WebSocket connection.
 *
 * `userId === null` means a trusted connection that is NOT a specific end user:
 *   - no-auth (solo) mode — a single trusted operator, no per-user isolation, or
 *   - a server-to-server proxy connection authenticated by VIBEDECKX_API_KEY
 *     (e.g. the central --auth server reverse-connecting into a user's remote).
 * Such connections bypass per-user ownership checks. A non-null `userId` is a
 * Clerk end user and MUST own the target process/session before streaming or
 * sending input.
 */
export type WsPrincipal = { userId: string | null };

/**
 * Resolve the owning projectId of a local executor/terminal process. Prefers the
 * live ProcessManager (the only source for terminals, which are never persisted)
 * and falls back to the persisted executor_process → executor → project chain so
 * that logs of a recently-finished executor still authorize correctly.
 */
function localProcessProjectId(fastify: FastifyInstance, processId: string): string | null {
  const live = fastify.processManager.getProcessProjectId(processId);
  if (live) return live;
  const proc = fastify.storage.executorProcesses.getById(processId);
  if (!proc) return null;
  return fastify.storage.executors.getById(proc.executor_id)?.project_id ?? null;
}

/**
 * Whether `userId` owns the executor/terminal process `processId`.
 *
 * Remote (reverse-connected) processes are owned via their remote server — the
 * machine the user registered; local processes via their project. Both
 * `remote_servers` and `projects` are scoped by `user_id` in storage, so a
 * `getById(..., userId)` miss means "not owned by this user".
 */
export function userOwnsProcess(fastify: FastifyInstance, processId: string, userId: string): boolean {
  if (processId.startsWith("remote-")) {
    const row = fastify.storage.remoteExecutorProcesses.getById(processId);
    const map = fastify.remoteExecutorMap.get(processId);
    const remoteServerId = row?.remote_server_id ?? map?.remoteServerId;
    const projectId = row?.project_id ?? map?.projectId ?? null;
    if (remoteServerId && fastify.storage.remoteServers.getById(remoteServerId, userId)) return true;
    if (projectId && fastify.storage.projects.getById(projectId, userId)) return true;
    return false;
  }
  const projectId = localProcessProjectId(fastify, processId);
  if (!projectId) return false;
  return !!fastify.storage.projects.getById(projectId, userId);
}

/**
 * Whether `userId` owns the agent session `sessionId`. Remote sessions are owned
 * via their remote server; local sessions via their project.
 */
export function userOwnsSession(fastify: FastifyInstance, sessionId: string, userId: string): boolean {
  if (sessionId.startsWith("remote-")) {
    const info = fastify.remoteSessionMap.get(sessionId);
    if (info?.remoteServerId && fastify.storage.remoteServers.getById(info.remoteServerId, userId)) return true;
    const mapping = fastify.storage.remoteSessionMappings.getAll().find((m) => m.local_session_id === sessionId);
    if (mapping && fastify.storage.projects.getById(mapping.project_id, userId)) return true;
    return false;
  }
  const session = fastify.storage.agentSessions.getById(sessionId);
  if (!session) return false;
  return !!fastify.storage.projects.getById(session.project_id, userId);
}
