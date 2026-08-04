import type { FastifyInstance } from "fastify";

/**
 * The authenticated principal behind a WebSocket connection.
 *
 * A connection is either a Clerk end user or the canonical local solo tenant.
 * There is deliberately no API-key principal: VIBEDECKX_API_KEY gates the door
 * (the global onRequest hook) but never confers an identity — see requireAuth
 * in server.ts.
 */
export type WsPrincipal =
  | { userId: string; kind: "user" }
  | { userId: null; kind: "solo" };

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
 * on query params. When auth is enabled, a valid Clerk session `token` is the
 * only way through. A `?apiKey=` may still ride along on an API-key-locked
 * server — the global onRequest hook consumes it to open the door — but it is
 * not an identity and is ignored here.
 */
export async function authenticateWs(
  authEnabled: boolean,
  query: { token?: string },
  socket: RejectableSocket,
): Promise<WsPrincipal | null> {
  if (!authEnabled) return { userId: null, kind: "solo" };

  const reject = (error: string): null => {
    try { socket.send(JSON.stringify({ error })); } catch { /* socket closed */ }
    try { socket.close(); } catch { /* already closed */ }
    return null;
  };

  if (!query.token) return reject("Authentication required");
  const userId = await verifyWsToken(query.token);
  if (!userId) return reject("Invalid authentication token");
  return { userId, kind: "user" };
}

/**
 * The user id a connection is scoped to for per-process ownership, or null when
 * the connection is trusted and must not be scoped.
 *
 * Only a real Clerk end user is scoped. Solo mode has a single operator *and*
 * its process WebSocket doubles as the reverse-connect provider transport: a
 * worker-side terminal or a front-driven executor is provider-owned and has no
 * local `projects` row to be owned by. Scoping those to the `local` tenant fails
 * closed, which severs the tunnel the instant it attaches.
 */
export function processOwnerScope(principal: WsPrincipal): string | null {
  return principal.kind === "user" ? principal.userId : null;
}

/**
 * Resolve the owning projectId of a local executor/terminal process. Prefers the
 * live ProcessManager (the only source for terminals, which are never persisted)
 * and falls back to the persisted executor_process → executor → project chain so
 * that logs of a recently-finished executor still authorize correctly.
 */
async function localProcessProjectId(fastify: FastifyInstance, processId: string): Promise<string | null> {
  const live = fastify.processManager.getProcessProjectId(processId);
  if (live) return live;
  const proc = await fastify.storage.executorProcesses.getById(processId);
  if (!proc) return null;
  const executor = await fastify.storage.executors.getById(proc.executor_id);
  return executor?.project_id ?? null;
}

/**
 * Whether `userId` owns the executor/terminal process `processId`.
 *
 * Remote (reverse-connected) processes are owned via their remote server — the
 * machine the user registered; local processes via their project. Both
 * `remote_servers` and `projects` are scoped by `user_id` in storage, so a
 * `getById(..., userId)` miss means "not owned by this user".
 */
export async function userOwnsProcess(fastify: FastifyInstance, processId: string, userId: string): Promise<boolean> {
  if (processId.startsWith("remote-")) {
    const row = await fastify.storage.remoteExecutorProcesses.getById(processId);
    const map = fastify.remoteExecutorMap.get(processId);
    const remoteServerId = row?.remote_server_id ?? map?.remoteServerId;
    const projectId = row?.project_id ?? map?.projectId ?? null;
    if (remoteServerId && await fastify.storage.remoteServers.getById(remoteServerId, userId)) return true;
    if (projectId && await fastify.storage.projects.getById(projectId, userId)) return true;
    return false;
  }
  const projectId = await localProcessProjectId(fastify, processId);
  if (!projectId) return false;
  return !!(await fastify.storage.projects.getById(projectId, userId));
}

/**
 * Whether `userId` owns the agent session `sessionId`. Remote sessions are owned
 * via their remote server; local sessions via their project.
 */
export async function userOwnsSession(fastify: FastifyInstance, sessionId: string, userId: string): Promise<boolean> {
  if (sessionId.startsWith("remote-")) {
    const info = fastify.remoteSessionMap.get(sessionId);
    if (info?.remoteServerId && await fastify.storage.remoteServers.getById(info.remoteServerId, userId)) return true;
    const allMappings = await fastify.storage.remoteSessionMappings.getAll();
    const mapping = allMappings.find((m) => m.local_session_id === sessionId);
    if (mapping && await fastify.storage.projects.getById(mapping.project_id, userId)) return true;
    return false;
  }
  const session = await fastify.storage.agentSessions.getById(sessionId);
  if (!session) return false;
  return !!(await fastify.storage.projects.getById(session.project_id, userId));
}
