import { randomUUID } from "crypto";
import { existsSync } from "fs";
import path from "path";
import { Cron } from "croner";
import type { Storage, Executor, ScheduledTask, ScheduledTaskRunStatus } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import type { EventBus } from "./event-bus.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

/** Max characters of captured output persisted per run. */
const OUTPUT_CAP = 200_000;
/** Run-history rows kept per schedule. */
const RUNS_KEEP = 50;

/** Returns an error message, or null when the expression (and timezone) are valid. */
export function validateCron(expr: string, timezone?: string): string | null {
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return `Invalid timezone: ${timezone}`;
    }
  }
  try {
    const job = new Cron(expr, { paused: true, timezone });
    job.stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export type RunNowResult = { runId: string; skipped: boolean } | { error: string };

export class SchedulerService {
  private jobs = new Map<string, Cron>();
  /** scheduleId -> runId of the currently active run (overlap guard). */
  private activeRuns = new Map<string, string>();
  private eventBus?: EventBus;
  private stopped = false;

  constructor(
    private storage: Storage,
    private processManager: ProcessManager,
  ) {}

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Schedule all enabled tasks. Call once at startup. */
  start(): void {
    for (const task of this.storage.scheduledTasks.getAllEnabled()) {
      this.scheduleJob(task);
    }
    console.log(`[Scheduler] Started with ${this.jobs.size} scheduled task(s)`);
  }

  /** (Re)compute the cron job for a schedule after create/update/toggle. */
  reschedule(scheduleId: string): void {
    this.unschedule(scheduleId);
    const task = this.storage.scheduledTasks.getById(scheduleId);
    if (task && task.enabled) {
      this.scheduleJob(task);
    }
  }

  unschedule(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
    }
  }

  nextRunAt(scheduleId: string): string | null {
    return this.jobs.get(scheduleId)?.nextRun()?.toISOString() ?? null;
  }

  isRunning(scheduleId: string): boolean {
    return this.activeRuns.has(scheduleId);
  }

  runNow(scheduleId: string): RunNowResult {
    return this.executeRun(scheduleId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    // In-flight child processes are killed by ProcessManager.shutdown();
    // their run rows are marked 'killed' by the sqlite startup fixup on next boot.
  }

  private scheduleJob(task: ScheduledTask): void {
    try {
      const job = new Cron(task.cron_expr, { timezone: task.timezone, catch: true }, () => {
        if (this.stopped) return;
        const result = this.executeRun(task.id);
        if ("error" in result) {
          console.error(`[Scheduler] Run of ${task.id} failed to start: ${result.error}`);
        }
      });
      this.jobs.set(task.id, job);
    } catch (err) {
      // Bad cron/timezone that slipped past route validation must not crash startup.
      console.error(`[Scheduler] Could not schedule ${task.id} (${task.cron_expr}): ${err}`);
    }
  }

  /** Record a run that failed before a process could be spawned. */
  private failWithoutStart(task: ScheduledTask, runId: string, message: string): RunNowResult {
    this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: task.id });
    this.storage.scheduledTaskRuns.finish(runId, { status: "failed", output: message });
    this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
    this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status: "failed", exitCode: null });
    return { error: message };
  }

  private executeRun(scheduleId: string): RunNowResult {
    const task = this.storage.scheduledTasks.getById(scheduleId);
    if (!task) return { error: "Schedule not found" };

    const runId = randomUUID();

    // Overlap policy: skip (recorded) when the previous run is still going.
    if (this.activeRuns.has(scheduleId)) {
      this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "skipped" });
      this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      return { runId, skipped: true };
    }

    // Resolve the working directory.
    let cwd: string;
    if (task.cwd_mode === "directory") {
      if (!task.directory || !path.isAbsolute(task.directory)) {
        return this.failWithoutStart(task, runId, `Schedule directory must be an absolute path: ${task.directory ?? "(unset)"}`);
      }
      cwd = task.directory;
    } else {
      const project = this.storage.projects.getById(task.project_id);
      if (!project?.path) {
        return this.failWithoutStart(task, runId, "Project has no local path");
      }
      try {
        cwd = resolveWorktreePath(project.path, task.branch);
      } catch (err) {
        return this.failWithoutStart(task, runId, `Could not resolve worktree for branch ${task.branch}: ${err}`);
      }
    }
    if (!existsSync(cwd)) {
      return this.failWithoutStart(task, runId, `Working directory does not exist: ${cwd}`);
    }

    // Fabricated executor — same shape a UI command/prompt executor has, so
    // ProcessManager applies its normal dispatch (command -> PTY; prompt ->
    // claude stream-json with readable formatted log output). skipDb=true keeps
    // ProcessManager from writing executor_processes rows (FK-bound to real
    // executors); our run history lives in scheduled_task_runs instead.
    const executor: Executor = {
      id: `schedule-${task.id}`,
      project_id: task.project_id,
      group_id: "",
      name: task.name,
      command: task.content,
      executor_type: task.run_type,
      prompt_provider: task.run_type === "prompt" ? "claude" : null,
      cwd: null,
      pty: true,
      position: 0,
      disabled_targets: [],
      created_at: new Date().toISOString(),
    };

    let processId: string;
    try {
      processId = this.processManager.start(executor, cwd, true);
    } catch (err) {
      return this.failWithoutStart(task, runId, `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "running", process_id: processId });
    this.activeRuns.set(scheduleId, runId);
    this.eventBus?.emit({ type: "schedule:run-started", projectId: task.project_id, scheduleId, runId });

    let output = "";
    let finalized = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | null = null;

    const finalize = (status: ScheduledTaskRunStatus, exitCode: number | null) => {
      if (finalized) return;
      finalized = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      this.activeRuns.delete(scheduleId);
      this.storage.scheduledTaskRuns.finish(runId, { status, exit_code: exitCode, output: output.slice(-OUTPUT_CAP) });
      this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status, exitCode });
    };

    unsubscribe = this.processManager.subscribe(processId, (msg: LogMessage) => {
      if (msg.type === "stdout" || msg.type === "stderr" || msg.type === "pty") {
        output += msg.data;
        // Trim lazily at 2x cap to avoid re-slicing on every chunk.
        if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
      } else if (msg.type === "finished") {
        finalize(msg.exitCode === 0 ? "completed" : "failed", msg.exitCode);
      }
    });
    if (!unsubscribe) {
      // Process vanished before we could observe it — should not happen
      // (subscribe runs in the same tick as start), but don't leak activeRuns.
      finalize("failed", null);
      return { runId, skipped: false };
    }

    timer = setTimeout(() => {
      this.processManager.stop(processId);
      finalize("timeout", null);
    }, task.timeout_seconds * 1000);
    timer.unref(); // don't hold the event loop open for a sleeping timer

    return { runId, skipped: false };
  }
}
