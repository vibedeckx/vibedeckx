import { randomUUID } from "crypto";
import type { Storage, WorkflowRun } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { AgentMessage } from "./agent-types.js";
import { captureReviewTarget, hasDrifted, type ReviewTarget } from "./utils/review-target.js";
import { snippetTitle } from "./utils/session-title.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

/** Minimal surface the engine needs from AgentSessionManager (structural). */
export interface AgentOps {
  createNewSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb?: boolean,
    permissionMode?: "plan" | "edit",
    agentType?: string,
    announceRunning?: boolean,
  ): Promise<string>;
  sendUserMessage(sessionId: string, content: string, projectPath?: string): Promise<boolean>;
  /** Write a final title and claim the one-shot slot (AI titling never fires). */
  setFinalSessionTitle(sessionId: string, title: string): Promise<void>;
  /** Raw sparse entries (holes preserved) — index space matches entry indices. */
  getRawMessages(sessionId: string): AgentMessage[];
  /** Optional: push a raw WS frame to a session's stream subscribers. */
  broadcastRawToSession?(sessionId: string, payload: Record<string, unknown>): void;
}

export class WorkflowError extends Error {
  constructor(public code: "session-busy" | "no-completed-turn" | "spawn-failed" | "bad-state" | "send-failed" | "source-running", message: string) {
    super(message);
  }
}

// ---------- pure helpers (exported for tests / reuse) ----------

export function extractLatestTurnEndIndex(entries: AgentMessage[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "turn_end") return i;
  }
  return null;
}

export function extractLastAssistantBefore(entries: AgentMessage[], beforeIndex: number): string | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "assistant" && typeof e.content === "string" && e.content.trim()) return e.content;
  }
  return null;
}

export function extractTaskContextBefore(entries: AgentMessage[], turnEndIndex: number): string | null {
  for (let i = turnEndIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "user" && typeof e.content === "string" && e.content.trim()) {
      return e.content.length > 2000 ? e.content.slice(0, 2000) + "…" : e.content;
    }
  }
  return null;
}

export function buildReviewerPrompt(opts: {
  taskContext: string | null;
  reviewFocus: string | null;
  target: ReviewTarget;
}): string {
  return [
    "You are a code reviewer agent. Another agent just completed work in this workspace; review it critically and independently.",
    opts.taskContext ? `\n## Original task\n${opts.taskContext}` : null,
    opts.reviewFocus ? `\n## Review focus (from the user)\n${opts.reviewFocus}` : null,
    "\n## How to review",
    "- Do NOT modify any files — you are in read-only review mode.",
    "- Inspect the actual workspace state yourself: read the relevant files, run `git diff`, `git status` and `git log`.",
    opts.target.baseHead
      ? `- The work was captured at commit ${opts.target.baseHead}${opts.target.diffStat ? ` with uncommitted changes (${opts.target.diffStat})` : " with no uncommitted changes"}.`
      : null,
    "- Judge correctness, completeness against the task, and code quality. Be specific: reference files and lines.",
    "\nEnd your final message with a clear, actionable list of feedback items — or state explicitly that the work looks good.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function buildFeedbackMessage(feedback: string): string {
  return [
    "[Review Feedback]",
    "A reviewer agent examined your last completed work. Please address the following feedback:",
    "",
    feedback,
  ].join("\n");
}

// ---------- engine ----------

interface Participant {
  runId: string;
  role: "source" | "reviewer";
}

export class WorkflowEngine {
  private eventBus?: EventBus;
  /** sessionId → participation in an active run (rebuilt on boot). */
  private participants = new Map<string, Participant>();

  constructor(
    private storage: Storage,
    private agentOps: AgentOps,
  ) {}

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
    bus.subscribe((event: GlobalEvent) => {
      if (event.type === "session:taskCompleted") {
        void this.handleTaskCompleted(event).catch((err) =>
          console.error("[WorkflowEngine] handleTaskCompleted failed:", err),
        );
      }
    });
  }

  /** Boot recovery (spec §3.4). Call once after storage is ready. */
  async init(): Promise<void> {
    const active = await this.storage.workflowRuns.getAllActive();
    for (const run of active) {
      if (run.status === "sending_feedback") {
        // Crash mid-send: honest at-most-once — never auto-resend.
        await this.storage.workflowRuns.update(run.id, {
          status: "waiting_feedback",
          error:
            "发送状态未知：服务在发送反馈期间重启。请检查 source session 是否已收到反馈，再决定重发或结束。",
        });
        run.status = "waiting_feedback";
      } else if (run.status === "waiting_reviewer") {
        await this.storage.workflowRuns.update(run.id, {
          error: "服务重启，可能错过 reviewer 完成事件。若 reviewer 已完成，请打开其窗口查看，或结束本次 review。",
        });
      }
      this.trackParticipants(run);
    }
  }

  private trackParticipants(run: WorkflowRun): void {
    this.participants.set(run.source_session_id, { runId: run.id, role: "source" });
    if (run.reviewer_session_id) {
      this.participants.set(run.reviewer_session_id, { runId: run.id, role: "reviewer" });
    }
  }

  private untrackRun(run: WorkflowRun): void {
    for (const [sid, p] of this.participants) {
      if (p.runId === run.id) this.participants.delete(sid);
    }
  }

  /** Sync check used by ChatSessionManager before waking the commander model. */
  shouldSuppressAgentEvent(sessionId: string): boolean {
    return this.participants.get(sessionId)?.role === "reviewer";
  }

  isSessionInActiveRun(sessionId: string): boolean {
    return this.participants.has(sessionId);
  }

  async startAdhocReview(opts: {
    project: { id: string; path: string };
    branch: string | null;
    sourceSessionId: string;
    reviewFocus?: string;
    sourceTurnEndIndex?: number;
  }): Promise<WorkflowRun> {
    if (this.participants.has(opts.sourceSessionId)) {
      throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
    }
    // Reserve the source session synchronously — before any `await` below —
    // so two concurrent calls for the same session can't both pass the
    // check above. JS only yields to another call at an `await`; by the
    // time it does, this call has already claimed the map entry, so the
    // other call's synchronous `has()` check (above) sees it and throws.
    // There is deliberately no DB unique constraint backing this: this is a
    // single-writer server process and every run creation flows through
    // this one WorkflowEngine instance, so the in-memory map alone is
    // authoritative. The run row doesn't exist yet, so reserve with a
    // "pending" placeholder; the outer catch below releases it on any
    // failure that happens before `trackParticipants(run)` replaces it with
    // the real run id (the inner reviewer-spawn try/catch handles cleanup
    // for failures after that point via the real run id instead).
    this.participants.set(opts.sourceSessionId, { runId: "pending", role: "source" });

    try {
      const busy = await this.storage.workflowRuns.getActiveBySession(opts.sourceSessionId);
      if (busy) throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");

      const sourceSession = await this.storage.agentSessions.getById(opts.sourceSessionId);
      if (sourceSession?.status === "running") {
        throw new WorkflowError("source-running", "source session 正在运行，请等待当前 turn 完成后再发起 review");
      }

      const entries = this.agentOps.getRawMessages(opts.sourceSessionId);
      const turnEndIndex = opts.sourceTurnEndIndex ?? extractLatestTurnEndIndex(entries);
      if (turnEndIndex === null) {
        throw new WorkflowError("no-completed-turn", "source session 还没有已完成的 turn 可供 review");
      }

      const worktreePath = resolveWorktreePath(opts.project.path, opts.branch);
      const target = captureReviewTarget(worktreePath);

      const run = await this.storage.workflowRuns.create({
        id: randomUUID(),
        project_id: opts.project.id,
        branch: opts.branch,
        source_session_id: opts.sourceSessionId,
        source_turn_end_index: turnEndIndex,
        review_focus: opts.reviewFocus ?? null,
        review_target: JSON.stringify(target),
      });
      this.trackParticipants(run);

      try {
        // Reviewer runs in plan (read-only) mode: it shares the worktree with
        // the implementer session it's reviewing, and an unrestricted
        // reviewer could mutate the very code it's supposed to be judging.
        const reviewerId = await this.agentOps.createNewSession(
          opts.project.id, opts.branch, opts.project.path, false, "plan", "claude-code", true,
        );
        const taskContext = extractTaskContextBefore(entries, turnEndIndex);
        // Deterministic "Review - <source title>" (same pattern as Branch
        // sessions) — no AI generation. Set BEFORE the prompt is delivered so
        // the first-user-message AI titler can never race it; best-effort
        // because a title failure must not abort the run.
        await this.agentOps
          .setFinalSessionTitle(
            reviewerId,
            `Review - ${sourceSession?.title || (taskContext ? snippetTitle(taskContext) : null) || "Conversation"}`,
          )
          .catch((err) => console.warn(`[WorkflowEngine] failed to set reviewer title for ${reviewerId}:`, err));
        const prompt = buildReviewerPrompt({
          taskContext,
          reviewFocus: opts.reviewFocus ?? null,
          target,
        });
        const sent = await this.agentOps.sendUserMessage(reviewerId, prompt, opts.project.path);
        if (!sent) {
          const failed = await this.storage.workflowRuns.update(run.id, {
            status: "failed",
            error: "向 reviewer 投递任务失败",
          });
          if (failed) this.untrackRun(failed);
          throw new WorkflowError("spawn-failed", "向 reviewer 投递任务失败");
        }
        const updated = await this.storage.workflowRuns.update(run.id, { reviewer_session_id: reviewerId });
        this.trackParticipants(updated!);
        this.emitRunUpdated(updated!);
        return updated!;
      } catch (err) {
        if (err instanceof WorkflowError && err.code === "spawn-failed") throw err;
        const failed = await this.storage.workflowRuns.update(run.id, {
          status: "failed",
          error: `创建 reviewer 失败：${err instanceof Error ? err.message : String(err)}`,
        });
        if (failed) this.untrackRun(failed);
        throw new WorkflowError("spawn-failed", "创建 reviewer session 失败");
      }
    } catch (err) {
      if (this.participants.get(opts.sourceSessionId)?.runId === "pending") {
        this.participants.delete(opts.sourceSessionId);
      }
      throw err;
    }
  }

  private async handleTaskCompleted(event: Extract<GlobalEvent, { type: "session:taskCompleted" }>): Promise<void> {
    const p = this.participants.get(event.sessionId);
    if (!p || p.role !== "reviewer") return;
    const run = await this.storage.workflowRuns.getById(p.runId);
    if (!run || run.status !== "waiting_reviewer") return;

    const entries = this.agentOps.getRawMessages(event.sessionId);
    const boundary = event.turnEndEntryIndex ?? extractLatestTurnEndIndex(entries) ?? entries.length;
    const feedback = extractLastAssistantBefore(entries, boundary) ?? "(reviewer 没有输出可用的反馈文本)";

    let driftNote: string | null = null;
    try {
      const target = run.review_target ? (JSON.parse(run.review_target) as ReviewTarget) : null;
      const project = await this.storage.projects.getById(run.project_id);
      if (target && project && hasDrifted(resolveWorktreePath(project.path ?? "", run.branch), target)) {
        driftNote = "注意：workspace 在 review 期间发生了变化，部分反馈可能针对的不是被审工作。";
      }
    } catch { /* drift check is best-effort */ }

    const ok = await this.storage.workflowRuns.transition(run.id, "waiting_reviewer", "waiting_feedback", {
      feedback_snapshot: feedback,
      ...(driftNote ? { error: driftNote } : {}),
    });
    if (!ok) return;
    const updated = await this.storage.workflowRuns.getById(run.id);
    if (updated) this.emitRunUpdated(updated);
  }

  async approveFeedback(runId: string, editedPayload?: string): Promise<WorkflowRun> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run || run.status !== "waiting_feedback") {
      throw new WorkflowError("bad-state", "run 不在等待反馈确认的状态");
    }
    const claimed = await this.storage.workflowRuns.transition(runId, "waiting_feedback", "sending_feedback", {
      ...(editedPayload !== undefined ? { feedback_snapshot: editedPayload } : {}),
      error: null, // clear stale warnings (error column is nullable)
    });
    if (!claimed) throw new WorkflowError("bad-state", "run 状态已变化（可能已被处理）");

    const feedback = editedPayload ?? run.feedback_snapshot ?? "";
    const project = await this.storage.projects.getById(run.project_id);
    const ok = await this.agentOps
      .sendUserMessage(run.source_session_id, buildFeedbackMessage(feedback), project?.path ?? undefined)
      .catch(() => false);

    if (!ok) {
      await this.storage.workflowRuns.transition(runId, "sending_feedback", "waiting_feedback", {
        error: "发送失败：目标 session 可能未运行。请在其窗口中唤醒后重试，或结束本次 review。",
      });
      throw new WorkflowError("send-failed", "发送反馈失败");
    }
    const completedOk = await this.storage.workflowRuns.transition(runId, "sending_feedback", "completed");
    if (!completedOk) {
      // Defensive only: with cancelRun's CAS, nothing else should be able to
      // touch a run while it's in sending_feedback, so this should never fire.
      console.warn(
        `[WorkflowEngine] run ${runId}: expected transition sending_feedback → completed did not apply (status changed unexpectedly)`,
      );
    }
    const done = (await this.storage.workflowRuns.getById(runId))!;
    this.untrackRun(done);
    this.emitRunUpdated(done);
    return done;
  }

  async cancelRun(runId: string, reason?: string): Promise<WorkflowRun | undefined> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run) return undefined;
    if (["completed", "cancelled", "failed"].includes(run.status)) return run;

    // CAS instead of an unconditional status write: `sending_feedback` is the
    // narrow window where approveFeedback is mid-`await` on
    // agentOps.sendUserMessage. A concurrent cancel must not stomp that —
    // only the two states below are safe for cancel to interrupt.
    const patch = reason ? { error: reason } : undefined;
    const cancelled =
      (await this.storage.workflowRuns.transition(runId, "waiting_reviewer", "cancelled", patch)) ||
      (await this.storage.workflowRuns.transition(runId, "waiting_feedback", "cancelled", patch));

    if (!cancelled) {
      const current = await this.storage.workflowRuns.getById(runId);
      if (current?.status === "sending_feedback") {
        throw new WorkflowError("bad-state", "反馈正在发送，无法取消");
      }
      // Status moved to a terminal state between the read above and the CAS
      // attempts (e.g. it just completed/failed) — nothing to cancel.
      return current;
    }

    const updated = await this.storage.workflowRuns.getById(runId);
    if (updated) {
      this.untrackRun(updated);
      this.emitRunUpdated(updated);
    }
    return updated;
  }

  /**
   * Human takeover (spec §3.4): user sent a message directly to a run session.
   *
   * Never-throws contract: this is called inline from the agent-session
   * `/message` route BEFORE the user's message is delivered
   * (agentOps.sendUserMessage). A throw here would abort delivery of that
   * message, so this method must never throw — any error from cancelRun is
   * caught and swallowed, never rethrown. `bad-state` is the expected case:
   * it means the run is mid-send (approveFeedback's own CAS holds it in
   * `sending_feedback`), a transient race, so we just log and let the
   * takeover no-op; the run resolves on its own via approveFeedback's
   * completion/rollback. Any other error is unexpected but still swallowed
   * to honor the contract, with a louder log so it isn't silently lost.
   */
  async handleExternalUserMessage(sessionId: string): Promise<void> {
    const p = this.participants.get(sessionId);
    if (!p) return;
    try {
      await this.cancelRun(p.runId, "用户接管：直接向 run 内的 session 发送了消息，review 已结束。");
    } catch (err) {
      if (err instanceof WorkflowError && err.code === "bad-state") {
        console.warn(
          `[WorkflowEngine] handleExternalUserMessage: run ${p.runId} is mid-send (sending_feedback); skipping takeover cancel`,
        );
      } else {
        console.error(
          `[WorkflowEngine] handleExternalUserMessage: unexpected error cancelling run ${p.runId}; swallowed to honor never-throws contract`,
          err,
        );
      }
    }
  }

  private emitRunUpdated(run: WorkflowRun): void {
    this.eventBus?.emit({ type: "workflow:run-updated", projectId: run.project_id, branch: run.branch, run });
    // Mirror the update onto the participant sessions' WS streams: the only
    // worker→front push channel is the per-session stream, so a front server
    // subscribed to either participant sees run transitions live without a
    // dedicated cross-machine event channel. Duplicate delivery (both streams
    // subscribed) is harmless — the front-side panel refresh is idempotent.
    for (const sid of [run.source_session_id, run.reviewer_session_id]) {
      if (sid) this.agentOps.broadcastRawToSession?.(sid, { workflowRunUpdated: run });
    }
  }
}
