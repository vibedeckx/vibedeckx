import type { Storage } from "./storage/types.js";
import { canReachRemote, type ReachDeps } from "./cross-remote-access.js";

/**
 * A path the agent gave as absolute (or `~/`) — one no checkout resolves, so
 * which machine's filesystem it belongs to is an open question. Repo-relative
 * paths are never in doubt: they belong to the checkout being browsed.
 */
export function isOutsideArtifactPath(filePath: string): boolean {
  return filePath.startsWith("/") || filePath === "~" || filePath.startsWith("~/");
}

export interface ArtifactReadTarget {
  serverId: string;
  /**
   * The project's checkout on that machine, `/` when the project has none
   * there. The worker's read routes require a `path`, but ignore it entirely
   * for an outside `filePath` — it only determines the base a repo-relative
   * path is confined to.
   */
  remotePath: string;
  /**
   * Only set for the project's own checkouts. A branch means nothing on a
   * machine the project isn't linked to, and sending one makes the worker shell
   * out to `git worktree list` for an answer nobody reads.
   */
  branch: string | null;
}

export interface ArtifactTargetDeps extends ReachDeps {
  storage: ReachDeps["storage"] &
    Pick<Storage, "projectRemotes" | "crossRemoteAudit" | "agentSessions">;
  /** Local session id → the machine its agent runs on (`remote-` sessions only). */
  remoteSessionMap: Map<string, { remoteServerId: string }>;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// `remote-{serverId}-{projectId}-{remoteSessionId}` (remote-session-lifecycle.ts).
// Only the project segment is read here — the machine comes from remoteSessionMap,
// which is authoritative; the tail is left unanchored because it is the worker's
// session id and not guaranteed to be a uuid.
const REMOTE_SESSION_PROJECT_RE = new RegExp(`^remote-${UUID}-(${UUID})-`);

/**
 * Whether this session is one of the project's own.
 *
 * `remoteSessionMap` and the audit trail are global maps keyed by session id, so
 * without this a caller could hand a project it owns the id of a session from
 * somewhere else and steer the search by it. The candidates it produces are all
 * authorized on their own, so this is not the access check — it is what keeps a
 * session id from being a usable lever at all.
 */
async function sessionBelongsToProject(
  deps: ArtifactTargetDeps,
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  const embedded = REMOTE_SESSION_PROJECT_RE.exec(sessionId)?.[1];
  if (embedded) return embedded === projectId;
  if (sessionId.startsWith("remote-")) return false; // malformed remote id — not ours
  const session = await deps.storage.agentSessions.getById(sessionId);
  return session?.project_id === projectId;
}

/**
 * Where to look for an artifact path an agent mentioned, in order.
 *
 * A conversation carries the path but never the machine, and for one session
 * three different machines are plausible: the project's primary remote (what
 * the Files tab browses), the machine the session's own agent runs on, and any
 * machine it reached through the cross-remote gateway — a screenshot taken by
 * `remote_bash` on another box lives in THAT box's /tmp and nowhere else, which
 * is the case the primary-only lookup answers 404 for.
 *
 * Ordered most-specific first: the agent's own machine, then the machines it
 * touched (most recently used first), then the primary as the historical
 * default. The caller stats each in turn and takes the first hit, so a wrong
 * guess costs one round trip over an already-open tunnel.
 *
 * Every candidate is authorized on its own. A machine linked to the project is
 * allowed by that link: it can only exist if one user owned both the project
 * and the machine (project-remote-routes.ts requires `remoteServers.getById`
 * under the caller's id), and it is the same proof every other hub→remote read
 * runs on — the Files tab browses the primary with no further check. Any other
 * machine has no such proof, so it needs the read tier the gateway would have
 * required to touch it. A session id is only ever a lookup key here — it
 * confers nothing the user does not already hold.
 *
 * The audit is a record of calls that RAN (denied and offline attempts are
 * filtered out in listSessionTargets), so a machine reaches this list only by
 * having actually hosted a command of this session — never by having been
 * merely aimed at.
 */
export async function resolveArtifactReadTargets(
  deps: ArtifactTargetDeps,
  opts: {
    projectId: string;
    userId?: string;
    sessionId?: string | null;
    branch?: string | null;
    /** Today's single target: the project's primary remote, when it has one. */
    primary: ArtifactReadTarget | null;
  },
): Promise<ArtifactReadTarget[]> {
  const candidates: string[] = [];

  // A session from another project says nothing about where THIS project's
  // artifacts live, so it is dropped rather than followed: the read falls back
  // to the primary, exactly as it behaves with no session at all.
  const sessionId =
    opts.sessionId && (await sessionBelongsToProject(deps, opts.sessionId, opts.projectId))
      ? opts.sessionId
      : null;

  if (sessionId) {
    const sessionServerId = deps.remoteSessionMap.get(sessionId)?.remoteServerId;
    if (sessionServerId) candidates.push(sessionServerId);
    candidates.push(
      ...(await deps.storage.crossRemoteAudit.listSessionTargets(sessionId, opts.userId)),
    );
  }

  const targets: ArtifactReadTarget[] = [];
  const seen = new Set<string>();

  for (const serverId of candidates) {
    if (seen.has(serverId)) continue;
    seen.add(serverId);

    if (opts.primary?.serverId === serverId) {
      targets.push(opts.primary);
      continue;
    }

    const link = await deps.storage.projectRemotes.getByProjectAndServer(opts.projectId, serverId);
    if (link) {
      targets.push({ serverId, remotePath: link.remote_path, branch: opts.branch ?? null });
      continue;
    }

    const reach = await canReachRemote(deps, opts.userId, serverId, "read");
    if (reach.ok) targets.push({ serverId, remotePath: "/", branch: null });
  }

  if (opts.primary && !seen.has(opts.primary.serverId)) targets.push(opts.primary);

  return targets;
}
