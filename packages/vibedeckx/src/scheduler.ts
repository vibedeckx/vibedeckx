import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import path from "path";
import { Cron } from "croner";
import type { Storage, Executor, ScheduledTask, ScheduledTaskRunStatus } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import type { EventBus } from "./event-bus.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemoteExecutorMonitor } from "./remote-executor-monitor.js";
import type { RemoteExecutorInfo } from "./server-types.js";

/** Max characters of captured output persisted per run. */
const OUTPUT_CAP = 200_000;
/** Run-history rows kept per schedule. */
const RUNS_KEEP = 50;
const CLAIM_LEASE_MS = 30_000;
const CLAIM_HEARTBEAT_MS = 10_000;

function effectFingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Appended to prompt-type schedule content so the agent's final message doubles
 * as a well-formed run report. The final message is captured structurally
 * (claude: stream-json `result` field; codex: --output-last-message file) and
 * persisted to scheduled_task_runs.report — this suffix only shapes its format.
 */
export const REPORT_INSTRUCTION =
  "\n\n---\nWhen the task is complete, end your final message with a concise Markdown report: what you did, files changed, key results, and any problems encountered.";

/** Prompt runs get the report-format instruction; command runs are untouched. */
function buildRunContent(task: ScheduledTask): string {
  return task.run_type === "prompt" ? task.content + REPORT_INSTRUCTION : task.content;
}

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

export interface SchedulerRemoteDeps {
  reverseConnectManager: ReverseConnectManager;
  remoteExecutorMap: Map<string, RemoteExecutorInfo>;
  remoteExecutorMonitor: RemoteExecutorMonitor;
  /** Injectable for tests; defaults to the real proxyToRemoteAuto. */
  proxy?: typeof proxyToRemoteAuto;
}

export class SchedulerService {
  private readonly ownerToken = randomUUID();
  private jobs = new Map<string, Cron>();
  /** scheduleId -> runId of the currently active run (overlap guard). */
  private activeRuns = new Map<string, string>();
  /**
   * scheduleId -> cleanup for the in-flight run's timeout timer + process
   * subscription. Registered when a run starts, removed when it finalizes.
   * shutdown() invokes and clears all of these so no orphaned timer can fire
   * (and write a bogus 'timeout' status) after the service has stopped.
   */
  private activeRunCleanups = new Map<string, () => void>();
  private eventBus?: EventBus;
  private stopped = false;

  constructor(
    private storage: Storage,
    private processManager: ProcessManager,
    private remote?: SchedulerRemoteDeps,
  ) {}

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Schedule all enabled tasks. Call once at startup. */
  async start(): Promise<void> {
    for (const task of await this.storage.scheduledTasks.getAllEnabled()) {
      this.scheduleJob(task);
    }
    console.log(`[Scheduler] Started with ${this.jobs.size} scheduled task(s)`);
  }

  /** (Re)compute the cron job for a schedule after create/update/toggle. */
  async reschedule(scheduleId: string): Promise<void> {
    this.unschedule(scheduleId);
    const task = await this.storage.scheduledTasks.getById(scheduleId);
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

  async runNow(scheduleId: string, runId?: string): Promise<RunNowResult> {
    if (this.stopped) return { error: "Scheduler stopped" };
    return this.executeRun(scheduleId, runId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    // Cancel every in-flight run's timeout timer and process subscription so
    // neither can fire after shutdown (an orphaned timer would otherwise call
    // processManager.stop() and write a 'timeout' row post-close). We
    // deliberately do NOT write a terminal status here: the row stays
    // 'running' and is marked 'killed' by the sqlite startup fixup on next
    // boot, once the in-flight child processes are killed by
    // ProcessManager.shutdown().
    for (const cleanup of this.activeRunCleanups.values()) cleanup();
    this.activeRunCleanups.clear();
  }

  private scheduleJob(task: ScheduledTask): void {
    try {
      const job = new Cron(task.cron_expr, { timezone: task.timezone, catch: true }, () => {
        if (this.stopped) return;
        void this.executeRun(task.id).then((result) => {
          if ("error" in result) {
            console.error(`[Scheduler] Run of ${task.id} failed to start: ${result.error}`);
          }
        }).catch((err) => {
          console.error(`[Scheduler] Run of ${task.id} threw: ${err}`);
        });
      });
      this.jobs.set(task.id, job);
    } catch (err) {
      // Bad cron/timezone that slipped past route validation must not crash startup.
      console.error(`[Scheduler] Could not schedule ${task.id} (${task.cron_expr}): ${err}`);
    }
  }

  /** Record a run that failed before a process could be spawned. */
  private async failWithoutStart(task: ScheduledTask, runId: string, message: string): Promise<RunNowResult> {
    const existing = await this.storage.scheduledTaskRuns.getById(runId);
    if (existing && existing.schedule_id !== task.id) return { error: "Run identity is already in use" };
    if (!existing) await this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: task.id });
    await this.storage.scheduledTaskRuns.finish(runId, { status: "failed", output: message });
    await this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
    this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status: "failed", exitCode: null });
    return { error: message };
  }

  private async executeRun(scheduleId: string, preallocatedRunId?: string): Promise<RunNowResult> {
    const task = await this.storage.scheduledTasks.getById(scheduleId);
    if (!task) return { error: "Schedule not found" };

    const runId = preallocatedRunId ?? randomUUID();

    // Fast in-process guard. The durable claim below is authoritative across
    // service instances/restarts; this also prevents a concurrent retry of
    // the *same* starting run from racing its own markRunning step.
    const activeRunId = this.activeRuns.get(scheduleId);
    if (activeRunId) {
      if (activeRunId === runId) return { runId, skipped: false };
      await this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "skipped" });
      await this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status: "skipped", exitCode: null });
      return { runId, skipped: true };
    }

    if (task.target !== "local") {
      return this.executeRemoteRun(task, runId);
    }

    // Resolve the working directory.
    let cwd: string;
    if (task.cwd_mode === "directory") {
      if (!task.directory || !path.isAbsolute(task.directory)) {
        return this.failWithoutStart(task, runId, `Schedule directory must be an absolute path: ${task.directory ?? "(unset)"}`);
      }
      cwd = task.directory;
    } else {
      const project = await this.storage.projects.getById(task.project_id);
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
      command: buildRunContent(task),
      executor_type: task.run_type,
      prompt_provider: task.run_type === "prompt" ? (task.prompt_provider ?? "claude") : null,
      cwd: null,
      pty: true,
      position: 0,
      disabled_targets: [],
      created_at: new Date().toISOString(),
    };

    const claimedProcessId = `schedule-run-${runId}`;
    const fingerprint = effectFingerprint({ projectId: task.project_id, scheduleId, runId, path: cwd,
      command: executor.command, target: "local", executorType: executor.executor_type,
      provider: executor.prompt_provider });
    const claim = await this.storage.scheduledTaskRuns.claimStart({
      id: runId, scheduleId, processId: claimedProcessId, ownerToken: this.ownerToken,
      effectFingerprint: fingerprint, leaseMs: CLAIM_LEASE_MS,
    });
    if (claim === "conflict") return { error: "Run identity is already in use" };
    if (claim === "existing") {
      const existing = await this.storage.scheduledTaskRuns.getById(runId);
      return { runId, skipped: existing?.status === "skipped" };
    }
    if (claim === "occupied") {
      await this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: scheduleId, status: "skipped" });
      await this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status: "skipped", exitCode: null });
      return { runId, skipped: true };
    }
    let ownershipLost = false;
    let ownedProcessId: string | undefined;
    const renewOwnership = async () => {
      try {
        const renewed = await this.storage.scheduledTaskRuns.heartbeat(runId, this.ownerToken, CLAIM_LEASE_MS);
        if (!renewed) ownershipLost = true;
      } catch { ownershipLost = true; }
      return !ownershipLost;
    };
    const heartbeat = setInterval(() => { void renewOwnership().then((owned) => {
      if (!owned && ownedProcessId) void this.processManager.stop(ownedProcessId);
    }); }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref();
    if (!(await renewOwnership())) {
      clearInterval(heartbeat);
      return { error: "Scheduled execution ownership was lost" };
    }
    this.activeRuns.set(scheduleId, runId);

    let processId: string;
    try {
      processId = await this.processManager.start(executor, cwd, true, claimedProcessId, fingerprint);
      ownedProcessId = processId;
    } catch (err) {
      clearInterval(heartbeat);
      this.activeRuns.delete(scheduleId);
      return this.failWithoutStart(task, runId, `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (ownershipLost || !(await renewOwnership())) {
      await this.processManager.stop(processId);
      clearInterval(heartbeat);
      this.activeRuns.delete(scheduleId);
      return { error: "Scheduled execution ownership was lost" };
    }

    if (processId !== claimedProcessId) {
      await this.processManager.stop(processId);
      clearInterval(heartbeat);
      this.activeRuns.delete(scheduleId);
      return this.failWithoutStart(task, runId, "Failed to confirm the scheduled process claim");
    }
    if (!(await this.storage.scheduledTaskRuns.markRunning(runId, claimedProcessId, claimedProcessId, this.ownerToken))) {
      await this.processManager.stop(processId);
      clearInterval(heartbeat);
      this.activeRuns.delete(scheduleId);
      return { error: "Scheduled execution ownership was lost" };
    }
    this.eventBus?.emit({ type: "schedule:run-started", projectId: task.project_id, scheduleId, runId });

    let output = "";
    let finalized = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | null = null;

    // Cancels the timeout timer + process subscription without touching
    // storage or the event bus. Shared by the normal finalize path and by
    // shutdown()'s abort path so both leave no dangling timer/subscription.
    const releaseRunResources = () => {
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      unsubscribe?.();
    };

    const finalize = async (status: ScheduledTaskRunStatus, exitCode: number | null, report?: string) => {
      if (finalized) return;
      if (ownershipLost) {
        finalized = true;
        releaseRunResources();
        this.activeRuns.delete(scheduleId);
        this.activeRunCleanups.delete(scheduleId);
        return;
      }
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(scheduleId);
      this.activeRunCleanups.delete(scheduleId);
      await this.storage.scheduledTaskRuns.finish(runId, { status, exit_code: exitCode, output: output.slice(-OUTPUT_CAP), report: report?.slice(0, OUTPUT_CAP) ?? null });
      await this.storage.scheduledTaskRuns.prune(scheduleId, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId, runId, status, exitCode });
    };

    unsubscribe = this.processManager.subscribe(processId, (msg: LogMessage) => {
      if (msg.type === "stdout" || msg.type === "stderr" || msg.type === "pty") {
        output += msg.data;
        // Trim lazily at 2x cap to avoid re-slicing on every chunk.
        if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
      } else if (msg.type === "finished") {
        void finalize(msg.exitCode === 0 ? "completed" : "failed", msg.exitCode, msg.finalResult).catch((err) => {
          console.error(`[Scheduler] finalize failed for run ${runId}: ${err}`);
        });
      }
    });
    if (!unsubscribe) {
      // Process vanished before we could observe it — should not happen
      // (subscribe runs in the same tick as start), but don't leak activeRuns.
      await finalize("failed", null);
      return { runId, skipped: false };
    }

    timer = setTimeout(() => {
      void (async () => {
        await this.processManager.stop(processId);
        await finalize("timeout", null);
      })().catch((err) => {
        console.error(`[Scheduler] timeout handling failed for run ${runId}: ${err}`);
      });
    }, task.timeout_seconds * 1000);
    timer.unref(); // don't hold the event loop open for a sleeping timer

    // Registered so shutdown() can cancel this run's timer/subscription
    // instead of letting it fire (and touch storage) after teardown.
    this.activeRunCleanups.set(scheduleId, () => {
      if (finalized) return;
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(scheduleId);
      this.activeRunCleanups.delete(scheduleId);
      // Deliberately no storage.finish()/eventBus.emit() here — see shutdown().
    });

    return { runId, skipped: false };
  }

  private async executeRemoteRun(task: ScheduledTask, runId: string): Promise<RunNowResult> {
    if (!this.remote) {
      return this.failWithoutStart(task, runId, "Remote execution is not configured on this server");
    }
    const remoteConfig = await this.storage.projectRemotes.getByProjectAndServer(task.project_id, task.target);
    if (!remoteConfig) {
      return this.failWithoutStart(task, runId, `Remote server config not found for target ${task.target}`);
    }

    // Derive the remote working-directory args from cwd_mode.
    let remotePath: string;
    let remoteBranch: string | null;
    if (task.cwd_mode === "directory") {
      if (!task.directory || !path.isAbsolute(task.directory)) {
        return this.failWithoutStart(task, runId, `Schedule directory must be an absolute path: ${task.directory ?? "(unset)"}`);
      }
      remotePath = task.directory;
      remoteBranch = null;
    } else {
      remotePath = remoteConfig.remote_path;
      remoteBranch = task.branch;
    }

    const proxy = this.remote.proxy ?? proxyToRemoteAuto;
    const claimedProcessId = `schedule-run-${runId}`;
    const command = buildRunContent(task);
    const fingerprint = effectFingerprint({ projectId: task.project_id, scheduleId: task.id, runId,
      path: remotePath, command, target: task.target, executorType: task.run_type,
      provider: task.run_type === "prompt" ? (task.prompt_provider ?? "claude") : null,
      branch: remoteBranch });
    const claim = await this.storage.scheduledTaskRuns.claimStart({
      id: runId, scheduleId: task.id, processId: claimedProcessId, ownerToken: this.ownerToken,
      effectFingerprint: fingerprint, leaseMs: CLAIM_LEASE_MS,
    });
    if (claim === "conflict") return { error: "Run identity is already in use" };
    if (claim === "existing") {
      const existing = await this.storage.scheduledTaskRuns.getById(runId);
      return { runId, skipped: existing?.status === "skipped" };
    }
    if (claim === "occupied") {
      await this.storage.scheduledTaskRuns.create({ id: runId, schedule_id: task.id, status: "skipped" });
      await this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status: "skipped", exitCode: null });
      return { runId, skipped: true };
    }
    let ownershipLost = false;
    let ownedRemoteProcessId: string | undefined;
    const renewOwnership = async () => {
      try {
        const renewed = await this.storage.scheduledTaskRuns.heartbeat(runId, this.ownerToken, CLAIM_LEASE_MS);
        if (!renewed) ownershipLost = true;
      } catch { ownershipLost = true; }
      return !ownershipLost;
    };
    const heartbeat = setInterval(() => { void renewOwnership().then((owned) => {
      if (!owned && ownedRemoteProcessId) void proxy(task.target, "POST",
        `/api/executor-processes/${ownedRemoteProcessId}/stop`, undefined,
        { reverseConnectManager: this.remote!.reverseConnectManager }).catch(() => undefined);
    }); }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref();
    if (!(await renewOwnership())) {
      clearInterval(heartbeat);
      return { error: "Scheduled execution ownership was lost" };
    }
    this.activeRuns.set(task.id, runId);

    let result;
    try {
      result = await proxy(
        task.target, "POST", "/api/path/execute",
        {
          path: remotePath,
          command,
          executor_type: task.run_type,
          prompt_provider: task.run_type === "prompt" ? (task.prompt_provider ?? "claude") : null,
          branch: remoteBranch ?? undefined,
          pty: true,
          processId: claimedProcessId,
          effectFingerprint: fingerprint,
        },
        { reverseConnectManager: this.remote.reverseConnectManager },
      );
    } catch (err) {
      clearInterval(heartbeat);
      this.activeRuns.delete(task.id);
      return this.failWithoutStart(task, runId, `Remote start failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const processId = (result.data as { processId?: unknown } | null)?.processId;
    if (!result.ok || typeof processId !== "string") {
      clearInterval(heartbeat);
      this.activeRuns.delete(task.id);
      return this.failWithoutStart(task, runId, `Remote start rejected (status ${result.status})`);
    }
    const remoteProcessId = processId;
    ownedRemoteProcessId = remoteProcessId;
    if (ownershipLost || !(await renewOwnership())) {
      await proxy(task.target, "POST", `/api/executor-processes/${remoteProcessId}/stop`, undefined,
        { reverseConnectManager: this.remote.reverseConnectManager }).catch(() => undefined);
      clearInterval(heartbeat);
      this.activeRuns.delete(task.id);
      return { error: "Scheduled execution ownership was lost" };
    }
    const localProcessId = `remote-schedule-${task.id}-${remoteProcessId}`;

    const remoteInfo: RemoteExecutorInfo = {
      remoteServerId: task.target,
      remoteProcessId,
      executorId: `schedule-${task.id}`,
      projectId: task.project_id,
    };
    this.remote.remoteExecutorMap.set(localProcessId, remoteInfo);
    this.remote.remoteExecutorMonitor.watch(localProcessId, remoteInfo);

    if (!(await this.storage.scheduledTaskRuns.markRunning(runId, claimedProcessId, localProcessId, this.ownerToken))) {
      await proxy(task.target, "POST", `/api/executor-processes/${remoteProcessId}/stop`, undefined,
        { reverseConnectManager: this.remote.reverseConnectManager }).catch(() => undefined);
      this.remote.remoteExecutorMap.delete(localProcessId);
      clearInterval(heartbeat);
      this.activeRuns.delete(task.id);
      return { error: "Scheduled execution ownership was lost" };
    }
    this.eventBus?.emit({ type: "schedule:run-started", projectId: task.project_id, scheduleId: task.id, runId });

    let finalized = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const releaseRunResources = () => {
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      unsubscribe?.();
    };

    const finalize = async (status: ScheduledTaskRunStatus, exitCode: number | null, output: string, report?: string) => {
      if (finalized) return;
      if (ownershipLost) {
        finalized = true;
        releaseRunResources();
        this.activeRuns.delete(task.id);
        this.activeRunCleanups.delete(task.id);
        return;
      }
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(task.id);
      this.activeRunCleanups.delete(task.id);
      await this.storage.scheduledTaskRuns.finish(runId, { status, exit_code: exitCode, output: output.slice(-OUTPUT_CAP), report: report?.slice(0, OUTPUT_CAP) ?? null });
      await this.storage.scheduledTaskRuns.prune(task.id, RUNS_KEEP);
      this.eventBus?.emit({ type: "schedule:run-finished", projectId: task.project_id, scheduleId: task.id, runId, status, exitCode });
    };

    // Remote processes are not in the local ProcessManager; RemoteExecutorMonitor
    // emits executor:stopped on the bus when the remote finishes (with tailOutput
    // and, when the remote is new enough to forward it, the agent's finalResult).
    unsubscribe = this.eventBus?.subscribe((e) => {
      if (e.type === "executor:stopped" && e.processId === localProcessId) {
        void finalize(e.exitCode === 0 ? "completed" : "failed", e.exitCode, e.tailOutput ?? "", e.finalResult).catch((err) => {
          console.error(`[Scheduler] finalize failed for run ${runId}: ${err}`);
        });
      }
    });

    timer = setTimeout(() => {
      void proxy(
        task.target, "POST",
        `/api/executor-processes/${remoteProcessId}/stop`, undefined,
        { reverseConnectManager: this.remote!.reverseConnectManager },
      ).catch(() => {});
      void finalize("timeout", null, "").catch((err) => {
        console.error(`[Scheduler] timeout finalize failed for run ${runId}: ${err}`);
      });
    }, task.timeout_seconds * 1000);
    timer.unref();

    this.activeRunCleanups.set(task.id, () => {
      if (finalized) return;
      finalized = true;
      releaseRunResources();
      this.activeRuns.delete(task.id);
      this.activeRunCleanups.delete(task.id);
    });

    return { runId, skipped: false };
  }
}
