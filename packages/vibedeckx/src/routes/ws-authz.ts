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

/** Minimal socket surface needed to reject a connection. */
type RejectableSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

/**
 * Clock-skew tolerance for Clerk session-token verification. Clerk's default is
 * 5s, but a 60s session token can be rejected as expired (or not-yet-active)
 * when the verifying server's clock drifts even a few seconds relative to the
 * issuing clock — e.g. an NTP-less VM that resumed from sleep. 30s absorbs
 * realistic drift; the only cost is a token staying valid up to ~30s past its
 * nominal expiry. Applied to every Clerk `verifyToken` call (WS + SSE).
 */
export const CLERK_CLOCK_SKEW_MS = 30_000;

/**
 * Verify a Clerk session token for WebSocket connections.
 * Returns the userId if valid, null otherwise.
 */
export async function verifyWsToken(token: string): Promise<string | null> {
  try {
    const { verifyToken } = await import("@clerk/backend");
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      clockSkewInMs: CLERK_CLOCK_SKEW_MS,
    });
    return payload.sub ?? null;
  } catch (err) {
    // Preserve Clerk's failure reason — `token-not-active-yet` / `token-expired`
    // are strong clock-skew signals and are the hook a future client-facing
    // "your clock is off by N seconds" message (B) would key off.
    const reason = (err as { reason?: string })?.reason;
    if (reason) console.log(`[WsAuth] token verification failed: ${reason}`);
    return null;
  }
}

/**
 * Authenticate a WebSocket connection. Returns the principal, or null after
 * closing the socket on failure.
 *
 * Mirrors `requireAuth` for the WS world: WebSocket upgrades carry no
 * Authorization header (the global Clerk preHandler skips them), so auth rides
 * on query params. When auth is enabled, require either a pre-validated
 * `apiKey` (already checked against VIBEDECKX_API_KEY by the global API-key
 * onRequest hook) or a valid Clerk session `token`. A present `apiKey` only
 * counts when VIBEDECKX_API_KEY is configured — otherwise it is unvalidated and
 * must NOT bypass Clerk. Trusted principals (no-auth / apiKey proxy) carry
 * `userId === null` and skip per-user ownership checks.
 */
export async function authenticateWs(
  authEnabled: boolean,
  query: { apiKey?: string; token?: string },
  socket: RejectableSocket,
): Promise<WsPrincipal | null> {
  if (!authEnabled) return { userId: null };
  if (process.env.VIBEDECKX_API_KEY && query.apiKey) return { userId: null };

  const reject = (error: string): null => {
    try { socket.send(JSON.stringify({ error })); } catch { /* socket closed */ }
    try { socket.close(); } catch { /* already closed */ }
    return null;
  };

  if (!query.token) return reject("Authentication required");
  const userId = await verifyWsToken(query.token);
  if (!userId) return reject("Invalid authentication token");
  return { userId };
}

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
