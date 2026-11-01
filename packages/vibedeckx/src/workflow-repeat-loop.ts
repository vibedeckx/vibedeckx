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
import {
  HANDOFF_INSTRUCTIONS, parseClosingLine, parseTaskStatus, splitHandoff, TASK_STATUS_INSTRUCTIONS,
} from "./utils/review-verdict.js";
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
/** How much of an iteration's error text the gate reason carries. */
const ABNORMAL_END_DETAIL_MAX = 300;
/** How far ahead a gate's scheduled resume may be set (loop-presets design §4.3). */
export const RESUME_SCHEDULE_MAX_MS = 7 * 24 * 60 * 60_000;

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
  /**
   * Every `Item:` a `continue` iteration reported (and the check command, if
   * any, accepted), in order — the loop's own progress ledger (loop-presets
   * design §5.3). Shown to each session at the top of its instruction so the
   * instruction need not make the agent tick anything in a file; the engine
   * never matches items against anything. Never truncated: an instruction
   * that picks "the first step not in this list" would loop on a dropped one.
   */
  doneItems?: string[];
  /** Soft stop: finish the current item, then put up a gate. */
  stopAfterCurrent?: boolean;
  /**
   * This gate is an iteration that could not START (its run turned into the
   * gate in place), not the successor of one that ended. The panel needs the
   * difference: the round that stopped is this one, and it has no session.
   */
  dispatchFailed?: boolean;
  /** Where the instruction came from (New loop dialog preset). Display only — the engine never reads it. */
  preset?: RepeatLoopPreset | null;
  /** Ask each iteration for a closing `Handoff:` note and hand it to the next one (loop-presets design §5). */
  handoff?: boolean;
  /**
   * The latest note an iteration wrote — carried forward as is when one
   * writes none, and kept on gates and through resume. Never parsed.
   */
  handoffNote?: string | null;
  /**
   * Epoch ms a gate resumes itself at — set by the user from the gate, picked
   * up by checkDeadlines. Only ever on a `waiting_resume` run; a resume clears it.
   */
  resumeAt?: number | null;
}

export const REPEAT_LOOP_PRESET_KINDS = ["plan", "custom"] as const;
export interface RepeatLoopPreset {
  kind: (typeof REPEAT_LOOP_PRESET_KINDS)[number];
  fields?: Record<string, string>;
  /** The generated instruction was edited by hand. */
  edited?: boolean;
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
  preset?: RepeatLoopPreset;
  handoff?: boolean;
  /** Stable id from a hub replay of the start request. */
  runId?: string;
}

/** The system note left in an iteration's transcript when the LOOP stops its session. */
const STOP_NOTE = {
  itemDone: "Loop: this iteration finished its item; the session was closed. The next item runs in a fresh session.",
  paused: "Loop paused after this item; the session was closed. The loop is waiting for you — resume or end it from the loop card.",
  cancelled: "Loop ended; the session was closed.",
  timeCap: "Loop: time cap reached; the session was stopped.",
  resumed: "Loop resumed in a fresh session; this one was closed.",
} as const;

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

/** Statuses in which an iteration's dispatched instruction can still be settled. */
const LIVE_STATUSES = ["preparing", "running_task"] as const;
const isLive = (run: Pick<WorkflowRun, "status">): boolean => (LIVE_STATUSES as readonly string[]).includes(run.status);
/** Re-decisions of a settlement whose run row changed between the read and the commit. */
const SETTLE_ATTEMPTS = 5;

/** Re-resolutions of "the loop's active run" before a user action gives up. */
const CANCEL_ATTEMPTS = 5;

const ITERATION_TURN = { origin: "workflow", notificationDisposition: "milestone-managed" } as const;

export function parseRepeatParams(run: Pick<WorkflowRun, "params">): RepeatLoopParams | null {
  if (!run.params) return null;
  try { return JSON.parse(run.params) as RepeatLoopParams; } catch { return null; }
}

/**
 * The last `error` entry's text, truncated — scanned over the whole tail, not
 * just up to turn_end: a spawn failure's error entry is pushed fire-and-forget
 * and can land after it.
 */
export function lastErrorMessage(entries: readonly (AgentMessage | null | undefined)[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "error") continue;
    const text = e.message.trim();
    if (!text) continue;
    const chars = Array.from(text);
    return chars.length > ABNORMAL_END_DETAIL_MAX ? `${chars.slice(0, ABNORMAL_END_DETAIL_MAX).join("")}…` : text;
  }
  return undefined;
}

/**
 * An `Item:` is "one short line"; a runaway one must not bloat every later
 * instruction. This is the only bound: the list grows by at most this much
 * per iteration, and the loop pauses at its iteration allowance — the user
 * can resume past it, so there is no fixed lifetime cap.
 */
export const DONE_ITEM_MAX_CHARS = 200;

/** The ledger with one more item, newest last. */
export function appendDoneItem(items: readonly string[] | undefined, item: string): string[] {
  const chars = Array.from(item.trim());
  const clipped = chars.length > DONE_ITEM_MAX_CHARS ? `${chars.slice(0, DONE_ITEM_MAX_CHARS).join("")}…` : chars.join("");
  return [...(items ?? []), clipped];
}

/** The ledger as the session sees it — nothing when no item has been completed yet. */
function doneItemsBlock(items: readonly string[] | undefined): string {
  if (!items?.length) return "";
  return `## 之前的 session 已完成的项（循环自动记录，共 ${items.length} 项，按完成顺序）\n${items.map((i) => `- ${i}`).join("\n")}\n---\n\n`;
}

/**
 * The user's prompt, preceded by the loop's progress ledger and the previous
 * iteration's note, followed by the closing protocol.
 */
function iterationInstruction(params: RepeatLoopParams): string {
  const done = doneItemsBlock(params.doneItems);
  const note = params.handoffNote ? `## 上一轮留下的交接\n${params.handoffNote}\n---\n\n` : "";
  const closing = params.handoff ? `${TASK_STATUS_INSTRUCTIONS}\n${HANDOFF_INSTRUCTIONS}` : TASK_STATUS_INSTRUCTIONS;
  return `${done}${note}${params.prompt}\n${closing}`;
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
      if (existing) return this.replayedStart(existing, opts);
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
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.handoff ? { handoff: true, handoffNote: null } : {}),
    };
    let run: WorkflowRun;
    try {
      run = await this.storage.workflowRuns.create({
        id, project_id: opts.project.id, branch: opts.branch,
        source_session_id: sessionId, source_turn_end_index: -1,
        review_focus: null, review_target: null,
        status: "preparing", kind: "repeat", params: JSON.stringify(params),
        loop_id: id, round: 1, max_rounds: maxIterations,
      });
    } catch (err) {
      // The check above and this insert are separate statements; what makes
      // "one loop per workspace" hold under concurrent starts is the partial
      // unique index (idx_workflow_runs_one_repeat_loop), not the check.
      if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
      const replay = opts.runId ? await this.storage.workflowRuns.getById(opts.runId) : undefined;
      if (replay) return this.replayedStart(replay, opts);
      throw new RepeatLoopError("session-busy", "这个 workspace 已有一个进行中的循环，请先结束它");
    }
    this.host.track(run);
    this.host.emitRunUpdated(run);
    return this.dispatchIteration(run.id);
  }

  /**
   * A start replayed with a known `runId` returns that loop — but only if it
   * IS that loop. The id comes from the request; without this check, anyone
   * who may start a loop in one project could read another project's run
   * (prompt included) by guessing or learning its id.
   */
  private replayedStart(existing: WorkflowRun, opts: StartRepeatLoopOptions): WorkflowRun {
    const same = existing.kind === "repeat" && existing.project_id === opts.project.id
      && existing.branch === opts.branch && parseRepeatParams(existing)?.prompt === opts.prompt;
    if (!same) throw new RepeatLoopError("bad-state", "runId 已被另一个 run 占用");
    return existing;
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

      const instruction = iterationInstruction(params);
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
    if (!started) {
      const now = (await this.storage.workflowRuns.getById(run.id))!;
      // Cancelled under us → tear the session down. Anything else means the
      // turn already ended and was settled straight out of `preparing`
      // (onTaskTurnCompleted / endIteration): the session is theirs to keep or stop.
      if (now.status === "cancelled") await this.tearDown(run);
      return now;
    }
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
    await this.stop(run.source_session_id, STOP_NOTE.cancelled);
  }

  /** `preparing → waiting_resume` on the same row, with the bell: nobody may be watching. */
  private async toGateInPlace(run: WorkflowRun, reason: string): Promise<WorkflowRun> {
    const params = parseRepeatParams(run);
    const moved = await this.storage.workflowRuns.transitionWithOutbox(
      run.id, "preparing", "waiting_resume",
      { error: reason, ...(params ? { params: JSON.stringify({ ...params, dispatchFailed: true } satisfies RepeatLoopParams) } : {}) },
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
    // `preparing` counts: the step was attributed by the entry its dispatch
    // wrote, so the instruction WAS delivered and its turn DID complete — the
    // run merely never recorded `running_task` (a crash, or a very fast turn,
    // between activation and that CAS). Treating it as "cancelled" would claim
    // the step and strand the run.
    if (!run || !params || !isLive(run)) {
      // Cancelled (or otherwise gone) while the turn ran: keep the evidence, move nothing.
      await this.storage.workflowRuns.claimStepAndTransition({ stepId: step.id, turnEndIndex: boundary, outputSnapshot: output });
      return;
    }

    // The note first: a `Status:` line inside it must not decide the iteration.
    const { body, handoff } = params.handoff ? splitHandoff(output) : { body: output, handoff: null };
    let status: WorkflowTaskStatus | null = parseTaskStatus(body);
    const item = parseClosingLine(body, "Item");
    const remaining = parseClosingLine(body, "Remaining");
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

    // Everything above is about the TURN and is computed once. What follows is
    // decided from the RUN row, which two legitimate writers can still move
    // under us: the dispatch path (`preparing → running_task`) and a soft stop
    // (a flag inside `params`; the check command above can run for minutes).
    // So the commit accepts either live status, requires the params it
    // decided from to be unchanged — and on a lost guard re-reads and decides
    // again. A plain re-read before the commit only narrows that window.
    let committed: { settlement: Settlement; insertRun?: WorkflowRepeatRunInput; outbox?: Omit<NotificationOutboxEvent, "seq"> } | null = null;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS && !committed; attempt++) {
      const fresh = await this.storage.workflowRuns.getById(run.id);
      const freshParams = fresh ? parseRepeatParams(fresh) : null;
      if (!fresh || !freshParams || !isLive(fresh)) {
        await this.storage.workflowRuns.claimStepAndTransition({ stepId: step.id, turnEndIndex: boundary, outputSnapshot: output });
        return;
      }
      const settlement = this.settle(fresh, freshParams, status, item, checkFailure);
      const nextParams: RepeatLoopParams = {
        ...freshParams, prevSessionId: fresh.source_session_id, prevItem: item, remaining, stopAfterCurrent: false,
        // Only a completed item enters the ledger: a blocked or unreadable
        // reply names the item it was stuck on, and a `continue` the check
        // command rejected is a claim, not progress — after the gate the
        // next session must pick that step up again, not skip it.
        ...(status === "continue" && item && !checkFailure ? { doneItems: appendDoneItem(freshParams.doneItems, item) } : {}),
        ...(freshParams.handoff ? { handoffNote: handoff ?? freshParams.handoffNote ?? null } : {}),
      };
      const insertRun: WorkflowRepeatRunInput | undefined = settlement.next === "finished" ? undefined : {
        id: randomUUID(), project_id: fresh.project_id, branch: fresh.branch,
        source_session_id: randomUUID(), loop_id: fresh.loop_id, round: fresh.round + 1, max_rounds: fresh.max_rounds,
        params: JSON.stringify(nextParams),
        status: settlement.next === "iterate" ? "preparing" : "waiting_resume",
        error: settlement.next === "gate" ? settlement.reason : null,
      };
      const outbox = settlement.next === "finished"
        ? this.outbox(fresh, freshParams.anchorSessionId, "loop_done", "done")
        : settlement.next === "gate" && settlement.milestone
          ? this.outbox(fresh, freshParams.anchorSessionId, "workflow_failed", settlement.milestone)
          : undefined;
      const settled = await this.storage.workflowRuns.claimStepAndTransition({
        stepId: step.id, turnEndIndex: boundary, outputSnapshot: output,
        run: {
          id: fresh.id, from: LIVE_STATUSES, to: "completed", expectParams: fresh.params,
          patch: {
            outcome_status: status, feedback_snapshot: output, error: checkFailure,
            // The card stays until the user closes it — the loop may finish unwatched.
            ...(settlement.next === "finished" ? { awaiting_dismissal: 1 } : {}),
          },
          outbox,
        },
        insertRun,
      });
      if (settled) { committed = { settlement, insertRun, outbox }; break; }
      // Lost. If the step is no longer ours to claim, someone else settled it.
      if ((await this.storage.workflowRunSteps.getById(step.id))?.status !== "dispatched") return;
    }
    if (!committed) {
      console.error(`[RepeatLoop] could not settle run ${run.id}: the row kept changing; step ${step.id} left dispatched`);
      return;
    }
    const { settlement, insertRun, outbox } = committed;

    const done = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.untrack(done);
    this.host.emitRunUpdated(done);
    if (outbox) this.host.milestoneCreated();

    // A session that needs a human stays up — the user will want to look, and
    // probably keep talking. So does the last one of a finished loop: the
    // sidebar lists only live sessions, and it is where the user goes to see
    // how the loop ended. Everything else is stopped: one item per session.
    const keepSession = settlement.next === "finished"
      || (settlement.next === "gate" && (status === "blocked" || status === null || checkFailure !== null));
    if (!keepSession) {
      // The note must say what happens NEXT: a paused loop claiming "the next
      // item runs in a fresh session" reads as if it were still going.
      await this.stop(run.source_session_id, settlement.next === "gate" ? STOP_NOTE.paused : STOP_NOTE.itemDone);
    }

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
      const after = entries.slice(index + 1);
      const turnEnd = after.find((e) => e?.type === "turn_end") as Extract<AgentMessage, { type: "turn_end" }> | undefined;
      if (!turnEnd) {
        if (recheck) setTimeout(() => void this.onSessionIdle(sessionId, false).catch(() => undefined), ABNORMAL_END_RECHECK_MS).unref();
        continue;
      }
      const outcome = turnEnd.outcome ?? "completed";
      if (outcome === "completed" || outcome === "completed_with_pending_tasks") continue; // taskCompleted handles it
      await this.abnormalEnd(step, outcome, lastErrorMessage(after));
    }
  }

  /**
   * Also the restart path: `outcome` is then `server_restart`, with no
   * `detail`. `detail` is the iteration's last error text (usage limit, auth
   * expiry, failed launch), shown after the reason so the gate says why.
   */
  async abnormalEnd(step: WorkflowRunStep, outcome: string, detail?: string): Promise<void> {
    const byUser = outcome === "stopped";
    const reason = byUser
      ? "这次迭代已由你停止。可以继续循环，或结束它。"
      : outcome === "server_restart"
        ? "这次迭代因服务重启而中断。那一项可能处理到一半——确认后再继续。"
        : detail
          ? `这次迭代异常结束（${outcome}）：${detail}`
          : `这次迭代异常结束（${outcome}）。`;
    // A stop by the user rings no bell: they are right there.
    await this.endIteration(step, `turn ended: ${outcome}`, byUser ? "cancelled" : "failed", reason, byUser ? null : outcome);
  }

  /**
   * End an iteration that will never settle normally — ONE transaction, like
   * a normal settlement: step abandoned + run ended (+ bell) + resume gate
   * inserted. Done as three writes, a crash after the first would leave a
   * `running_task` run with no open step: restart reconciliation walks open
   * steps, so nothing would ever look at it again.
   */
  private async endIteration(
    step: WorkflowRunStep, stepReason: string, to: "cancelled" | "failed", reason: string, milestone: string | null,
  ): Promise<boolean> {
    const run = await this.storage.workflowRuns.getById(step.run_id);
    const params = run ? parseRepeatParams(run) : null;
    // `preparing` too: see onTaskTurnCompleted — a delivered instruction whose
    // run never recorded `running_task`.
    if (!run || !params || !isLive(run)) {
      await this.storage.workflowRunSteps.abandon(step.id, stepReason);
      return false;
    }
    const gate: WorkflowRepeatRunInput = {
      id: randomUUID(), project_id: run.project_id, branch: run.branch,
      source_session_id: randomUUID(), loop_id: run.loop_id, round: run.round + 1, max_rounds: run.max_rounds,
      params: JSON.stringify({ ...params, prevSessionId: run.source_session_id, stopAfterCurrent: false } satisfies RepeatLoopParams),
      status: "waiting_resume", error: reason,
    };
    const ended = await this.storage.workflowRuns.claimStepAndTransition({
      stepId: step.id, turnEndIndex: null, outputSnapshot: null, abandonStep: stepReason,
      run: {
        // Any live status: the dispatch path may record `running_task` between the read above and this commit.
        id: run.id, from: LIVE_STATUSES, to, patch: { error: reason },
        outbox: milestone ? this.outbox(run, params.anchorSessionId, "workflow_failed", milestone) : undefined,
      },
      insertRun: gate,
    });
    if (!ended) return false; // cancelled or settled under us; whoever won owns the step
    const done = (await this.storage.workflowRuns.getById(run.id))!;
    this.host.untrack(done);
    this.host.emitRunUpdated(done);
    if (milestone) this.host.milestoneCreated();
    const inserted = (await this.storage.workflowRuns.getById(gate.id))!;
    this.host.track(inserted);
    this.host.emitRunUpdated(inserted);
    return true;
  }

  // ---------- the dead-man's switch ----------

  /**
   * The time cap has to hold for an iteration that never ends — an agent
   * stuck in a retry loop, a hung tool. settle() only looks at the clock when
   * a turn completes, which is exactly what such an iteration never does. The
   * engine calls this on an interval (and tests call it with a clock).
   */
  async checkDeadlines(now: number): Promise<void> {
    for (const run of await this.storage.workflowRuns.getAllActive()) {
      if (run.kind === "repeat" && run.status === "waiting_resume") {
        await this.resumeIfDue(run, now).catch((err) => console.error(`[RepeatLoop] scheduled resume of ${run.id} failed:`, err));
        continue;
      }
      if (run.kind !== "repeat" || run.status !== "running_task") continue;
      const params = parseRepeatParams(run);
      if (!params || now - params.startedAt <= params.maxMinutes * 60_000) continue;
      const step = (await this.storage.workflowRunSteps.listByRun(run.id))
        .find((st) => st.kind === "task_prompt" && st.status === "dispatched");
      if (!step) { console.warn(`[RepeatLoop] run ${run.id} is over its time cap but has no open step`); continue; }
      const reason = `已达时长上限（${params.maxMinutes} 分钟），这次迭代已被停止——那一项可能处理到一半。继续将重新计时。`;
      // The run first, the session second: once the step is settled, the stop
      // below cannot be mistaken for "stopped by the user".
      if (await this.endIteration(step, "time cap reached", "failed", reason, "max-minutes")) {
        await this.stop(run.source_session_id, STOP_NOTE.timeCap);
      }
    }
  }

  /**
   * A gate whose scheduled time has come. The params read here are the
   * resume's precondition: if the user cancelled or moved the schedule while
   * resume() was awaiting the previous session, its CAS misses and nothing
   * starts — the next tick reads again.
   */
  private async resumeIfDue(gate: WorkflowRun, now: number): Promise<void> {
    const resumeAt = parseRepeatParams(gate)?.resumeAt;
    if (typeof resumeAt !== "number" || resumeAt > now) return;
    try {
      await this.resume(gate, { expectParams: gate.params });
    } catch (err) {
      if (!(err instanceof RepeatLoopError)) throw err;
      if (err.code !== "session-busy") return; // the gate moved on under us; nothing to retry
      // Keep resumeAt: the next tick tries again. Same CAS, so a schedule
      // cancelled meanwhile is not overwritten with a stale reason.
      const error = `定时继续未能启动：${err.message}下一分钟会再试。`;
      if (gate.error !== error && await this.storage.workflowRuns.transition(gate.id, "waiting_resume", "waiting_resume", { error }, gate.params)) {
        this.host.emitRunUpdated((await this.storage.workflowRuns.getById(gate.id))!);
      }
    }
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
    const patch = { error: reason ?? "循环已由你结束。" };
    const from = (["preparing", "running_task", "waiting_resume"] as const);
    // The loop's active run can change between reading it and the CAS: the
    // iteration settles and the next one is inserted (one transaction, so
    // there is always exactly one to find). A lost CAS therefore means "look
    // again", never "nothing to do" — returning there would report a stop
    // while the loop keeps running.
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
      const active = await this.activeOf(run);
      if (!active) return (await this.storage.workflowRuns.getById(run.id)) ?? run;
      let was: (typeof from)[number] | null = null;
      for (const status of from) {
        if (await this.storage.workflowRuns.transition(active.id, status, "cancelled", patch)) { was = status; break; }
      }
      if (!was) continue;
      await this.storage.workflowRunSteps.abandonOpenByRun(active.id, "loop cancelled");
      const cancelled = (await this.storage.workflowRuns.getById(active.id))!;
      this.host.untrack(cancelled);
      if (was !== "waiting_resume") {
        await this.ops.cancelReviewer({ sessionId: active.source_session_id, reason: "cancelled" }).catch(() => undefined);
        await this.stop(active.source_session_id, STOP_NOTE.cancelled);
      }
      this.host.emitRunUpdated(cancelled);
      return cancelled;
    }
    throw new RepeatLoopError("bad-state", "循环状态变化太快，没能停下，请再试一次");
  }

  /** Soft stop: let the current item finish, then put up a gate. */
  async pause(run: WorkflowRun): Promise<WorkflowRun> {
    // Same race as cancel: if the iteration settles around our write, the
    // flag landed on a finished row — put it on the run that replaced it.
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
      const active = await this.activeOf(run);
      if (!active) throw new RepeatLoopError("bad-state", "循环已经结束");
      if (active.status === "waiting_resume") return active;
      const params = parseRepeatParams(active);
      if (!params) throw new RepeatLoopError("bad-state", "循环参数损坏");
      await this.storage.workflowRuns.update(active.id, { params: JSON.stringify({ ...params, stopAfterCurrent: true }) });
      const after = await this.storage.workflowRuns.getById(active.id);
      if (after && (after.status === "preparing" || after.status === "running_task")) {
        this.host.emitRunUpdated(after);
        return after;
      }
    }
    throw new RepeatLoopError("bad-state", "循环状态变化太快，请再试一次");
  }

  /**
   * `expectParams`: the gate's `params` exactly as the caller read them — the
   * scheduled resume's guard (see resumeIfDue). A manual resume passes none.
   */
  async resume(run: WorkflowRun, opts: { expectParams?: string | null } = {}): Promise<WorkflowRun> {
    const gate = await this.activeOf(run);
    if (!gate || gate.status !== "waiting_resume") throw new RepeatLoopError("bad-state", "循环不在等待继续的状态");
    const params = parseRepeatParams(gate);
    if (!params) throw new RepeatLoopError("bad-state", "循环参数损坏");

    // Two sessions editing one worktree is the thing to prevent.
    if (params.prevSessionId && (await this.storage.agentSessions.getById(params.prevSessionId))?.status === "running") {
      throw new RepeatLoopError("session-busy", "上一次迭代的 session 还在运行。等它停下，或先停掉它。");
    }
    const overCap = gate.max_rounds !== null && gate.round > gate.max_rounds;
    const overTime = Date.now() - params.startedAt > params.maxMinutes * 60_000;
    const { resumeAt: _scheduled, ...rest } = params;
    const nextParams: RepeatLoopParams = { ...rest, stopAfterCurrent: false, dispatchFailed: false, ...(overTime ? { startedAt: Date.now() } : {}) };
    // A fresh session id: the old one may be a tombstone from a failed dispatch.
    const resumed = await this.storage.workflowRuns.transition(gate.id, "waiting_resume", "preparing", {
      error: null, params: JSON.stringify(nextParams), source_session_id: randomUUID(),
      ...(overCap ? { max_rounds: gate.max_rounds! + params.maxIterations } : {}),
    }, opts.expectParams);
    if (!resumed) throw new RepeatLoopError("bad-state", "循环状态已变化");
    // After the CAS, not before: a resume that loses it (a schedule cancelled
    // meanwhile) must leave the previous session alone. It is not running —
    // checked above — so the order changes nothing for a resume that wins.
    if (params.prevSessionId) await this.stop(params.prevSessionId, STOP_NOTE.resumed);
    const preparing = (await this.storage.workflowRuns.getById(gate.id))!;
    this.host.untrack(gate);
    this.host.track(preparing);
    this.host.emitRunUpdated(preparing);
    return this.dispatchIteration(preparing.id);
  }

  /**
   * Set (`at`) or clear (`null`) the gate's scheduled resume. Addressed by
   * loop like pause; `at` was validated by the route. Conditional on the
   * params just read, so a concurrent resume or a second schedule is never
   * overwritten with a stale copy.
   */
  async scheduleResume(run: WorkflowRun, at: number | null): Promise<WorkflowRun> {
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
      const gate = await this.activeOf(run);
      if (!gate || gate.status !== "waiting_resume") throw new RepeatLoopError("bad-state", "循环不在等待继续的状态");
      const params = parseRepeatParams(gate);
      if (!params) throw new RepeatLoopError("bad-state", "循环参数损坏");
      const { resumeAt: _previous, ...rest } = params;
      const next: RepeatLoopParams = at === null ? rest : { ...rest, resumeAt: at };
      if (await this.storage.workflowRuns.transition(gate.id, "waiting_resume", "waiting_resume", { params: JSON.stringify(next) }, gate.params)) {
        const updated = (await this.storage.workflowRuns.getById(gate.id))!;
        this.host.emitRunUpdated(updated);
        return updated;
      }
    }
    throw new RepeatLoopError("bad-state", "循环状态变化太快，请再试一次");
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

  /**
   * Always with a note: the runtime's default is "Session stopped by user.",
   * which is false for every stop the loop performs — and on a finished
   * iteration reads as if the item had been interrupted.
   */
  private async stop(sessionId: string, note: string): Promise<void> {
    await this.ops.stopSession?.(sessionId, { note }).catch((err) => console.warn(`[RepeatLoop] stopping ${sessionId} failed:`, err));
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
