// A remote session's local id is `remote-{serverId}-{projectId}-{remoteSessionId}`
// (minted server-side in remote-session-lifecycle.ts), so the machine its agent
// runs on is readable straight off the id — no lookup, no extra request.
const REMOTE_SESSION_ID_RE =
  /^remote-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

/** The machine a session's agent runs on, or null for a local session. */
export function remoteServerIdOf(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return REMOTE_SESSION_ID_RE.exec(sessionId)?.[1] ?? null;
}
