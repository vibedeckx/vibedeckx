import type { EventBus } from "./event-bus.js";

/**
 * Authoritative liveness tracking for remote sessions (hub side).
 *
 * A worker announces "this session lost its process" — Stop, a crash, or a
 * resident-cap hibernation — by broadcasting `processAlive: false` on that
 * session's OWN WS stream. The hub carries such a stream only while it holds
 * one for that session, so the notice is lost for every session it does not:
 * after a hub restart or a tunnel outage the sessions nobody has reopened have
 * no stream at all, and the sidebar keeps a row claiming a process that died.
 *
 * `GET /api/path/agent-sessions/alive` is the authoritative answer to "which
 * sessions hold a process", so every such answer is a chance to notice a death
 * nobody announced. The tracker holds the last answer per project and emits
 * `session:process` `alive: false` for whatever the next one drops, whichever
 * caller produced it. One browser's read therefore also repairs the sidebar of
 * a browser that is not reading — which is the point: the stale row is held by
 * the client that is NOT looking.
 *
 * Scoped to what the hub has actually served: a project enters the tracker when
 * someone reads its alive list, which is exactly when a browser starts holding
 * rows that can go stale. A session the hub never reported alive is not the
 * hub's to declare dead.
 *
 * Every answer carries a read id claimed BEFORE its request goes out
 * (`nextReadSeq`), because these reads overlap — two browsers, or a browser and
 * the tunnel-restore reconcile. An answer older than the one already accepted
 * is dropped whole: acting on it would announce the death of a session that has
 * since been woken, or bury a session created after it was taken.
 */

export interface TrackedAliveSession {
  /** `remote-<server>-<project>-<remoteSessionId>` — what the frontend keys rows by. */
  localSessionId: string;
  /** The worker's own id, the only one the worker's alive answer speaks. */
  remoteSessionId: string;
  branch: string | null;
}

interface TrackedProject {
  remoteServerId: string;
  remotePath: string;
  sessions: TrackedAliveSession[];
  /** Read id this baseline came from; a lower one is a stale answer. */
  seq: number;
}

export class RemoteLivenessTracker {
  private readonly byProject = new Map<string, TrackedProject>();
  private seqCounter = 0;
  private readonly eventBus: EventBus | null;

  constructor(eventBus: EventBus | null = null) {
    this.eventBus = eventBus;
  }

  /** Claim a read id BEFORE issuing the request whose answer you will accept. */
  nextReadSeq(): number {
    return ++this.seqCounter;
  }

  /**
   * Take an authoritative alive answer as the project's new baseline and
   * announce every session it retires. Returns the local ids announced.
   *
   * Emits rather than merely recording: a session dropped from the answer has
   * lost its process, and this may be the only place that fact is ever
   * observed — the worker announced it on a stream the hub was not carrying.
   */
  accept(
    projectId: string,
    remoteServerId: string,
    remotePath: string,
    sessions: TrackedAliveSession[],
    seq: number,
  ): string[] {
    const previous = this.byProject.get(projectId);
    if (previous && seq < previous.seq) return []; // overtaken by a newer read
    this.byProject.set(projectId, { remoteServerId, remotePath, sessions, seq });
    if (!previous) return [];

    const live = new Set(sessions.map((session) => session.remoteSessionId));
    const retired = previous.sessions.filter((session) => !live.has(session.remoteSessionId));
    for (const session of retired) {
      this.eventBus?.emit({
        type: "session:process",
        projectId,
        branch: session.branch,
        sessionId: session.localSessionId,
        alive: false,
      });
    }
    return retired.map((session) => session.localSessionId);
  }

  /**
   * `accept` for a caller that has only the worker's ids — the reconcile. Local
   * ids come from the CURRENT baseline, never from the caller's own (possibly
   * older) snapshot: resolving against a stale snapshot would leave out the
   * sessions created since and announce them as dead. Ids the hub has never
   * served stay untracked until a project read names them.
   */
  acceptRemoteIds(
    projectId: string,
    remoteServerId: string,
    remotePath: string,
    rows: Array<{ id: string; branch: string | null }>,
    seq: number,
  ): string[] {
    const known = new Map(
      (this.byProject.get(projectId)?.sessions ?? []).map((session) => [session.remoteSessionId, session]),
    );
    const sessions = rows
      .map((row) => {
        const session = known.get(row.id);
        return session ? { ...session, branch: row.branch } : null;
      })
      .filter((session): session is TrackedAliveSession => session !== null);
    return this.accept(projectId, remoteServerId, remotePath, sessions, seq);
  }

  entriesFor(remoteServerId: string): Array<{ projectId: string } & TrackedProject> {
    const rows: Array<{ projectId: string } & TrackedProject> = [];
    for (const [projectId, tracked] of this.byProject) {
      if (tracked.remoteServerId === remoteServerId) rows.push({ projectId, ...tracked });
    }
    return rows;
  }
}

export interface RemoteLivenessProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface RemoteLivenessReconcileDeps {
  tracker: RemoteLivenessTracker;
  /**
   * Asks one worker for the live sessions under `remotePath`. The tunnel call
   * itself (method + route) belongs to the caller, where the capability
   * registry can see it — this module only decides what to do with the answer.
   */
  proxy: (remoteServerId: string, remotePath: string) => Promise<RemoteLivenessProxyResult>;
}

function parseAliveAnswer(data: unknown): Array<{ id: string; branch: string | null }> | null {
  if (!data || typeof data !== "object") return null;
  const body = data as { sessions?: unknown; complete?: unknown };
  // `complete: false` is "this answer could not be enumerated" (a worker too
  // old to serve the route). Nothing may be declared dead from it.
  if (body.complete === false) return null;
  if (!Array.isArray(body.sessions)) return null;
  const rows: Array<{ id: string; branch: string | null }> = [];
  for (const entry of body.sessions) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; branch?: unknown };
    if (typeof row.id !== "string") continue;
    rows.push({ id: row.id, branch: typeof row.branch === "string" ? row.branch : null });
  }
  return rows;
}

/**
 * Re-ask one worker for its live sessions — the read nobody else is making.
 * A browser's own `/alive` repairs its project as it goes; this covers the
 * projects nobody has open when a tunnel comes back, which is exactly where a
 * death goes unheard.
 *
 * Failure is never death: an offline worker, an error, or a `complete: false`
 * answer leaves that project's baseline untouched, so a transient tunnel
 * problem cannot blank the sidebar.
 */
export async function reconcileRemoteLiveness(
  remoteServerId: string,
  deps: RemoteLivenessReconcileDeps,
): Promise<{ projects: number; dead: string[] }> {
  const dead: string[] = [];
  const tracked = deps.tracker.entriesFor(remoteServerId);
  let projects = 0;

  for (const entry of tracked) {
    if (entry.sessions.length === 0) continue;
    const seq = deps.tracker.nextReadSeq();
    let result: RemoteLivenessProxyResult;
    try {
      result = await deps.proxy(remoteServerId, entry.remotePath);
    } catch (error) {
      console.warn(`[RemoteLiveness] alive query failed for ${entry.projectId}:`, error);
      continue;
    }
    if (!result.ok) continue;
    const rows = parseAliveAnswer(result.data);
    if (!rows) continue;

    projects += 1;
    dead.push(...deps.tracker.acceptRemoteIds(
      entry.projectId, remoteServerId, entry.remotePath, rows, seq,
    ));
  }

  if (dead.length > 0) {
    console.log(`[RemoteLiveness] ${remoteServerId}: ${dead.length} session(s) lost their process while unobserved`);
  }
  return { projects, dead };
}
