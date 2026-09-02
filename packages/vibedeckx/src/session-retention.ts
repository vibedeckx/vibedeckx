import type { Storage } from "./storage/types.js";
import {
  MS_PER_DAY,
  parseRetentionDays,
  retentionCutoff,
  SESSION_RETENTION_SETTING_KEY,
} from "./session-retention-config.js";

/**
 * Session retention sweeper —
 * docs/plans/2026-08-08-session-retention.md.
 *
 * Every worker periodically deletes its own expired sessions: last active
 * more than N days ago, not favorited, not running, not a participant of an
 * active workflow run. Deletion is whole-session (the children follow via
 * ON DELETE CASCADE), which is exactly what the manual delete button does —
 * no tombstones, no new UI state.
 *
 * The sweep is predicate-driven and therefore idempotent: re-running the
 * candidate query IS the progress marker, so there is no watermark, no
 * progress table and nothing to reconcile after a crash. On a hub (or any
 * machine with no local sessions) a tick is a single empty SELECT — the code
 * has no `if (isHub)` branch because it doesn't need one.
 */

/** Candidates examined per query. Small: each one is a synchronous delete. */
const BATCH_SIZE = 20;

/**
 * Soft budget for one tick, checked at batch boundaries only. A single very
 * large session's CASCADE delete can overrun it; what this bounds is the
 * NUMBER of batches, not any individual statement (§1.3).
 */
const TICK_BUDGET_MS = 30_000;

/** Steady-state cadence. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Startup delay. Long enough to stay out of the way of restore, the head
 * backup and schema migrations, short enough that a laptop-style worker that
 * is rarely up for six hours still gets swept.
 */
const STARTUP_DELAY_MS = 90_000;

export interface SessionRetentionDeps {
  storage: Storage;
  /**
   * Retention's delete path. Must never stop a running process and must
   * re-verify the predicate itself — `AgentSessionManager.
   * deleteDormantSessionIfExpired`.
   */
  deleteIfExpired: (sessionId: string, cutoff: number) => Promise<boolean>;
  /**
   * Lifecycle maintenance that rides this tick (prepared-session design
   * §11): TTL-expire stale pending rows, GC tombstones past the replay
   * window. Runs BEFORE the retention gate because it cleans protocol
   * bookkeeping, not user history — the retention window (off by default)
   * must not be able to switch it off.
   */
  maintenance?: () => Promise<void>;
  now?: () => number;
  batchSize?: number;
  tickBudgetMs?: number;
  intervalMs?: number;
  startupDelayMs?: number;
}

export interface SweepResult {
  /** Candidates the scan produced (deleted + skipped). */
  scanned: number;
  deleted: number;
  /** True when the tick stopped on its time budget with work left over. */
  budgetExhausted: boolean;
  /** True when retention was off (or turned off mid-sweep). */
  disabled: boolean;
}

export class SessionRetentionSweeper {
  private readonly storage: Storage;
  private readonly deleteIfExpired: SessionRetentionDeps["deleteIfExpired"];
  private readonly maintenance: SessionRetentionDeps["maintenance"];
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly tickBudgetMs: number;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;

  /**
   * Single-flight. The three triggers (startup, timer, settings change) all
   * funnel here; a trigger that arrives while a sweep runs joins that sweep
   * instead of queueing another one behind it — two concurrent sweeps would
   * hand the same candidate to two deletes and double every scan.
   */
  private inFlight: Promise<SweepResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(deps: SessionRetentionDeps) {
    this.storage = deps.storage;
    this.deleteIfExpired = deps.deleteIfExpired;
    this.maintenance = deps.maintenance;
    this.now = deps.now ?? Date.now;
    this.batchSize = deps.batchSize ?? BATCH_SIZE;
    this.tickBudgetMs = deps.tickBudgetMs ?? TICK_BUDGET_MS;
    this.intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = deps.startupDelayMs ?? STARTUP_DELAY_MS;
  }

  /** Arm the startup-delayed run and the steady-state timer. */
  start(): void {
    if (this.closed) return;
    this.startupTimer = setTimeout(() => { void this.sweep(); }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.sweep(); }, this.intervalMs);
    // Internal maintenance, like the head backup: it must never be the reason
    // the process stays alive.
    this.timer.unref?.();
  }

  /** Stop the timers and wait for an in-flight sweep to settle. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * Run a sweep, or join the one already running. Called by the settings
   * route so a freshly saved window takes visible effect within seconds
   * instead of up to six hours later.
   */
  sweep(): Promise<SweepResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.runSweep()
      .catch((error): SweepResult => {
        // Maintenance must never take the server down; the next tick retries
        // from scratch (the query is the progress marker).
        console.error("[SessionRetention] sweep failed:", error);
        return { scanned: 0, deleted: 0, budgetExhausted: false, disabled: false };
      })
      .finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async runSweep(): Promise<SweepResult> {
    if (this.maintenance) {
      try {
        await this.maintenance();
      } catch (error) {
        // Never let bookkeeping block retention — or vice versa.
        console.error("[SessionRetention] lifecycle maintenance failed:", error);
      }
    }
    const startedAt = this.now();
    let scanned = 0;
    let deleted = 0;
    let windowDays: number | null = null;
    // Keyset cursor, alive for THIS sweep only and never persisted. Without
    // it a batch whose 20 candidates were all skipped (mid-wake, or rescued
    // between scan and delete) would be re-read until the time budget ran
    // out, starving every older-but-deletable session behind it (§1.3).
    let after: { activityAt: number; id: string } | undefined;

    // Deleting conversation history is irreversible and happens with nobody
    // watching, so a sweep that removed anything has to say so — the log is
    // the only place a user can later find out why a session is gone. A sweep
    // that removed nothing stays completely silent: this runs every 6 hours on
    // every machine, and a heartbeat line would just train people to ignore it.
    const finish = (result: SweepResult): SweepResult => {
      if (result.deleted > 0) {
        console.log(
          `[SessionRetention] deleted ${result.deleted} expired session(s) `
          + `of ${result.scanned} candidate(s) examined (retention window ${windowDays} days)`
          + `${result.budgetExhausted ? "; more remain for the next tick" : ""}`,
        );
      }
      return result;
    };

    for (;;) {
      // Re-read the configuration at every batch boundary. A sweep can run
      // for tens of seconds; if the operator disables retention or widens the
      // window in that time, continuing with the cutoff captured at entry
      // would permanently delete data under an intent they already withdrew.
      const days = parseRetentionDays(await this.storage.settings.get(SESSION_RETENTION_SETTING_KEY));
      if (days === null) {
        return finish({ scanned, deleted, budgetExhausted: false, disabled: true });
      }
      windowDays = days;
      const cutoff = retentionCutoff(days, this.now());

      const candidates = await this.storage.agentSessions.listRetentionCandidates({
        cutoff,
        limit: this.batchSize,
        after,
      });
      // The steady-state exit: on virtually every tick the very first query
      // returns nothing and the whole sweep costs one indexed SELECT.
      if (candidates.length === 0) {
        return finish({ scanned, deleted, budgetExhausted: false, disabled: false });
      }

      for (const candidate of candidates) {
        scanned++;
        // Yield before EVERY delete, not once per batch. better-sqlite3 is
        // synchronous: the `await` below resolves an already-settled promise,
        // and the CASCADE runs on the main thread. Yielding per batch let 20
        // deletes run back-to-back and froze the event loop for ~0.9s at 3k
        // entries/session (measured) — no WebSocket frames, no HTTP, no agent
        // stdout parsing for that whole window. Per-session yielding caps the
        // stall at one statement, which is the same exposure as any ordinary
        // query the app already makes.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          if (await this.deleteIfExpired(candidate.id, cutoff)) {
            deleted++;
            // One line per session, naming it the way the user would recognize
            // it and how stale it was. This is the audit record of what was
            // destroyed; the per-sweep summary alone can't answer "which one".
            const idleDays = Math.floor((this.now() - candidate.activity_at) / MS_PER_DAY);
            console.log(
              `[SessionRetention] deleted session ${candidate.id} `
              + `(project=${candidate.project_id} branch=${candidate.branch ?? "main"}, `
              + `inactive ${idleDays} days)`,
            );
          }
        } catch (error) {
          // Isolate per candidate. Letting one bad session abort the round
          // would starve every older-but-deletable session behind it forever,
          // because each sweep restarts from the oldest — the same failure
          // mode the keyset cursor exists to prevent.
          console.error(`[SessionRetention] failed to delete ${candidate.id}:`, error);
        }
      }

      // Advance whether or not anything was deleted: a skipped candidate gets
      // reconsidered by the NEXT sweep, not by this one.
      const last = candidates[candidates.length - 1];
      after = { activityAt: last.activity_at, id: last.id };

      if (this.now() - startedAt > this.tickBudgetMs) {
        return finish({ scanned, deleted, budgetExhausted: true, disabled: false });
      }
    }
  }
}
