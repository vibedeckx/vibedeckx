/**
 * Pure state machine deciding when a coding-agent turn is *really* finished.
 *
 * Claude Code auto-resumes the same process when a background task
 * (background subagent / run_in_background command) completes, so one user
 * request can produce several `result` events; only the last one is the real
 * completion. The protocol exposes no "resumes still queued" signal:
 *  - task notifications can be consumed inside an ongoing turn (no extra
 *    result at all), and
 *  - tasks launched *by subagents* emit indistinguishable lifecycle events in
 *    the main stream but never resume the main agent,
 * so any exact accounting of "notifications owed vs. results seen" can wedge
 * a session in "running" forever. Instead: a success result with an empty
 * task ledger becomes a *held* completion that commits after a short grace
 * window unless the process shows new turn activity first. The failure bias
 * is deliberate — a grace window that is too short degrades to a premature
 * completion (the pre-existing behavior), never to a wedged session.
 *
 * Pure and synchronous: callers own timers and side effects. Every mutating
 * method returns the action to take; `graceElapsed` must be called with the
 * generation returned by the `schedule` action, so a timer armed for a
 * superseded candidate can never commit it.
 */

/** Grace window between a candidate result and committing its completion. */
export const COMPLETION_GRACE_MS = 1500;

export interface CompletionPayload {
  duration_ms?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export type CompletionAction =
  | { kind: "none" }
  /** Clear any scheduled grace timer (idempotent). */
  | { kind: "cancel" }
  /** Run the completion side effects now. */
  | { kind: "commit"; payload: CompletionPayload }
  /** (Re)start the grace timer; pass `generation` back to graceElapsed. */
  | { kind: "schedule"; generation: number };

export class TurnCompletionLedger {
  /** Live background tasks by harness task_id (same id may restart). */
  private tasks = new Set<string>();
  /** Held completion candidate — the latest success result, if any. */
  private pending: CompletionPayload | null = null;
  /** Bumped whenever the candidate changes; stale grace timers no-op. */
  private generation = 0;
  /**
   * Whether any background-task activity happened since the last commit.
   * Turns without it cannot have queued resumes, so they commit with zero
   * grace delay (the common case).
   */
  private sawBackgroundActivity = false;

  get pendingTaskCount(): number {
    return this.tasks.size;
  }

  get hasPendingCompletion(): boolean {
    return this.pending !== null;
  }

  taskStarted(taskId: string): CompletionAction {
    this.tasks.add(taskId);
    this.sawBackgroundActivity = true;
    return this.rearmIfHeld();
  }

  taskFinished(taskId: string): CompletionAction {
    this.tasks.delete(taskId);
    this.sawBackgroundActivity = true;
    return this.rearmIfHeld();
  }

  /** Authoritative snapshot from `system/background_tasks_changed`. */
  taskListChanged(taskIds: string[]): CompletionAction {
    this.tasks = new Set(taskIds);
    if (taskIds.length > 0) this.sawBackgroundActivity = true;
    return this.rearmIfHeld();
  }

  /**
   * The process emitted turn activity: if a completion was held, it was an
   * intermediate result — an auto-resume turn is running and will end with
   * its own result, which becomes the new candidate. The load-bearing signal
   * here is the resume turn's `system/init` (turn_started), which the CLI
   * emits ~20ms after the intermediate result; the first assistant event
   * lags a full LLM roundtrip (4-5s, measured live) and would always lose
   * the race against the grace window.
   */
  noteTurnActivity(): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.pending = null;
    this.generation++;
    return { kind: "cancel" };
  }

  /**
   * A user message starts a genuinely new turn: any held completion is
   * abandoned (the new turn's result will complete instead), and the
   * background flag resets so a plain turn commits with zero grace delay.
   * This is the ONLY place the flag resets besides reset()/processExited —
   * a commit must not clear it, or a premature grace commit would fast-path
   * every later result of the same resume chain into an instant chime.
   */
  userTurnStarted(): CompletionAction {
    this.sawBackgroundActivity = false;
    return this.noteTurnActivity();
  }

  successResult(payload: CompletionPayload): CompletionAction {
    this.pending = null;
    this.generation++;
    if (this.tasks.size > 0) {
      // Intermediate turn: background work still running, the process will
      // auto-resume. Defer everything (caller keeps status "running").
      return { kind: "cancel" };
    }
    if (!this.sawBackgroundActivity) {
      return { kind: "commit", payload };
    }
    this.pending = payload;
    return { kind: "schedule", generation: this.generation };
  }

  errorResult(): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.pending = null;
    this.generation++;
    return { kind: "cancel" };
  }

  graceElapsed(generation: number): CompletionAction {
    if (this.pending === null || generation !== this.generation) {
      return { kind: "none" };
    }
    return this.commitHeld();
  }

  /**
   * The agent process exited. A clean exit with a held completion commits it
   * immediately — the process can never auto-resume again, so waiting for the
   * grace window (or worse, discarding the candidate) would drop the
   * completion entirely. Any other exit discards held state.
   */
  processExited(code: number | null): CompletionAction {
    if (code === 0 && this.pending !== null && this.tasks.size === 0) {
      return this.commitHeld();
    }
    this.reset();
    return { kind: "cancel" };
  }

  /** Full reset (fresh spawn / stop / hibernate / agent switch). */
  reset(): void {
    this.tasks.clear();
    this.pending = null;
    this.generation++;
    this.sawBackgroundActivity = false;
  }

  /** Re-arm the grace window for the held candidate, if any. Task lifecycle
   * events are ambiguous (an orphaned nested-task notification may have no
   * resume behind it), so they delay the commit rather than cancel it. */
  private rearmIfHeld(): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.generation++;
    return { kind: "schedule", generation: this.generation };
  }

  private commitHeld(): CompletionAction {
    const payload = this.pending!;
    this.pending = null;
    this.generation++;
    // sawBackgroundActivity deliberately survives the commit — see
    // userTurnStarted for why.
    return { kind: "commit", payload };
  }
}
