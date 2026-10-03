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
  /**
   * Newest read id whose answer was acted on, per project — baseline or not. A
   * reconcile of a project the hub never served must still be ordered against
   * an overlapping one, without inventing a death baseline for it.
   */
  private readonly answeredSeq = new Map<string, number>();
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
    this.markAnswered(projectId, seq);
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

  /**
   * True when an answer claimed with `seq` has been overtaken by a newer
   * accepted one for this project — it must decide nothing, deaths or status.
   */
  isOvertaken(projectId: string, seq: number): boolean {
    const current = Math.max(this.byProject.get(projectId)?.seq ?? 0, this.answeredSeq.get(projectId) ?? 0);
    return seq < current;
  }

  /** Record that the answer read with `seq` was acted on, without touching the baseline. */
  markAnswered(projectId: string, seq: number): void {
    if (seq > (this.answeredSeq.get(projectId) ?? 0)) this.answeredSeq.set(projectId, seq);
  }

  /** Whether a browser read has given this project a death baseline. */
  hasBaseline(projectId: string): boolean {
    return this.byProject.has(projectId);
  }

  /**
   * Announce each session's current status as the worker reports it.
   *
   * The worker sends status changes only on each session's own stream, so a
   * turn that ended while the hub held no stream for it (a hub restart, a
   * tunnel outage) leaves every browser showing "running" forever. An
   * authoritative alive answer carries the status, so re-announcing it repairs
   * those rows. Deliberately independent of stream restoration: once status
   * moves to a project-level channel this stays as the post-reconnect repair,
   * while per-session streams only carry conversation content.
   */
  announceStatuses(projectId: string, sessions: AliveAnswerSession[]): void {
    for (const session of sessions) {
      if (!session.status) continue;
      this.eventBus?.emit({
        type: "session:status",
        projectId,
        branch: session.branch,
        sessionId: session.localSessionId,
        status: session.status,
      });
    }
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

type AliveStatus = "running" | "stopped" | "error";

interface AliveAnswerRow {
  id: string;
  branch: string | null;
  /** Absent when the worker sent none or an unknown value: nothing to announce. */
  status: AliveStatus | null;
}

/** One session of an accepted alive answer, resolved to the hub's local id. */
export interface AliveAnswerSession {
  localSessionId: string;
  remoteSessionId: string;
  branch: string | null;
  status: AliveStatus | null;
}

export interface RemoteLivenessReconcileDeps {
  tracker: RemoteLivenessTracker;
  /**
   * Asks one worker for the live sessions under `remotePath`. The tunnel call
   * itself (method + route) belongs to the caller, where the capability
   * registry can see it — this module only decides what to do with the answer.
   */
  proxy: (remoteServerId: string, remotePath: string) => Promise<RemoteLivenessProxyResult>;
  /**
   * The projects served from this worker, from persisted config. The tracker
   * alone is not enough: it starts empty on every hub boot, and a restart is
   * exactly when the sessions nobody has reopened lose their status changes.
   */
  listProjects?: (remoteServerId: string) => Promise<Array<{ projectId: string; remotePath: string }>>;
}

function parseAliveAnswer(data: unknown): AliveAnswerRow[] | null {
  if (!data || typeof data !== "object") return null;
  const body = data as { sessions?: unknown; complete?: unknown };
  // `complete: false` is "this answer could not be enumerated" (a worker too
  // old to serve the route). Nothing may be declared dead from it.
  if (body.complete === false) return null;
  if (!Array.isArray(body.sessions)) return null;
  const rows: AliveAnswerRow[] = [];
  for (const entry of body.sessions) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; branch?: unknown; status?: unknown };
    if (typeof row.id !== "string") continue;
    const status = row.status === "running" || row.status === "stopped" || row.status === "error"
      ? row.status
      : null;
    rows.push({ id: row.id, branch: typeof row.branch === "string" ? row.branch : null, status });
  }
  return rows;
}

/**
 * Re-ask one worker for its live sessions — the read nobody else is making.
 * A browser's own `/alive` repairs its project as it goes; this covers the
 * projects nobody has open when a tunnel comes back, which is exactly where a
 * death or a finished turn goes unheard.
 *
 * Each accepted answer is used twice: deaths are diffed against the tracked
 * baseline (only for projects the hub has served — a session it never reported
 * alive is not its to declare dead), and every listed session's status is
 * re-announced. The answers are also returned so the caller can restore
 * streams; that is a separate concern and lives with the caller.
 *
 * Failure is never death: an offline worker, an error, or a `complete: false`
 * answer leaves that project's baseline untouched, so a transient tunnel
 * problem cannot blank the sidebar. An answer overtaken by a newer read
 * decides nothing at all.
 */
export async function reconcileRemoteLiveness(
  remoteServerId: string,
  deps: RemoteLivenessReconcileDeps,
): Promise<{
  projects: number;
  dead: string[];
  answers: Array<{ projectId: string; sessions: AliveAnswerSession[] }>;
}> {
  const dead: string[] = [];
  const answers: Array<{ projectId: string; sessions: AliveAnswerSession[] }> = [];
  const targets = new Map<string, string>();
  for (const entry of deps.tracker.entriesFor(remoteServerId)) targets.set(entry.projectId, entry.remotePath);
  if (deps.listProjects) {
    try {
      for (const project of await deps.listProjects(remoteServerId)) {
        if (!targets.has(project.projectId)) targets.set(project.projectId, project.remotePath);
      }
    } catch (error) {
      console.warn(`[RemoteLiveness] project listing failed for ${remoteServerId}:`, error);
    }
  }
  let projects = 0;

  for (const [projectId, remotePath] of targets) {
    const seq = deps.tracker.nextReadSeq();
    let result: RemoteLivenessProxyResult;
    try {
      result = await deps.proxy(remoteServerId, remotePath);
    } catch (error) {
      console.warn(`[RemoteLiveness] alive query failed for ${projectId}:`, error);
      continue;
    }
    if (!result.ok) continue;
    const rows = parseAliveAnswer(result.data);
    if (!rows) continue;
    if (deps.tracker.isOvertaken(projectId, seq)) continue;

    projects += 1;
    const sessions: AliveAnswerSession[] = rows.map((row) => ({
      localSessionId: `remote-${remoteServerId}-${projectId}-${row.id}`,
      remoteSessionId: row.id,
      branch: row.branch,
      status: row.status,
    }));
    // Judged against the baseline as it is NOW: a browser read may have
    // created one while this query was in flight.
    if (deps.tracker.hasBaseline(projectId)) {
      dead.push(...deps.tracker.acceptRemoteIds(projectId, remoteServerId, remotePath, rows, seq));
    } else {
      deps.tracker.markAnswered(projectId, seq);
    }
    deps.tracker.announceStatuses(projectId, sessions);
    answers.push({ projectId, sessions });
  }

  if (dead.length > 0) {
    console.log(`[RemoteLiveness] ${remoteServerId}: ${dead.length} session(s) lost their process while unobserved`);
  }
  return { projects, dead, answers };
}
