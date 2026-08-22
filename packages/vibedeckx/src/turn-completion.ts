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

/**
 * How long a parked completion waits for its background tasks before it is
 * committed anyway.
 *
 * Parking bets that Claude Code will auto-resume when the task finishes. A
 * task with a faulty exit condition never finishes, so the bet never settles
 * and the session sits at "running" forever with the agent long done. This
 * bound is what makes that failure temporary.
 *
 * 20 minutes: across 1714 background tasks observed in production the longest
 * one that ever finished ran 12 minutes, and none exceeded 20 — so the bound
 * clears real work by a wide margin. Expiring early is cheap (the turn closes,
 * the task keeps running, a later auto-resume just adds another turn); leaving
 * it unbounded is not.
 */
export const PARK_TIMEOUT_MS = 20 * 60 * 1000;

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

/**
 * A background task the agent launched and has not finished yet. `startedAt`
 * is stamped by the caller (the ledger stays clock-free) the first time a task
 * id is seen, and deliberately survives snapshot resyncs — the harness pushes
 * a fresh snapshot on every change, so re-stamping would reset the elapsed
 * time the UI shows.
 */
export interface BackgroundTask {
  taskId: string;
  taskType?: string;
  description?: string;
  startedAt: number;
  /**
   * The user vouched for this task ("keep waiting"), so it no longer counts
   * toward the park deadline. Set through {@link TurnCompletionLedger.sanction}
   * and reported so the UI can say why the countdown stopped.
   */
  sanctioned?: boolean;
}

/** The subset of {@link BackgroundTask} the harness reports; no timestamp. */
export type BackgroundTaskDescriptor = Omit<BackgroundTask, "startedAt" | "sanctioned">;

export class TurnCompletionLedger {
  /** Live background tasks by harness task_id (same id may restart). */
  private tasks = new Map<string, BackgroundTask>();
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
  /**
   * When the held candidate was parked behind live background tasks — the
   * moment the agent stopped working and only tasks kept the turn open. The
   * park deadline counts from here, not from when a task started: the number
   * that matters to the user is "how long since the agent answered".
   */
  private parkedSince: number | null = null;
  /** Task ids the user vouched for; they stop counting toward the deadline. */
  private sanctioned = new Set<string>();
  /**
   * Whether a park deadline already expired and closed the turn. Live tasks
   * normally shield the session from being reclaimed — hibernating would kill
   * a real build and the auto-resume that reads it — but that shield must not
   * outlast the deadline, or one stuck task pins a resident process slot
   * forever and new sessions on the branch get turned away.
   */
  private parkDeadlineExpired = false;

  constructor(private readonly parkTimeoutMs: number = PARK_TIMEOUT_MS) {}

  get pendingTaskCount(): number {
    return this.tasks.size;
  }

  get hasPendingCompletion(): boolean {
    return this.pending !== null;
  }

  /** Live tasks in first-seen order — the payload the UI renders. */
  get backgroundTasks(): BackgroundTask[] {
    return [...this.tasks.values()].map((task) =>
      this.sanctioned.has(task.taskId) ? { ...task, sanctioned: true } : task,
    );
  }

  /**
   * When the parked turn will be committed anyway, or null if nothing is
   * parked or every live task has been vouched for. Timer-free by design: the
   * caller re-reads this after each mutation and syncs its own timer, so the
   * ledger stays a pure state machine.
   */
  get parkDeadlineAt(): number | null {
    if (this.pending === null || this.parkedSince === null) return null;
    const allVouchedFor = [...this.tasks.keys()].every((id) => this.sanctioned.has(id));
    return allVouchedFor ? null : this.parkedSince + this.parkTimeoutMs;
  }

  /**
   * The user vouched for a task: stop counting it toward the deadline. This
   * restores the original behavior for that task — wait for it, let the
   * auto-resume close the turn — but now as an explicit choice.
   */
  sanction(taskId: string): void {
    if (this.tasks.has(taskId)) this.sanctioned.add(taskId);
  }

  /**
   * The deadline expired: commit the parked candidate. Deliberately uses the
   * ORIGINAL payload — its duration/cost/tokens describe the turn the agent
   * actually ran, not the time spent waiting on a stuck task.
   */
  parkDeadlineElapsed(): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.parkDeadlineExpired = true;
    return this.commitHeld();
  }

  /**
   * Whether live background tasks should still shield this session from
   * resident-process reclamation. True while they are plausibly doing real
   * work; false once the deadline judged them anomalous — unless the user
   * vouched for every one of them, which restores the shield along with the
   * waiting behavior it protects.
   */
  get backgroundTasksProtectSession(): boolean {
    if (this.tasks.size === 0) return false;
    if (!this.parkDeadlineExpired) return true;
    return [...this.tasks.keys()].every((id) => this.sanctioned.has(id));
  }

  taskStarted(task: BackgroundTaskDescriptor, now: number): CompletionAction {
    this.upsert(task, this.tasks.get(task.taskId), now);
    this.sawBackgroundActivity = true;
    return this.rearmIfHeld(now);
  }

  taskFinished(taskId: string, now: number): CompletionAction {
    this.tasks.delete(taskId);
    this.sanctioned.delete(taskId);
    this.sawBackgroundActivity = true;
    return this.rearmIfHeld(now);
  }

  /** Authoritative snapshot from `system/background_tasks_changed`. */
  taskListChanged(tasks: BackgroundTaskDescriptor[], now: number): CompletionAction {
    const previous = this.tasks;
    this.tasks = new Map();
    for (const task of tasks) {
      this.upsert(task, previous.get(task.taskId), now);
    }
    // A vouched-for id that left the snapshot is gone; keeping it would let a
    // recycled task id inherit someone else's exemption.
    for (const id of this.sanctioned) {
      if (!this.tasks.has(id)) this.sanctioned.delete(id);
    }
    if (tasks.length > 0) this.sawBackgroundActivity = true;
    return this.rearmIfHeld(now);
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
    this.parkDeadlineExpired = false; // a new turn gets its own deadline
    if (this.pending === null) return { kind: "none" };
    this.pending = null;
    this.parkedSince = null;
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

  successResult(payload: CompletionPayload, now: number): CompletionAction {
    this.generation++;
    if (this.tasks.size > 0) {
      // A fresh answer restarts the clock: "how long since the agent spoke".
      this.parkedSince = now;
      this.parkDeadlineExpired = false;
      // Turn ended while background work is still running. PARK the result
      // (no timer) instead of discarding it: Claude Code auto-resumes when
      // the task completes and the resume supersedes this candidate, but
      // Codex fire-and-forget subagents never resume the main thread — the
      // last task finishing is the only chance to commit this turn.
      this.pending = payload;
      return { kind: "cancel" };
    }
    if (!this.sawBackgroundActivity) {
      this.pending = null;
      return { kind: "commit", payload };
    }
    this.pending = payload;
    return { kind: "schedule", generation: this.generation };
  }

  errorResult(): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.pending = null;
    this.parkedSince = null;
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
    this.sanctioned.clear();
    this.pending = null;
    this.parkedSince = null;
    this.parkDeadlineExpired = false;
    this.generation++;
    this.sawBackgroundActivity = false;
  }

  /** Re-arm or park the held candidate after a task-set change. Task
   * lifecycle events are ambiguous (an orphaned nested-task notification may
   * have no resume behind it), so they delay the commit rather than cancel
   * it — and while tasks are still live the candidate stays parked with no
   * timer at all (only an empty set can complete a turn). */
  private rearmIfHeld(now: number): CompletionAction {
    if (this.pending === null) return { kind: "none" };
    this.generation++;
    if (this.tasks.size > 0) {
      // A task appearing after the result parks the candidate too, and it needs
      // a deadline just as much — otherwise `pending` could sit parked with no
      // bound at all. Only stamp the first park: later task churn must not keep
      // pushing the deadline out, or a session that keeps spawning tasks would
      // never reach it.
      this.parkedSince ??= now;
      return { kind: "cancel" };
    }
    return { kind: "schedule", generation: this.generation };
  }

  /**
   * Merge a descriptor into the live set, keeping the earliest `startedAt` and
   * any label already known: `task_started` carries a description that the
   * snapshot for the same task may omit, and the two arrive in either order.
   * `known` comes from the caller: a snapshot resync rebuilds the map, so the
   * prior entry is no longer reachable through `this.tasks`.
   */
  private upsert(task: BackgroundTaskDescriptor, known: BackgroundTask | undefined, now: number): void {
    this.tasks.set(task.taskId, {
      taskId: task.taskId,
      taskType: task.taskType ?? known?.taskType,
      description: task.description ?? known?.description,
      startedAt: known?.startedAt ?? now,
    });
  }

  private commitHeld(): CompletionAction {
    const payload = this.pending!;
    this.pending = null;
    this.parkedSince = null;
    this.generation++;
    // sawBackgroundActivity deliberately survives the commit — see
    // userTurnStarted for why.
    return { kind: "commit", payload };
  }
}
