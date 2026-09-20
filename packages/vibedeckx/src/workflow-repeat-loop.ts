/**
 * Repeat-until-done loop (the "Ralph loop") — workflow template two.
 * Design: docs/superpowers/specs/2026-09-20-workflow-repeat-until-done-design.md
 *
 * The same instruction runs again and again, each time in a FRESH session that
 * is stopped when its item is done, until a session reports there is nothing
 * left. The engine holds no task list: the truth about what is left lives in
 * the world (an API, a file, a tracker) and every session looks it up itself —
 * so a session is stateless, and an interrupted one costs nothing but a retry.
 *
 * Shape (same trick as the review loop): ONE RUN PER ITERATION, chained by
 * `loop_id`. Settling iteration N and inserting iteration N+1 is one
 * transaction; there is no loop entity, queue or scheduler — everything a
 * restart needs is in `workflow_runs` / `workflow_run_steps`. When the loop
 * needs a human, iteration N+1 is still inserted, as a `waiting_resume` gate
 * whose `error` says why.
 *
 * Iterations advance WITHOUT confirmation (user decision 2026-09-20). What
 * makes that safe is below: brakes, an exact-match closing status where
 * anything unrecognised stops the loop, and no silent stalls — an iteration
 * that ends abnormally puts up a gate and rings the bell.
 */
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import type { AgentMessage, AgentType } from "./agent-types.js";
import type { ActivationResult } from "./agent-session-lifecycle.js";
import { instructionContentHash } from "./instruction-delivery.js";
import { loopMilestoneId } from "./notification-milestones.js";
import type {
  NotificationOutboxEvent, Project, Storage, WorkflowRepeatRunInput, WorkflowRun, WorkflowRunStep, WorkflowTaskStatus,
} from "./storage/types.js";
import { parseClosingLine, parseTaskStatus, TASK_STATUS_INSTRUCTIONS } from "./utils/review-verdict.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import type { AgentOps } from "./workflow-engine.js";

export const REPEAT_MAX_ITERATIONS_DEFAULT = 20;
export const REPEAT_MAX_ITERATIONS_LIMIT = 200;
export const REPEAT_MAX_MINUTES_DEFAULT = 240;
export const REPEAT_MAX_MINUTES_LIMIT = 24 * 60;
const CHECK_COMMAND_TIMEOUT_MS = 5 * 60_000;
const CHECK_OUTPUT_TAIL = 600;
/** A status change can be observed a beat before the turn_end entry is readable. */
const ABNORMAL_END_RECHECK_MS = 1_500;

/** Persisted on every iteration's run row (`workflow_runs.params`), copied forward. */
export interface RepeatLoopParams {
  name: string;
  prompt: string;
  agentType: AgentType;
  model?: string | null;
  /** The user's cap — also the increment a `resume` past the cap adds. */
  maxIterations: number;
  maxMinutes: number;
  checkCommand?: string | null;
  /** Epoch ms the time brake counts from; reset by a resume that was stopped by it. */
  startedAt: number;
  /**
   * The loop's first session. Every milestone is written to ITS outbox and
   * every run update is mirrored onto ITS stream: a hub publishes that one
   * session when the loop starts, so the bell survives hub restarts without
   * the hub having to learn each iteration's session (design §7).
   */
  anchorSessionId: string;
  /** Previous iteration — the session a gate's reason is about. */
  prevSessionId?: string | null;
  prevItem?: string | null;
  remaining?: string | null;
  /** Soft stop: finish the current item, then put up a gate. */
  stopAfterCurrent?: boolean;
}

export interface StartRepeatLoopOptions {
  project: Project;
  branch: string | null;
  name?: string;
  prompt: string;
  agentType?: AgentType;
  model?: string | null;
  maxIterations?: number;
  maxMinutes?: number;
  checkCommand?: string | null;
  /** Stable id from a hub replay of the start request. */
  runId?: string;
}

export class RepeatLoopError extends Error {
  constructor(public code: "session-busy" | "bad-state" | "spawn-failed", message: string) { super(message); }
}

/** What the runner needs from the engine that owns it. */
export interface RepeatLoopHost {
  storage: Storage;
  agentOps: AgentOps;
  emitRunUpdated(run: WorkflowRun): void;
  track(run: WorkflowRun): void;
  untrack(run: WorkflowRun): void;
  milestoneCreated(): void;
  /** Test seam; the default shells out in the worktree. */
  runCheckCommand?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
}

const ITERATION_TURN = { origin: "workflow", notificationDisposition: "milestone-managed" } as const;

export function parseRepeatParams(run: Pick<WorkflowRun, "params">): RepeatLoopParams | null {
  if (!run.params) return null;
  try { return JSON.parse(run.params) as RepeatLoopParams; } catch { return null; }
}

export const taskActivationKey = (runId: string, sessionId: string): string => `task:${runId}:${sessionId}`;

function defaultRunCheckCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd, timeout: CHECK_COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-CHECK_OUTPUT_TAIL);
      resolve({ ok: !error, output: error && !output ? String(error.message).slice(-CHECK_OUTPUT_TAIL) : output });
    });
  });
}

type Settlement =
  | { next: "iterate" }
  | { next: "finished" }
  | { next: "gate"; reason: string; milestone: string | null };

export class RepeatLoopRunner {
  constructor(private readonly host: RepeatLoopHost) {}

  private get storage() { return this.host.storage; }
  private get ops() { return this.host.agentOps; }

  // ---------- start ----------

  async start(opts: StartRepeatLoopOptions): Promise<WorkflowRun> {
    if (opts.runId) {
      const existing = await this.storage.workflowRuns.getById(opts.runId);
      if (existing) return existing;
    }
    if (!opts.project.path) throw new RepeatLoopError("bad-state", "项目没有本地路径，无法运行循环");
    const active = await this.storage.workflowRuns.getActive(opts.project.id, opts.branch);
    if (active.some((r) => r.kind === "repeat")) {
      throw new RepeatLoopError("session-busy", "这个 workspace 已有一个进行中的循环，请先结束它");
    }
    const id = opts.runId ?? randomUUID();
    const sessionId = randomUUID();
    const maxIterations = opts.maxIterations ?? REPEAT_MAX_ITERATIONS_DEFAULT;
    const params: RepeatLoopParams = {
      name: opts.name?.trim() || "Loop",
      prompt: opts.prompt,
      agentType: opts.agentType ?? "claude-code",
      model: opts.model ?? null,
      maxIterations,
      maxMinutes: opts.maxMinutes ?? REPEAT_MAX_MINUTES_DEFAULT,
      checkCommand: opts.checkCommand?.trim() || null,
      startedAt: Date.now(),
      anchorSessionId: sessionId,
    };
    const run = await this.storage.workflowRuns.create({
      id, project_id: opts.project.id, branch: opts.branch,
      source_session_id: sessionId, source_turn_end_index: -1,
      review_focus: null, review_target: null,
      status: "preparing", kind: "repeat", params: JSON.stringify(params),
      loop_id: id, round: 1, max_rounds: maxIterations,
    });
    this.host.track(run);
    this.host.emitRunUpdated(run);
    return this.dispatchIteration(run.id);
  }

  // ---------- dispatch ----------

  /**
   * prepare → title → open step → activate → CAS `preparing → running_task`.
   * The run is re-read after every await that a cancel can interleave with;
   * a run that left `preparing` on the way gets its session torn down.
   * A dispatch that cannot start turns the SAME run into a resume gate — it
   * dispatched nothing, so there is nothing to settle.
   */
  async dispatchIteration(runId: string): Promise<WorkflowRun> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run || run.status !== "preparing") return run!;
    const params = parseRepeatParams(run);
    if (!params) return this.toGateInPlace(run, "循环参数损坏，无法派发");
    const sessionId = run.source_session_id;
    const key = taskActivationKey(run.id, sessionId);

    let outcome: ActivationResult;
    let step: WorkflowRunStep;
    try {
      const prepared = await this.ops.prepareReviewer({
        operationId: key, sessionId,
        projectId: run.project_id, branch: run.branch,
        permissionMode: "edit", agentType: params.agentType, model: params.model ?? null,
        purpose: "workflow_task", owner: { kind: "workflow_run", id: run.id },
      });
      if (prepared.kind !== "prepared" && prepared.kind !== "replayed") {
        return this.toGateInPlace(run, `无法创建迭代 session：${prepared.kind}`);
      }
      if (!(await this.stillPreparing(run.id))) { await this.tearDown(run); return (await this.storage.workflowRuns.getById(run.id))!; }

      await this.ops.setFinalSessionTitle(sessionId, `${params.name} #${run.round}`)
        .catch((err) => console.warn(`[RepeatLoop] title for ${sessionId} failed:`, err));

      const instruction = `${params.prompt}\n${TASK_STATUS_INSTRUCTIONS}`;
      step = (await this.storage.workflowRunSteps.open({
        id: randomUUID(), run_id: run.id, role: "source", kind: "task_prompt", session_id: sessionId,
        idempotency_key: key, payload_hash: instructionContentHash(instruction),
      })).step;
      outcome = await this.ops.activateReviewer({
        sessionId, activationKey: key, instruction, ...ITERATION_TURN, announceRunning: true,
      });
    } catch (err) {
      return this.toGateInPlace(run, `派发迭代失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if ((outcome.kind === "activated" || outcome.kind === "replayed" || outcome.kind === "uncertain")
        && outcome.view.userEntryIndex !== null) {
      await this.storage.workflowRunSteps.setUserEntryIndex(step.id, outcome.view.userEntryIndex);
    }
    let note: string | null = null;
    switch (outcome.kind) {
      case "activated":
      case "replayed":
        break;
      case "in_progress":
        return (await this.storage.workflowRuns.getById(run.id))!;
      case "uncertain":
        // Durable prompt, unprovable stdin. Never re-send; if the session did
        // start, its completion is still attributed (step stays dispatched).
        note = "这次迭代的指令投递结果未知：服务在投递期间中断。若 session 没有开始工作，请结束循环后重新发起。";
        break;
      default:
        return this.toGateInPlace(run, `无法启动迭代 session：${outcome.kind}`);
    }
    const started = await this.storage.workflowRuns.transition(run.id, "preparing", "running_task", { error: note });
    if (!started) { await this.tearDown(run); return (await this.storage.workflowRuns.getById(run.id))!; }
    const updated = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.emitRunUpdated(updated);
    return updated;
  }

  private async stillPreparing(runId: string): Promise<boolean> {
    return (await this.storage.workflowRuns.getById(runId))?.status === "preparing";
  }

  /** The run was cancelled while its session was being brought up. */
  private async tearDown(run: WorkflowRun): Promise<void> {
    await this.storage.workflowRunSteps.abandonOpenByRun(run.id, "run left preparing during dispatch");
    await this.ops.cancelReviewer({ sessionId: run.source_session_id, reason: "cancelled" }).catch(() => undefined);
    await this.ops.stopSession?.(run.source_session_id).catch(() => undefined);
  }

  /** `preparing → waiting_resume` on the same row, with the bell: nobody may be watching. */
  private async toGateInPlace(run: WorkflowRun, reason: string): Promise<WorkflowRun> {
    const params = parseRepeatParams(run);
    const moved = await this.storage.workflowRuns.transitionWithOutbox(
      run.id, "preparing", "waiting_resume", { error: reason },
      this.outbox(run, params?.anchorSessionId ?? run.source_session_id, "workflow_failed", "dispatch-failed"),
    );
    if (moved) {
      await this.storage.workflowRunSteps.abandonOpenByRun(run.id, "dispatch failed");
      await this.ops.cancelReviewer({ sessionId: run.source_session_id, reason: "owner_failed" }).catch(() => undefined);
      this.host.milestoneCreated();
    }
    const updated = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.emitRunUpdated(updated);
    return updated;
  }

  // ---------- settlement ----------

  /**
   * The iteration's turn completed and was attributed to its `task_prompt`
   * step. Settle it and decide the next hop — in ONE transaction.
   */
  async onTaskTurnCompleted(step: WorkflowRunStep, entries: AgentMessage[], boundary: number, output: string | null): Promise<void> {
    const run = await this.storage.workflowRuns.getById(step.run_id);
    const params = run ? parseRepeatParams(run) : null;
    if (!run || !params || run.status !== "running_task") {
      // Cancelled (or otherwise gone) while the turn ran: keep the evidence, move nothing.
      await this.storage.workflowRuns.claimStepAndTransition({ stepId: step.id, turnEndIndex: boundary, outputSnapshot: output });
      return;
    }

    let status: WorkflowTaskStatus | null = parseTaskStatus(output);
    const item = parseClosingLine(output, "Item");
    const remaining = parseClosingLine(output, "Remaining");
    let checkFailure: string | null = null;
    if (params.checkCommand && (status === "continue" || status === "done")) {
      // The session's own checkout first (same preference as review target
      // capture); the conventional path is the fallback.
      const projection = await this.storage.agentSessions.getActivityById(run.source_session_id, "workflow-reviewer");
      const project = await this.storage.projects.getById(run.project_id);
      const cwd = projection?.worktreePath ?? (project?.path ? resolveWorktreePath(project.path, run.branch) : null);
      const check = cwd
        ? await (this.host.runCheckCommand ?? defaultRunCheckCommand)(params.checkCommand, cwd)
        : { ok: false, output: "project has no local path" };
      if (!check.ok) checkFailure = `检查命令未通过：${check.output || "(no output)"}`;
    }

    const settlement = this.settle(run, params, status, item, checkFailure);
    const nextParams: RepeatLoopParams = {
      ...params, prevSessionId: run.source_session_id, prevItem: item, remaining, stopAfterCurrent: false,
    };
    const insertRun: WorkflowRepeatRunInput | undefined = settlement.next === "finished" ? undefined : {
      id: randomUUID(), project_id: run.project_id, branch: run.branch,
      source_session_id: randomUUID(), loop_id: run.loop_id, round: run.round + 1, max_rounds: run.max_rounds,
      params: JSON.stringify(nextParams),
      status: settlement.next === "iterate" ? "preparing" : "waiting_resume",
      error: settlement.next === "gate" ? settlement.reason : null,
    };
    const outbox = settlement.next === "finished"
      ? this.outbox(run, params.anchorSessionId, "loop_done", "done")
      : settlement.next === "gate" && settlement.milestone
        ? this.outbox(run, params.anchorSessionId, "workflow_failed", settlement.milestone)
        : undefined;

    const settled = await this.storage.workflowRuns.claimStepAndTransition({
      stepId: step.id, turnEndIndex: boundary, outputSnapshot: output,
      run: {
        id: run.id, from: "running_task", to: "completed",
        patch: { outcome_status: status, feedback_snapshot: output, error: checkFailure },
        outbox,
      },
      insertRun,
    });
    if (!settled) return;

    const done = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.untrack(done);
    this.host.emitRunUpdated(done);
    if (outbox) this.host.milestoneCreated();

    // A session that needs a human stays up — the user will want to look, and
    // probably keep talking. Everything else is stopped: one item per session.
    const keepSession = settlement.next === "gate" && (status === "blocked" || status === null || checkFailure !== null);
    if (!keepSession) await this.stop(run.source_session_id);

    if (!insertRun) return;
    const next = (await this.storage.workflowRuns.getById(insertRun.id))!;
    this.host.track(next);
    this.host.emitRunUpdated(next);
    if (next.status === "preparing") {
      await this.dispatchIteration(next.id).catch((err) => console.error("[RepeatLoop] dispatch failed:", err));
    }
  }

  private settle(
    run: WorkflowRun, params: RepeatLoopParams, status: WorkflowTaskStatus | null, item: string | null, checkFailure: string | null,
  ): Settlement {
    if (checkFailure) return { next: "gate", reason: checkFailure, milestone: "check-failed" };
    if (status === "done") return { next: "finished" };
    if (status === "blocked") return { next: "gate", reason: "这次迭代报告 blocked：需要你处理后再继续。", milestone: "blocked" };
    if (status === null) {
      return { next: "gate", reason: "无法识别这次迭代结尾的 Status 字段（应为 continue / done / blocked 之一），已停下等你判断。", milestone: "unrecognised" };
    }
    // continue — the brakes.
    if (params.stopAfterCurrent) return { next: "gate", reason: "已按你的要求在这一项完成后暂停。", milestone: null };
    if (run.max_rounds !== null && run.round >= run.max_rounds) {
      return { next: "gate", reason: `已达迭代上限（${run.max_rounds} 次）。继续将再追加 ${params.maxIterations} 次。`, milestone: "max-iterations" };
    }
    if (Date.now() - params.startedAt > params.maxMinutes * 60_000) {
      return { next: "gate", reason: `已达时长上限（${params.maxMinutes} 分钟）。继续将重新计时。`, milestone: "max-minutes" };
    }
    if (item && params.prevItem && item === params.prevItem) {
      return { next: "gate", reason: `连续两次迭代处理的是同一项（${item}）——可能没有进展。`, milestone: "no-progress" };
    }
    return { next: "iterate" };
  }

  // ---------- abnormal end ----------

  /**
   * `session:taskCompleted` fires for completed turns only; a failed, stopped
   * or crashed turn tells the engine nothing. Unattended, that would be a
   * silent stall — so a session going idle with an open `task_prompt` step is
   * checked against its transcript.
   */
  async onSessionIdle(sessionId: string, recheck = true): Promise<void> {
    const open = (await this.storage.workflowRunSteps.getOpenBySession(sessionId)).filter((s) => s.kind === "task_prompt");
    for (const step of open) {
      const index = await this.entryIndexOf(step);
      if (index === null) continue; // dispatch still in flight
      const entries = await this.ops.getRawMessages(sessionId);
      const turnEnd = entries.slice(index + 1).find((e) => e?.type === "turn_end") as Extract<AgentMessage, { type: "turn_end" }> | undefined;
      if (!turnEnd) {
        if (recheck) setTimeout(() => void this.onSessionIdle(sessionId, false).catch(() => undefined), ABNORMAL_END_RECHECK_MS).unref();
        continue;
      }
      const outcome = turnEnd.outcome ?? "completed";
      if (outcome === "completed" || outcome === "completed_with_pending_tasks") continue; // taskCompleted handles it
      await this.abnormalEnd(step, outcome);
    }
  }

  /** Also the restart path: `outcome` is then `server_restart`. */
  async abnormalEnd(step: WorkflowRunStep, outcome: string): Promise<void> {
    const run = await this.storage.workflowRuns.getById(step.run_id);
    const params = run ? parseRepeatParams(run) : null;
    await this.storage.workflowRunSteps.abandon(step.id, `turn ended: ${outcome}`);
    if (!run || !params || run.status !== "running_task") return;

    const byUser = outcome === "stopped";
    const reason = byUser
      ? "这次迭代已由你停止。可以继续循环，或结束它。"
      : outcome === "server_restart"
        ? "这次迭代因服务重启而中断。那一项可能处理到一半——确认后再继续。"
        : `这次迭代异常结束（${outcome}）。`;
    // A stop by the user rings no bell: they are right there.
    const moved = byUser
      ? await this.storage.workflowRuns.transition(run.id, "running_task", "cancelled", { error: reason })
      : await this.storage.workflowRuns.transitionWithOutbox(
        run.id, "running_task", "failed", { error: reason },
        this.outbox(run, params.anchorSessionId, "workflow_failed", outcome),
      );
    if (!moved) return;
    const ended = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.untrack(ended);
    this.host.emitRunUpdated(ended);
    if (!byUser) this.host.milestoneCreated();

    const gate = await this.storage.workflowRuns.create({
      id: randomUUID(), project_id: run.project_id, branch: run.branch,
      source_session_id: randomUUID(), source_turn_end_index: -1, review_focus: null, review_target: null,
      status: "waiting_resume", error: reason, kind: "repeat",
      params: JSON.stringify({ ...params, prevSessionId: run.source_session_id, stopAfterCurrent: false } satisfies RepeatLoopParams),
      loop_id: run.loop_id, round: run.round + 1, max_rounds: run.max_rounds,
    });
    this.host.track(gate);
    this.host.emitRunUpdated(gate);
  }

  private async entryIndexOf(step: WorkflowRunStep): Promise<number | null> {
    if (step.user_entry_index !== null) return step.user_entry_index;
    const row = await this.storage.agentSessions.getLifecycleById(step.session_id);
    return row?.activation_user_entry_index ?? null;
  }

  // ---------- user actions (addressed by loop, not by run) ----------

  /**
   * The panel may hold the id of an iteration that has just been settled.
   * Every action therefore resolves to the loop's ONE active run first.
   */
  private async activeOf(run: WorkflowRun): Promise<WorkflowRun | undefined> {
    if (!run.loop_id) return run;
    return this.storage.workflowRuns.getActiveInLoop(run.loop_id);
  }

  /** Hard stop — the ctrl-c. Ends the loop; no gate. */
  async cancel(run: WorkflowRun, reason?: string): Promise<WorkflowRun> {
    const active = await this.activeOf(run);
    if (!active) return run;
    const patch = { error: reason ?? "循环已由你结束。" };
    const from = (["preparing", "running_task", "waiting_resume"] as const);
    let was: (typeof from)[number] | null = null;
    for (const status of from) {
      if (await this.storage.workflowRuns.transition(active.id, status, "cancelled", patch)) { was = status; break; }
    }
    if (!was) return (await this.storage.workflowRuns.getById(active.id)) ?? active;
    await this.storage.workflowRunSteps.abandonOpenByRun(active.id, "loop cancelled");
    const cancelled = (await this.storage.workflowRuns.getById(active.id))!;
    this.host.untrack(cancelled);
    if (was !== "waiting_resume") {
      await this.ops.cancelReviewer({ sessionId: active.source_session_id, reason: "cancelled" }).catch(() => undefined);
      await this.stop(active.source_session_id);
    }
    this.host.emitRunUpdated(cancelled);
    return cancelled;
  }

  /** Soft stop: let the current item finish, then put up a gate. */
  async pause(run: WorkflowRun): Promise<WorkflowRun> {
    const active = await this.activeOf(run);
    if (!active) throw new RepeatLoopError("bad-state", "循环已经结束");
    if (active.status === "waiting_resume") return active;
    const params = parseRepeatParams(active);
    if (!params) throw new RepeatLoopError("bad-state", "循环参数损坏");
    const updated = await this.storage.workflowRuns.update(active.id, { params: JSON.stringify({ ...params, stopAfterCurrent: true }) });
    if (updated) this.host.emitRunUpdated(updated);
    return updated ?? active;
  }

  async resume(run: WorkflowRun): Promise<WorkflowRun> {
    const gate = await this.activeOf(run);
    if (!gate || gate.status !== "waiting_resume") throw new RepeatLoopError("bad-state", "循环不在等待继续的状态");
    const params = parseRepeatParams(gate);
    if (!params) throw new RepeatLoopError("bad-state", "循环参数损坏");

    // Two sessions editing one worktree is the thing to prevent.
    if (params.prevSessionId) {
      if ((await this.storage.agentSessions.getById(params.prevSessionId))?.status === "running") {
        throw new RepeatLoopError("session-busy", "上一次迭代的 session 还在运行。等它停下，或先停掉它。");
      }
      await this.stop(params.prevSessionId);
    }
    const overCap = gate.max_rounds !== null && gate.round > gate.max_rounds;
    const overTime = Date.now() - params.startedAt > params.maxMinutes * 60_000;
    const nextParams: RepeatLoopParams = { ...params, stopAfterCurrent: false, ...(overTime ? { startedAt: Date.now() } : {}) };
    // A fresh session id: the old one may be a tombstone from a failed dispatch.
    const resumed = await this.storage.workflowRuns.transition(gate.id, "waiting_resume", "preparing", {
      error: null, params: JSON.stringify(nextParams), source_session_id: randomUUID(),
      ...(overCap ? { max_rounds: gate.max_rounds! + params.maxIterations } : {}),
    });
    if (!resumed) throw new RepeatLoopError("bad-state", "循环状态已变化");
    const preparing = (await this.storage.workflowRuns.getById(gate.id))!;
    this.host.untrack(gate);
    this.host.track(preparing);
    this.host.emitRunUpdated(preparing);
    return this.dispatchIteration(preparing.id);
  }

  // ---------- boot ----------

  /** `init()` hook for one active repeat run; steps were reconciled before this. */
  async recover(run: WorkflowRun): Promise<void> {
    if (run.status === "preparing") {
      // Inserted (or resumed) but never dispatched — or dispatched up to a
      // step that reconciliation just proved undelivered. Same keys: a replay.
      void this.dispatchIteration(run.id).catch((err) => console.error("[RepeatLoop] boot dispatch failed:", err));
    }
  }

  private async stop(sessionId: string): Promise<void> {
    await this.ops.stopSession?.(sessionId).catch((err) => console.warn(`[RepeatLoop] stopping ${sessionId} failed:`, err));
  }

  private outbox(run: WorkflowRun, anchorSessionId: string, kind: "loop_done" | "workflow_failed", reason: string): Omit<NotificationOutboxEvent, "seq"> {
    return {
      id: loopMilestoneId(run.loop_id ?? run.id, run.round, reason), kind,
      project_id: run.project_id, branch: run.branch,
      // The anchor's outbox, so a hub that only ever published the first
      // session still gets it; the run id says which iteration it is about.
      session_id: anchorSessionId, workflow_run_id: run.id, created_at: Date.now(),
    };
  }
}
