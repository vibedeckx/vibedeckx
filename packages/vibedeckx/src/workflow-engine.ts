import { randomUUID } from "crypto";
import type { Storage, WorkflowRun } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { AgentMessage, AgentType, TextPart } from "./agent-types.js";
import { captureReviewTarget, hasDrifted, type ReviewTarget } from "./utils/review-target.js";
import { captureSnapshot, computeScope } from "./utils/review-snapshot.js";
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
  sendUserMessage(
    sessionId: string,
    content: string,
    projectPath?: string,
    userId?: string,
    opts?: { origin?: "workflow" },
  ): Promise<boolean>;
  /** Write a final title and claim the one-shot slot (AI titling never fires). */
  setFinalSessionTitle(sessionId: string, title: string): Promise<void>;
  switchMode(sessionId: string, projectPath: string, newMode: "plan" | "edit"): Promise<boolean>;
  /** Raw sparse entries (holes preserved) — index space matches entry indices. */
  getRawMessages(sessionId: string): AgentMessage[];
  /** Optional: push a raw WS frame to a session's stream subscribers. */
  broadcastRawToSession?(sessionId: string, payload: Record<string, unknown>): void;
}

export class WorkflowError extends Error {
  constructor(public code: "session-busy" | "no-completed-turn" | "spawn-failed" | "bad-state" | "send-failed" | "source-running" | "reviewer-unavailable", message: string) {
    super(message);
  }
}

// ---------- pure helpers (exported for tests / reuse) ----------

const MAX_CONTEXT_CHARS = 2000;
const MAX_SELF_REPORT_CHARS = 4000;
/** Below this length an assistant message is treated as a "done" stub, not a self-report. */
const SELF_REPORT_MIN_CHARS = 80;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function userTextOf(e: AgentMessage): string | null {
  if (e.type !== "user") return null;
  if (typeof e.content === "string") return e.content;
  const text = e.content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return text || null;
}

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

export function extractLastAssistantInTurn(entries: AgentMessage[], beforeIndex: number): string | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "user") return null;
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

/**
 * First real user message of the session — the original intent, verbatim.
 * Skips harness-injected event notifications (they are user-typed but not
 * something the user wrote).
 */
export function extractFirstUserMessage(entries: AgentMessage[]): string | null {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type !== "user" || e.event) continue;
    const text = userTextOf(e)?.trim();
    if (text) return cap(text, MAX_CONTEXT_CHARS);
  }
  return null;
}

/**
 * The author's own account of the work: last substantial assistant message
 * before `beforeIndex`. Short "done"-style stubs are skipped in favor of an
 * earlier substantial summary; if nothing substantial exists, the last
 * non-empty stub is returned rather than nothing. `withinTurn` stops the walk
 * at the previous user message — used for re-reviews, where an older turn's
 * summary would describe stale work.
 */
export function extractAuthorSelfReport(
  entries: AgentMessage[],
  beforeIndex: number,
  opts?: { withinTurn?: boolean },
): string | null {
  let fallback: string | null = null;
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "user" && opts?.withinTurn) break;
    if (e?.type !== "assistant" || typeof e.content !== "string") continue;
    const text = e.content.trim();
    if (!text) continue;
    if (text.length >= SELF_REPORT_MIN_CHARS) return cap(text, MAX_SELF_REPORT_CHARS);
    if (fallback === null) fallback = text;
  }
  return fallback;
}

/**
 * Frames the author's summary as claims to verify, not facts (anchoring
 * antidote): reviewers inherit confidence from context, so the self-report is
 * explicitly re-labeled as the object under review. Tag-delimited because the
 * report may itself contain markdown fences.
 */
function selfReportSection(report: string | null): string | null {
  if (!report) return null;
  return [
    "\n## Author's self-report (unverified)",
    "The implementing agent described its own work as follows. Treat every claim as unverified — check each one against the actual code, and look for problems the self-report does not mention.",
    "<author-self-report>",
    report,
    "</author-self-report>",
  ].join("\n");
}

export function buildReviewerPrompt(opts: {
  taskContext: string | null;
  originalIntent: string | null;
  authorSelfReport: string | null;
  /**
   * Tier 1: LLM-distilled brief; replaces both verbatim conversation
   * sections (original request + latest user message) — the distiller has
   * read the whole conversation, so a verbatim excerpt adds nothing but
   * noise (often a bare "ok" confirming a proposal). The author self-report
   * stays alongside it — the brief carries intent, the self-report carries
   * the author's claims to audit; they are orthogonal (distillation
   * deliberately strips completion claims).
   */
  intentBrief?: string | null;
  reviewFocus: string | null;
  target: ReviewTarget;
  /**
   * Files the reviewed turn actually changed, from snapshot delta. When set
   * with a non-empty list, the prompt confines the reviewer to these files and
   * treats everything else in the worktree as out of scope. Null when snapshots
   * were unavailable (pre-feature session or capture failure) — the prompt then
   * tells the reviewer the scope is unknown.
   */
  scope?: { changedFiles: string[]; startHead: string } | null;
}): string {
  // In single-turn sessions the first user message IS the turn's task — don't
  // print it twice.
  const intent = opts.originalIntent !== opts.taskContext ? opts.originalIntent : null;
  const brief = opts.intentBrief || null;
  const hasExcerpt = Boolean(intent || opts.taskContext || opts.authorSelfReport);
  const scope = opts.scope && opts.scope.changedFiles.length > 0 ? opts.scope : null;
  return [
    "You are a code reviewer agent. Another agent just completed work in this workspace; review it critically and independently.",
    brief ? `\n## Intent brief (distilled from the source conversation)\n${brief}` : null,
    !brief && intent ? `\n## Original request (the user's first message in this session, verbatim)\n${intent}` : null,
    // Deliberately not titled "Original task": in confirmation-style
    // conversations the latest message is often just "ok" — informative as
    // the user's last word, misleading as a statement of the task.
    !brief && opts.taskContext ? `\n## Latest user message (verbatim)\n${opts.taskContext}` : null,
    selfReportSection(opts.authorSelfReport),
    opts.reviewFocus ? `\n## Review focus (from the user)\n${opts.reviewFocus}` : null,
    scope
      ? `\n## Scope — the change under review\nThe reviewed turn changed exactly these files:\n${scope.changedFiles.map((f) => `- ${f}`).join("\n")}\nIt starts from commit \`${scope.startHead}\` — use \`git diff ${scope.startHead} -- <file>\` and \`git log ${scope.startHead}..HEAD\` to see the content.\nConfine your review to these files and changes. Other uncommitted or pre-existing changes in the worktree, or changes from other turns, are out of scope unless this change depends on them.`
      : opts.scope != null && opts.scope.changedFiles.length === 0
        ? "\n## Scope — the change under review\nThe reviewed turn changed no files. Do not review unrelated uncommitted or pre-existing changes in the worktree — there is nothing in scope for this turn. If you believe the turn should have changed something, say so rather than reviewing out-of-scope code."
        : opts.scope === null
          ? "\n## Scope\nThe changed-file set could not be determined (scope unknown) — inspect `git diff`/`git status`/`git log` and judge the relevant range yourself."
          : null,
    "\n## How to review",
    "- Do NOT modify any files — you are in read-only review mode.",
    "- Inspect the actual workspace state yourself: read the relevant files, run `git diff`, `git status` and `git log`.",
    reviewTargetPromptLine(opts.target),
    "- Judge correctness, completeness against the task, and code quality. Be specific: reference files and lines.",
    "\nEnd your final message with a clear, actionable list of feedback items — or state explicitly that the work looks good.",
    brief
      ? opts.authorSelfReport
        ? "\n(review context: distilled intent brief + author self-report + live workspace)"
        : "\n(review context: distilled intent brief + live workspace)"
      : hasExcerpt
        ? "\n(review context: deterministic excerpt of the source conversation + live workspace)"
        : "\n(review context: live workspace only — the source conversation was unavailable)",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

function reviewTargetPromptLine(target: ReviewTarget): string | null {
  return target.baseHead
    ? `- The work was captured at commit ${target.baseHead}${target.diffStat ? ` with uncommitted changes (${target.diffStat})` : " with no uncommitted changes"}.`
    : null;
}

export function buildRereviewerPrompt(opts: {
  taskContext: string | null;
  authorSelfReport: string | null;
  reviewFocus: string | null;
  target: ReviewTarget;
}): string {
  return [
    "The source agent has addressed feedback from your previous review.",
    "Review the latest workspace state again.",
    opts.taskContext ? `\n## Latest source turn\n${opts.taskContext}` : null,
    selfReportSection(opts.authorSelfReport),
    opts.reviewFocus ? `\n## Review focus\n${opts.reviewFocus}` : null,
    "\n## How to review",
    "- Verify whether your previous feedback was addressed correctly.",
    "- Treat the changed areas as new code: look for bugs the fix itself may have introduced, not only whether your old items were closed.",
    "- Check for regressions and remaining correctness or test gaps.",
    "- Do NOT modify files — remain in read-only review mode.",
    reviewTargetPromptLine(opts.target),
    "- End with actionable feedback, or explicitly state that it looks good.",
  ]
    .filter((line): line is string => line !== null)
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

export type ReviewerCandidateUnavailableReason =
  | "deleted"
  | "project-mismatch"
  | "branch-mismatch"
  | "running"
  | "busy"
  | "unsupported-agent"
  | "unavailable";

export interface ReviewerCandidate {
  available: boolean;
  sessionId: string | null;
  title: string | null;
  agentType: AgentType | null;
  reason: ReviewerCandidateUnavailableReason | null;
}

export const REVIEWER_AGENT_TYPES = new Set<AgentType>(["claude-code", "codex"]);

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

  private releaseReservations(runId: string): void {
    for (const [sid, participant] of this.participants) {
      if (participant.runId === runId) this.participants.delete(sid);
    }
  }

  private async failRun(run: WorkflowRun, error: string): Promise<void> {
    const failed = await this.storage.workflowRuns.update(run.id, { status: "failed", error });
    if (failed) this.untrackRun(failed);
  }

  /** Sync check used by ChatSessionManager before waking the commander model. */
  shouldSuppressAgentEvent(sessionId: string): boolean {
    return this.participants.get(sessionId)?.role === "reviewer";
  }

  isSessionInActiveRun(sessionId: string): boolean {
    return this.participants.has(sessionId);
  }

  async getReviewerCandidate(sourceSessionId: string): Promise<ReviewerCandidate | null> {
    const previous = await this.storage.workflowRuns.getLatestCompletedBySource(sourceSessionId);
    if (!previous?.reviewer_session_id) return null;

    const unavailable = (reason: ReviewerCandidateUnavailableReason): ReviewerCandidate => ({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason,
    });
    const source = await this.storage.agentSessions.getById(sourceSessionId);
    const reviewer = await this.storage.agentSessions.getById(previous.reviewer_session_id);
    if (!reviewer) return unavailable("deleted");
    if (!source || reviewer.project_id !== source.project_id || reviewer.project_id !== previous.project_id) {
      return unavailable("project-mismatch");
    }
    if ((reviewer.branch || null) !== (source.branch || null) || (reviewer.branch || null) !== previous.branch) {
      return unavailable("branch-mismatch");
    }
    if (!REVIEWER_AGENT_TYPES.has(reviewer.agent_type as AgentType)) {
      return unavailable("unsupported-agent");
    }
    if (reviewer.status === "running") return unavailable("running");
    if (reviewer.status !== "stopped") return unavailable("unavailable");
    if (this.participants.has(reviewer.id) || await this.storage.workflowRuns.getActiveBySession(reviewer.id)) {
      return unavailable("busy");
    }
    return {
      available: true,
      sessionId: reviewer.id,
      title: reviewer.title ?? null,
      agentType: reviewer.agent_type as AgentType,
      reason: null,
    };
  }

  async startAdhocReview(opts: {
    project: { id: string; path: string };
    branch: string | null;
    sourceSessionId: string;
    reviewFocus?: string;
    sourceTurnEndIndex?: number;
    /**
     * Tier-1 context: LLM-distilled brief of the source conversation, produced
     * front-side (that's where chat-provider keys live). Opaque text to the
     * engine; when absent the prompt falls back to the deterministic excerpt.
     * Fresh reviews only — re-reviews keep their own turn-scoped context.
     */
    intentBrief?: string;
    /** Existing reviewer session to continue. Mutually exclusive with reviewerAgentType. */
    reviewerSessionId?: string;
    /** Agent that runs the review; defaults to claude-code. */
    reviewerAgentType?: AgentType;
  }): Promise<WorkflowRun> {
    if (opts.reviewerSessionId === opts.sourceSessionId) {
      throw new WorkflowError("reviewer-unavailable", "reviewer session 不能与 source session 相同");
    }
    const runId = randomUUID();
    const participantIds = [opts.sourceSessionId, opts.reviewerSessionId]
      .filter((id): id is string => Boolean(id));
    for (const sessionId of participantIds) {
      if (this.participants.has(sessionId)) {
        throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
      }
    }
    // This check-and-reserve block is deliberately synchronous. JavaScript
    // cannot interleave a competing start until the first await below, by
    // which point every known participant is already claimed by this run id.
    this.participants.set(opts.sourceSessionId, { runId, role: "source" });
    if (opts.reviewerSessionId) {
      this.participants.set(opts.reviewerSessionId, { runId, role: "reviewer" });
    }

    try {
      for (const sessionId of participantIds) {
        if (await this.storage.workflowRuns.getActiveBySession(sessionId)) {
          throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
        }
      }

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

      let reviewerSession = null;
      if (opts.reviewerSessionId) {
        reviewerSession = await this.storage.agentSessions.getById(opts.reviewerSessionId);
        if (!reviewerSession) {
          throw new WorkflowError("reviewer-unavailable", "上次 reviewer session 已不存在");
        }
        if (reviewerSession.project_id !== opts.project.id) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 不属于当前项目");
        }
        if ((reviewerSession.branch || null) !== opts.branch) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 不属于当前 branch");
        }
        if (!REVIEWER_AGENT_TYPES.has(reviewerSession.agent_type as AgentType)) {
          throw new WorkflowError("reviewer-unavailable", "reviewer agent 类型不可用");
        }
        if (reviewerSession.status !== "stopped") {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 正在运行或不可用");
        }
      }

      const run = await this.storage.workflowRuns.create({
        id: runId,
        project_id: opts.project.id,
        branch: opts.branch,
        source_session_id: opts.sourceSessionId,
        source_turn_end_index: turnEndIndex,
        review_focus: opts.reviewFocus ?? null,
        review_target: JSON.stringify(target),
        reviewer_session_id: opts.reviewerSessionId ?? null,
      });
      this.trackParticipants(run);

      if (opts.reviewerSessionId && reviewerSession) {
        if (reviewerSession.permission_mode !== "plan") {
          let switched = false;
          try {
            switched = await this.agentOps.switchMode(opts.reviewerSessionId, opts.project.path, "plan");
          } catch { /* normalized to a stable workflow error below */ }
          if (!switched) {
            await this.failRun(run, "无法将 reviewer 恢复为只读 plan 模式");
            throw new WorkflowError("reviewer-unavailable", "无法将 reviewer 恢复为只读 plan 模式");
          }
        }
        const prompt = buildRereviewerPrompt({
          taskContext: extractTaskContextBefore(entries, turnEndIndex),
          // Scoped to the fix turn: an older turn's summary would describe the
          // pre-review state and mislead the acceptance pass.
          authorSelfReport: extractAuthorSelfReport(entries, turnEndIndex, { withinTurn: true }),
          reviewFocus: opts.reviewFocus ?? null,
          target,
        });
        const sent = await this.agentOps
          .sendUserMessage(opts.reviewerSessionId, prompt, opts.project.path, undefined, { origin: "workflow" })
          .catch(() => false);
        if (!sent) {
          await this.failRun(run, "向上次 reviewer 投递复审任务失败");
          throw new WorkflowError("send-failed", "向上次 reviewer 投递复审任务失败");
        }
        this.emitRunUpdated(run);
        return run;
      }

      let scope: { changedFiles: string[]; startHead: string } | null = null;
      try {
        const endSnap = captureSnapshot(worktreePath);
        const startSnap = await this.storage.turnSnapshots.getStartBoundary(opts.sourceSessionId, turnEndIndex);
        if (endSnap && startSnap) scope = computeScope(startSnap, endSnap, worktreePath);
      } catch (err) {
        console.warn("[WorkflowEngine] scope computation failed:", (err as Error).message);
      }

      try {
        // Reviewer runs in plan (read-only) mode: it shares the worktree with
        // the implementer session it's reviewing, and an unrestricted
        // reviewer could mutate the very code it's supposed to be judging.
        // Plan mode is read-only for both agents (codex maps it to
        // sandbox: "read-only"), so any reviewer agent is safe here.
        const reviewerId = await this.agentOps.createNewSession(
          opts.project.id, opts.branch, opts.project.path, false, "plan", opts.reviewerAgentType ?? "claude-code", true,
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
          originalIntent: extractFirstUserMessage(entries),
          authorSelfReport: extractAuthorSelfReport(entries, turnEndIndex),
          intentBrief: opts.intentBrief ?? null,
          reviewFocus: opts.reviewFocus ?? null,
          target,
          scope,
        });
        const sent = await this.agentOps.sendUserMessage(reviewerId, prompt, opts.project.path, undefined, { origin: "workflow" });
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
      this.releaseReservations(runId);
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
    const feedback = extractLastAssistantInTurn(entries, boundary) ?? "(reviewer 没有输出可用的反馈文本)";

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
      .sendUserMessage(run.source_session_id, buildFeedbackMessage(feedback), project?.path ?? undefined, undefined, { origin: "workflow" })
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
