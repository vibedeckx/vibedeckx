import type { RetentionHold, Storage, Task } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemoteSessionInfo } from "./server-types.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import type { EventBus } from "./event-bus.js";

/**
 * Retention holds: things outside a session that point at it — a schedule
 * proposed from it, or a task still open — keep it out of the retention sweep. Manual
 * delete ignores them, exactly like a star.
 *
 * The holders live on the hub (scheduled_tasks.source_session_id), but the
 * sweep runs on the machine that owns the session, so the hub computes the
 * session's whole hold set from every registered source and writes it there:
 * into its own agent_session_retention_holds for a local session, over the
 * tunnel for a `remote-` one. Callers never say "add" or "remove" — they say
 * "this session's holders changed", and the set is recomputed from the
 * sources, so a release that failed earlier is corrected by the next sync —
 * and `releaseStale` runs one for every held session when a worker connects
 * and hourly while it stays connected, so such a hold can't outlive its
 * schedules for long.
 *
 * Whole-set replacement is only safe if the sets land in the order their
 * queries ran: a delete that read `{}` must not land after a create that read
 * `{B}`. Work on a session is therefore serialized (`exclusive`) — the next
 * sync starts only once the previous write settled, and its query runs after
 * that. The schedule create route runs insert + sync + rollback in the same
 * slot, so a concurrent replay can't pick up a row about to be rolled back.
 */

/** One feature whose rows can hold a session (proposed schedules and tasks). */
export interface RetentionHoldSource {
  kind: string;
  listHolders(sessionId: string): Promise<string[]>;
}

export interface RetentionHoldSyncDeps {
  storage: Storage;
  reverseConnectManager?: ReverseConnectManager;
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  sources: RetentionHoldSource[];
  /** Test seam; defaults to the reverse-connect proxy. */
  proxy?: typeof proxyToRemoteAuto;
}

const TIMEOUT_MS = 10_000;

/**
 * Most sessions one releaseStale pass handles. The list comes from the worker,
 * which the hub doesn't trust, and each entry costs a lookup and a push; a real
 * worker has one held session per schedule source, nowhere near this. Entries
 * past the cap are skipped — skipping only delays a release, never a hold.
 */
export const RELEASE_STALE_MAX_SESSIONS = 10_000;

export class RetentionHoldSync {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly releasing = new Map<string, Promise<number>>();

  constructor(private readonly deps: RetentionHoldSyncDeps) {}

  /**
   * Recompute `sessionId`'s holds and write them where the session lives.
   * Rejects when the write did not land (worker offline); the caller decides
   * whether that blocks.
   */
  sync(sessionId: string): Promise<void> {
    return this.exclusive(sessionId, (syncNow) => syncNow());
  }

  /**
   * Run `fn` with this session's slot held: no other sync or exclusive block
   * for the session starts until it settles. `syncNow` syncs inside the slot
   * (calling `sync` from `fn` would wait on itself).
   */
  exclusive<T>(sessionId: string, fn: (syncNow: () => Promise<void>) => Promise<T>): Promise<T> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => fn(() => this.syncNow(sessionId)));
    const tail = run.catch(() => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return run;
  }

  /**
   * Recompute every session that holds on `remoteServerId` reports. A hold
   * only ever outlives its schedules when a release failed (worker away, or a
   * rolled-back create whose push landed after its timeout); this is what
   * eventually frees those sessions. It only re-derives sessions that already
   * have holds — schedules that predate holds are deliberately not backfilled.
   * Never throws; returns how many sessions could not be synced. A call while
   * one for the same worker is running joins it.
   */
  releaseStale(remoteServerId: string): Promise<number> {
    const running = this.releasing.get(remoteServerId);
    if (running) return running;
    const run = this.releaseStaleNow(remoteServerId)
      .finally(() => this.releasing.delete(remoteServerId));
    this.releasing.set(remoteServerId, run);
    return run;
  }

  private async releaseStaleNow(remoteServerId: string): Promise<number> {
    const proxy = this.deps.proxy ?? proxyToRemoteAuto;
    const listed = await proxy(
      remoteServerId, "GET", "/api/path/retention-holds", undefined,
      { reverseConnectManager: this.deps.reverseConnectManager, timeoutMs: TIMEOUT_MS },
    );
    const sessionIds = (listed.data as { sessionIds?: unknown } | undefined)?.sessionIds;
    if (!listed.ok || !Array.isArray(sessionIds)) return 1;
    if (sessionIds.length > RELEASE_STALE_MAX_SESSIONS) {
      console.warn(`[RetentionHolds] ${remoteServerId} listed ${sessionIds.length} held sessions; checking the first ${RELEASE_STALE_MAX_SESSIONS}`);
    }
    let failed = 0;
    for (const remoteSessionId of sessionIds.slice(0, RELEASE_STALE_MAX_SESSIONS)) {
      if (typeof remoteSessionId !== "string") continue;
      try {
        const mapping = await this.deps.storage.remoteSessionMappings.getByRemote(remoteServerId, remoteSessionId);
        if (mapping) {
          await this.sync(mapping.local_session_id);
        } else {
          // No hub id, so no schedule can name it as a source: nothing holds it.
          await this.push({ remoteServerId, remoteSessionId }, []);
        }
      } catch {
        failed++;
      }
    }
    return failed;
  }

  private async syncNow(sessionId: string): Promise<void> {
    const holds: RetentionHold[] = [];
    for (const source of this.deps.sources) {
      for (const id of await source.listHolders(sessionId)) holds.push({ kind: source.kind, id });
    }

    // A session that no longer exists has nothing to protect: deleting it
    // already removed its holds, and writing new ones would only orphan rows.
    if (!sessionId.startsWith("remote-")) {
      if (!(await this.deps.storage.agentSessions.getById(sessionId))) return;
      await this.deps.storage.sessionRetentionHolds.replace(sessionId, holds);
      return;
    }

    const remote = await this.resolveRemote(sessionId);
    if (!remote) return;
    await this.push(remote, holds);
  }

  private async push(
    remote: RemoteSessionInfo, holds: RetentionHold[],
  ): Promise<void> {
    const proxy = this.deps.proxy ?? proxyToRemoteAuto;
    const result = await proxy(
      remote.remoteServerId,
      "PUT",
      `/api/path/retention-holds/${remote.remoteSessionId}`,
      { holds },
      { reverseConnectManager: this.deps.reverseConnectManager, timeoutMs: TIMEOUT_MS },
    );
    // 404 = the worker no longer has the session (same reading as above).
    if (result.status === 404) return;
    if (!result.ok) {
      throw new Error(
        result.status === 0 ? "The session's machine is not connected" : `Worker responded ${result.status}`,
      );
    }
  }

  private async resolveRemote(sessionId: string): Promise<RemoteSessionInfo | null> {
    const live = this.deps.remoteSessionMap.get(sessionId);
    if (live) return live;
    const mapping = await this.deps.storage.remoteSessionMappings.getByLocal(sessionId);
    return mapping
      ? { remoteServerId: mapping.remote_server_id, remoteSessionId: mapping.remote_session_id }
      : null;
  }
}

export function scheduleHoldSource(storage: Storage): RetentionHoldSource {
  return {
    kind: "schedule",
    listHolders: (sessionId) => storage.scheduledTasks.listIdsBySourceSession(sessionId),
  };
}

/**
 * A task proposed from a session holds it only while the task is open: once
 * it is done, cancelled or archived the session falls back to the normal
 * retention rules.
 */
export function taskHoldSource(storage: Storage): RetentionHoldSource {
  return {
    kind: "task",
    listHolders: (sessionId) => storage.tasks.listOpenIdsBySourceSession(sessionId),
  };
}

/**
 * A proposed task's hold follows its status, and status changes come from
 * several places (task routes, turn-end auto-complete), all of which announce
 * themselves with task:updated. Best-effort like the schedule delete release:
 * a failed remote release is retried by releaseStale.
 */
export function subscribeTaskHoldSync(eventBus: EventBus, holds: RetentionHoldSync): () => void {
  return eventBus.subscribe((event) => {
    if (event.type !== "task:updated") return;
    const sourceSessionId = event.task.source_session_id;
    if (typeof sourceSessionId !== "string" || !sourceSessionId) return;
    void holds.sync(sourceSessionId).catch((error) => {
      console.warn(`[RetentionHolds] task hold sync for ${sourceSessionId} deferred:`, error);
    });
  });
}

/** Whether `task` holds its source session out of retention (mirrors listOpenIdsBySourceSession). */
export function taskHoldsSource(task: Task): boolean {
  return !!task.source_session_id && !!task.source_tool_use_id && task.archived_at === null
    && (task.status === "todo" || task.status === "in_progress");
}

/**
 * Apply a change to a task that may (re)acquire its source session's hold —
 * reopening it, unarchiving it — from any writer (task routes, Project Chat).
 * Unlike a release, a failed acquire can't be left to releaseStale: that only
 * revisits sessions that still have holds, and this one may have none. So,
 * like the create route, the change and the sync share the session's slot and
 * the change is reverted (then the error rethrown) when the hold doesn't land.
 *
 * Every change to a proposed task takes the slot, not just ones that look
 * like acquires from outside it: otherwise an edit landing while a reopen's
 * sync is pending would be erased by that reopen's revert. For the same reason
 * the snapshot `revert` restores from is read inside the slot. Changes that
 * don't acquire a hold just apply; their release (if any) follows from
 * task:updated where the writer emits it.
 */
export async function applyTaskChange(
  deps: { storage: Storage; retentionHolds: RetentionHoldSync },
  taskId: string,
  apply: () => Promise<Task | undefined>,
  revert: (before: Task) => Promise<unknown>,
): Promise<Task | undefined> {
  const existing = await deps.storage.tasks.getById(taskId);
  if (!existing?.source_session_id) return apply();
  return deps.retentionHolds.exclusive(existing.source_session_id, async (syncNow) => {
    const before = await deps.storage.tasks.getById(taskId);
    if (!before) return undefined;
    const task = await apply();
    if (!task || taskHoldsSource(before) || !taskHoldsSource(task)) return task;
    try {
      await syncNow();
      return task;
    } catch (error) {
      await revert(before);
      await syncNow().catch(() => undefined);
      throw error;
    }
  });
}

/** Revert for a field patch: put back only the fields the patch set. */
export function revertTaskPatch(
  storage: Storage,
  taskId: string,
  patch: Parameters<Storage["tasks"]["update"]>[1],
): (before: Task) => Promise<unknown> {
  return (before) => storage.tasks.update(taskId, Object.fromEntries(
    (Object.keys(patch) as Array<keyof typeof patch>)
      .filter((key) => patch[key] !== undefined)
      .map((key) => [key, before[key]]),
  ));
}
