import type { WorkflowRun } from "@/lib/api";
import type { ResidentSidebarSession } from "@/hooks/use-resident-sessions";

/**
 * "Preparing review" placeholders — the sidebar rows, source-session banner
 * and stand-in view for a review run whose reviewer is still a pending
 * identity (two-phase start, design §10.4: nothing spawns and no projection
 * lists the reviewer until the intent brief is distilled and activation
 * delivers the prompt). The gap between Start and the first `session:process`
 * is tens of seconds; without this state the UI shows nothing at all.
 *
 * One store keyed by run id, fed by three inputs that all carry the same
 * server-stamped run object: the create response, the global
 * `workflow:run-updated` SSE event, and the active-run listing (seed + poll).
 * Every consumer derives from it, so there is exactly one copy of "which
 * reviews are preparing" to keep consistent.
 *
 * Ordering. The three inputs race (SSE vs. a proxied remote read that
 * routinely overtakes it), so a run only ever moves FORWARD: `runVersion`
 * ranks the status machine first, `updated_at` second, and a lower version is
 * dropped. That is what keeps a late poll response from flipping a run that
 * the event already advanced to `waiting_reviewer` back to `preparing`.
 *
 * Deletion. The active listing excludes terminal runs, so "absent from a
 * successful listing of its branch" is the cleanup signal — never a failed
 * request, which the caller must not turn into an empty list. Removed runs
 * leave a short tombstone so a stale response cannot resurrect them.
 *
 * Handover is final. The moment `/alive` lists the reviewer, the entry is
 * marked `appearedAt` and stops producing a row for good. Skipping the row
 * only while the reviewer is *currently* live would not be enough: a review
 * lives on in the store until its run ends, and the reviewer's process can
 * leave `/alive` long before that (turn finished, resident pool hibernated
 * it) — which would put the grey "preparing" row back over a session that
 * is real, openable and merely cold.
 */

export const PREPARING_REVIEW_KIND = "preparing-review" as const;

/** How long a removed run stays blocked against re-insertion. */
export const TOMBSTONE_TTL_MS = 60_000;

/**
 * Local display bound only: the backend fails a preparation after
 * PREPARE_TIMEOUT_MS (10 min); this hides a placeholder that outlived even
 * that plus margin without ever asserting the run failed.
 */
export const PLACEHOLDER_TTL_MS = 12 * 60_000;

const STATUS_RANK: Record<WorkflowRun["status"], number> = {
  preparing: 0,
  waiting_reviewer: 1,
  waiting_feedback: 2,
  discussing: 3,
  sending_feedback: 4,
  completed: 9,
  cancelled: 9,
  failed: 9,
};

export function isTerminalRunStatus(status: WorkflowRun["status"]): boolean {
  return STATUS_RANK[status] === 9;
}

/** Monotonic per run: status-machine position first, then server timestamp. */
export function runVersion(run: WorkflowRun): number {
  const stamp = Date.parse(run.updated_at);
  return (STATUS_RANK[run.status] ?? 0) * 1e13 + (Number.isFinite(stamp) ? stamp : 0);
}

export interface PreparingReviewEntry {
  kind: typeof PREPARING_REVIEW_KIND;
  runId: string;
  projectId: string;
  branch: string | null;
  reviewerSessionId: string;
  sourceSessionId: string;
  run: WorkflowRun;
  version: number;
  /** Source-session title captured on the create path, for the row title. */
  titleHint: string | null;
  insertedAt: number;
  /**
   * When the real reviewer session was first seen in `/alive`. Set once and
   * never cleared: from then on this run has a session of its own and the
   * placeholder is retired, whatever the process does afterwards.
   */
  appearedAt: number | null;
}

export interface PreparingReviewsState {
  projectId: string | null;
  entries: ReadonlyMap<string, PreparingReviewEntry>;
  /** runId → tombstone expiry (epoch ms). */
  tombstones: ReadonlyMap<string, number>;
}

export function emptyPreparingReviews(projectId: string | null): PreparingReviewsState {
  return { projectId, entries: new Map(), tombstones: new Map() };
}

function withRemoved(
  state: PreparingReviewsState,
  runIds: string[],
  now: number,
): PreparingReviewsState {
  const entries = new Map(state.entries);
  const tombstones = new Map(state.tombstones);
  for (const id of runIds) {
    entries.delete(id);
    tombstones.set(id, now + TOMBSTONE_TTL_MS);
  }
  return { ...state, entries, tombstones };
}

/**
 * Fold one run object (from any of the three inputs) into the state.
 * `titleHint` is only known on the create path; a later update keeps the
 * hint already stored.
 */
export function applyRunUpdate(
  state: PreparingReviewsState,
  run: WorkflowRun,
  now: number,
  titleHint?: string | null,
): PreparingReviewsState {
  if (!state.projectId || run.project_id !== state.projectId) return state;
  const tombstone = state.tombstones.get(run.id);
  if (tombstone !== undefined && tombstone > now) return state;
  const existing = state.entries.get(run.id);
  if (isTerminalRunStatus(run.status)) {
    return existing ? withRemoved(state, [run.id], now) : state;
  }
  if (!existing) {
    // Only a run seen while still preparing gets a placeholder: anything
    // further along either already has a live reviewer row or is not ours to
    // stand in for.
    if (run.status !== "preparing" || !run.reviewer_session_id) return state;
    const entries = new Map(state.entries);
    entries.set(run.id, {
      kind: PREPARING_REVIEW_KIND,
      runId: run.id,
      projectId: run.project_id,
      branch: run.branch ?? null,
      reviewerSessionId: run.reviewer_session_id,
      sourceSessionId: run.source_session_id,
      run,
      version: runVersion(run),
      titleHint: titleHint ?? null,
      insertedAt: now,
      appearedAt: null,
    });
    return { ...state, entries };
  }
  const version = runVersion(run);
  if (version < existing.version) return state;
  const entries = new Map(state.entries);
  entries.set(run.id, {
    ...existing,
    branch: run.branch ?? null,
    reviewerSessionId: run.reviewer_session_id ?? existing.reviewerSessionId,
    run,
    version,
    titleHint: titleHint ?? existing.titleHint,
  });
  return { ...state, entries };
}

/**
 * Reconcile one SUCCESSFUL active-run listing for `branch`: fold every run
 * it carries, then drop the placeholders of that branch it no longer lists.
 * Other branches are untouched — the listing is authoritative only for the
 * branch it was asked about, and only for placeholders that already existed
 * when it was ISSUED (`issuedAt`): a read started before Start was clicked
 * can come back after the create response inserted the placeholder, and its
 * silence about a run it predates proves nothing.
 */
export function applyBranchListing(
  state: PreparingReviewsState,
  branch: string | null,
  runs: WorkflowRun[],
  now: number,
  issuedAt: number = now,
): PreparingReviewsState {
  let next = state;
  for (const run of runs) next = applyRunUpdate(next, run, now);
  const present = new Set(runs.map((run) => run.id));
  const gone: string[] = [];
  for (const entry of next.entries.values()) {
    if ((entry.branch ?? null) !== (branch ?? null)) continue;
    if (present.has(entry.runId) || entry.insertedAt > issuedAt) continue;
    gone.push(entry.runId);
  }
  return gone.length > 0 ? withRemoved(next, gone, now) : next;
}

/**
 * Retire every placeholder whose reviewer is now among the live sessions.
 * Idempotent: `appearedAt` keeps the first sighting, so a later `/alive`
 * read that no longer carries the reviewer cannot un-retire it.
 */
export function markAppeared(
  state: PreparingReviewsState,
  aliveSessionIds: ReadonlySet<string>,
  now: number,
): PreparingReviewsState {
  let entries: Map<string, PreparingReviewEntry> | null = null;
  for (const entry of state.entries.values()) {
    if (entry.appearedAt !== null || !aliveSessionIds.has(entry.reviewerSessionId)) continue;
    entries ??= new Map(state.entries);
    entries.set(entry.runId, { ...entry, appearedAt: now });
  }
  return entries ? { ...state, entries } : state;
}

/**
 * Drop placeholders older than PLACEHOLDER_TTL_MS (display bound only) and
 * forget expired tombstones. An expired placeholder is tombstoned too: a
 * `preparing` event for it must not bring it back, and a run that did
 * advance never inserts from scratch anyway.
 */
export function expirePlaceholders(state: PreparingReviewsState, now: number): PreparingReviewsState {
  const expired: string[] = [];
  for (const entry of state.entries.values()) {
    if (entry.insertedAt + PLACEHOLDER_TTL_MS <= now) expired.push(entry.runId);
  }
  let next = expired.length > 0 ? withRemoved(state, expired, now) : state;
  let staleTombstones = false;
  for (const expiry of next.tombstones.values()) {
    if (expiry <= now) { staleTombstones = true; break; }
  }
  if (staleTombstones) {
    const tombstones = new Map<string, number>();
    for (const [id, expiry] of next.tombstones) if (expiry > now) tombstones.set(id, expiry);
    next = { ...next, tombstones };
  }
  return next;
}

export function preparingReviewTitle(entry: PreparingReviewEntry, sourceTitle: string | null): string {
  const hint = (entry.titleHint ?? sourceTitle ?? "").trim();
  return hint && hint !== "New Session" ? `Review - ${hint}` : "Review";
}

export function preparingReviewRow(entry: PreparingReviewEntry, sourceTitle: string | null): ResidentSidebarSession {
  return {
    id: entry.reviewerSessionId,
    projectId: entry.projectId,
    branch: entry.branch,
    title: preparingReviewTitle(entry, sourceTitle),
    status: "preparing",
    processAlive: false,
    updated_at: entry.run.created_at,
    kind: PREPARING_REVIEW_KIND,
    runId: entry.runId,
  };
}

/**
 * Sidebar rows = the live-process rows plus one placeholder per preparing
 * review whose reviewer has never been listed among them. A real row always
 * wins: once `/alive` lists the reviewer the placeholder stops being added,
 * so the row changes in place under the same id instead of flickering — and
 * stays gone (`appearedAt`) even if that process later exits.
 */
export function mergePreparingRows(
  resident: Map<string, ResidentSidebarSession[]>,
  entries: readonly PreparingReviewEntry[],
  sourceTitleOf: (sessionId: string) => string | null,
): Map<string, ResidentSidebarSession[]> {
  if (entries.length === 0) return resident;
  const merged = new Map(resident);
  const liveIds = new Set<string>();
  for (const rows of resident.values()) for (const row of rows) liveIds.add(row.id);
  for (const entry of entries) {
    if (entry.appearedAt !== null || liveIds.has(entry.reviewerSessionId)) continue;
    const key = entry.branch ?? "";
    const rows = merged.get(key) ?? [];
    merged.set(key, [preparingReviewRow(entry, sourceTitleOf(entry.sourceSessionId)), ...rows]);
  }
  return merged;
}

export type PreparingSwitchDecision =
  | { kind: "wait" }
  | { kind: "gone" }
  | { kind: "switch"; branch: string | null; sessionId: string };

/**
 * Whether the stand-in view for a run may hand over to the real reviewer
 * session. `waiting_reviewer` alone is not enough: the worker emits it before
 * the hub has the response that publishes the remote mapping, so opening the
 * id then still 404s. The reviewer must be in the live-session list — a
 * `/alive` read that lists it has also bound its mapping on the hub. Having
 * been listed once (`appearedAt`) is equally good: the session exists from
 * then on, and a cold one loads on open.
 */
export function resolvePreparingSwitch(
  entry: PreparingReviewEntry | undefined,
  aliveSessionIds: ReadonlySet<string>,
): PreparingSwitchDecision {
  if (!entry) return { kind: "gone" };
  if (entry.appearedAt !== null) {
    return { kind: "switch", branch: entry.branch, sessionId: entry.reviewerSessionId };
  }
  if (entry.run.status === "preparing") return { kind: "wait" };
  if (isTerminalRunStatus(entry.run.status)) return { kind: "gone" };
  if (!aliveSessionIds.has(entry.reviewerSessionId)) return { kind: "wait" };
  return { kind: "switch", branch: entry.branch, sessionId: entry.reviewerSessionId };
}
