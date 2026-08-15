import { randomUUID } from "crypto";
import type { ReviewSpan, Storage, WorkflowRun } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { AgentMessage, AgentType, NotificationDisposition, TextPart } from "./agent-types.js";
import { reviewReadyId, workflowFailedId } from "./notification-milestones.js";
import { captureReviewTarget, hasDrifted, type ReviewTarget } from "./utils/review-target.js";
import { captureSnapshot, computeScope, resolveStartSnapshot, type SnapshotState } from "./utils/review-snapshot.js";
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
    force?: boolean,
    opts?: { startSnapshot?: SnapshotState | null; sessionId?: string },
  ): Promise<string>;
  sendUserMessage(
    sessionId: string,
    content: string,
    projectPath?: string,
    userId?: string,
    opts?: { origin?: "workflow"; notificationDisposition?: NotificationDisposition },
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

/** Statuses a run can never leave — see failRun / cancelRun. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);

// ---------- notification dispositions for workflow-authored turns ----------

/**
 * A reviewer's turn: the run — not the session — owns the attention event. Its
 * completion becomes exactly one `review_ready` on the
 * waiting_reviewer → waiting_feedback transition, so suppressing the generic
 * session milestone here is what stops one review from dinging twice.
 */
const REVIEWER_TURN = {
  origin: "workflow",
  notificationDisposition: "milestone-managed",
} as const satisfies { origin: "workflow"; notificationDisposition: NotificationDisposition };

/**
 * Approved feedback delivered to the source session. Workflow-authored, but the
 * source's *modification* is a separate user-facing deliverable — reviewer
 * feedback and the fix that follows it are two distinct attention milestones —
 * so this turn is a plain `result`.
 */
const FEEDBACK_TURN = {
  origin: "workflow",
  notificationDisposition: "result",
} as const satisfies { origin: "workflow"; notificationDisposition: NotificationDisposition };

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
    "The implementing agent described its own work as follows. Treat every claim as unverified — verify first the claims that bear on whether the work achieves its goal, and look for problems the self-report does not mention.",
    "<author-self-report>",
    report,
    "</author-self-report>",
  ].join("\n");
}

/**
 * Shared ending for first review and re-review. Three-way verdict rather than
 * ship/no-ship: "cannot-verify" gives a reviewer with thin evidence an honest
 * exit instead of an overconfident ship. Blocking and non-blocking findings are
 * separated so polish notes cannot dilute blockers. Nothing downstream parses
 * this wording — the review loop relays through a human approval gate.
 */
const VERDICT_INSTRUCTIONS = [
  "\nEnd your final message with:",
  "1. Verdict — exactly one of: ship / needs-changes / cannot-verify. Use cannot-verify when you could not gather enough evidence to judge, rather than guessing.",
  "2. Blocking findings — what must change before shipping, each specific and actionable (say explicitly when there are none).",
  "3. Non-blocking notes — style and polish, briefly, clearly separated from the blocking list.",
] as const;

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
  // A no-diff turn whose author left a substantial self-report was almost
  // certainly an analysis/plan turn: the deliverable IS that reasoning, not a
  // diff. Point the reviewer at it instead of declaring "nothing in scope".
  const noDiffWithAnalysis =
    Boolean(opts.authorSelfReport) && (opts.authorSelfReport as string).trim().length >= SELF_REPORT_MIN_CHARS;
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
      ? `\n## Scope — the change under review\n\nThe reviewed turn changed exactly these files:\n${scope.changedFiles.map((f) => `- ${f}`).join("\n")}\n\nIt starts from commit \`${scope.startHead}\` — use \`git diff ${scope.startHead} -- <file>\` and \`git log ${scope.startHead}..HEAD\` to see the content.\n\nConfine your review to these files and changes. Other uncommitted or pre-existing changes in the worktree, or changes from other turns, are out of scope unless this change depends on them.`
      : opts.scope != null && opts.scope.changedFiles.length === 0
        ? noDiffWithAnalysis
          ? "\n## Scope — the change under review\n\nThe reviewed turn changed no files. Its deliverable is the analysis and proposed approach in the author self-report above, not a diff — review THAT. Verify the diagnosis against the actual code: are the cited files/lines real and the described mechanism correct? Then stress-test the proposed fix as a plan, before implementation — correctness, side-effects, and completeness. If you instead conclude the turn should have produced a code change and didn't, say so. Do not review unrelated uncommitted or pre-existing changes in the worktree."
          : "\n## Scope — the change under review\n\nThe reviewed turn changed no files. Do not review unrelated uncommitted or pre-existing changes in the worktree — there is nothing in scope for this turn. If you believe the turn should have changed something, say so rather than reviewing out-of-scope code."
        : opts.scope === null
          ? "\n## Scope\n\nThe changed-file set could not be determined (scope unknown) — inspect `git diff`/`git status`/`git log` and judge the relevant range yourself."
          : null,
    "\n## How to review",
    "- Do NOT modify any files — you are in read-only review mode.",
    "- Inspect the actual workspace state yourself: read the relevant files, run `git diff`, `git status` and `git log`.",
    reviewTargetPromptLine(opts.target),
    noDiffWithAnalysis
      ? "- Judge correctness and completeness against the task. For this analysis/plan turn the work under review is the reasoning and the proposal, not code quality of a diff. Be specific: reference files and lines."
      : "- Judge correctness, completeness against the task, and code quality. Be specific: reference files and lines.",
    // These two only make sense against a distilled brief: tier 2 has no
    // [settled]/[tentative] marks and no stated scope, and implying it does
    // would suppress findings on the strength of data that doesn't exist.
    brief
      ? "- Where the brief marks a decision, non-goal, or accepted limitation as [settled], do not re-raise the choice itself as a finding; DO report concrete consequences it causes — failure of the core goal, or a correctness, security, or data loss problem. Items marked [tentative] (or unmarked) get normal review. A violated hard constraint is always blocking."
      : null,
    brief
      ? "- Do not propose enhancements beyond the brief's stated scope — scope expansion is a product decision, not a review finding."
      : null,
    ...VERDICT_INSTRUCTIONS,
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
    "- Do not expand scope: no new enhancement asks, refactors, or abstractions for hypothetical cases. A new blocking finding must be a real defect the fix introduced or exposed — anything else is at most a non-blocking note.",
    "- Do NOT modify files — remain in read-only review mode.",
    reviewTargetPromptLine(opts.target),
    ...VERDICT_INSTRUCTIONS,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * The source side of the review loop. Symmetric to `buildReviewerPrompt`: that
 * one labels the author's self-report as unverified, this one labels the
 * reviewer's findings the same way, and for the same reason — the reviewer is
 * read-only and saw only this turn's diff plus a distilled brief, so it can be
 * wrong on the facts while sounding authoritative.
 *
 * The escape hatch is deliberately paired with a per-item accounting duty: an
 * unqualified "use your judgment" makes "I looked, it's fine" the cheapest path
 * and the loop spins. Disagreeing has to cost more than complying. That
 * accounting is also what the next `buildRereviewerPrompt` turn reads as the
 * author self-report — otherwise a re-review can only infer what was done from
 * the workspace.
 */
export function buildFeedbackMessage(feedback: string): string {
  return [
    "[Review Feedback]",
    "A reviewer agent examined your last completed work. It was in read-only mode and saw only this turn's diff plus a distilled brief of the conversation, so it may be working from wrong premises. Treat its findings as input to verify, not as conclusions.",
    "",
    "- Verify each item against the code before changing anything.",
    "- Push back when you have grounds: say what the item gets wrong and leave the code as it is. Do not change code to be agreeable.",
    "- Address blocking findings first; non-blocking notes need not be done this turn.",
    "- Do not widen the scope: no fixes the reviewer did not raise, no abstractions for hypothetical cases.",
    "- Close with a per-item account: fixed, or not fixed and why.",
    "",
    feedback,
  ].join("\n");
}

/**
 * Injected when the user finishes a discussion round and asks for a clean
 * final verdict. The reviewer's discussion replies are conversational and
 * unsuitable as feedback payloads; this prompt forces one turn whose output
 * IS the payload, which handleTaskCompleted then snapshots verbatim.
 */
export const FINAL_VERDICT_PROMPT = [
  "[Final verdict request]",
  "请把讨论后的最终 review 意见完整输出为面向作者的定稿。这段输出将原样发送给作者——不要包含对话性内容：不要引用讨论过程本身，不要向我提问。",
  "- 吸收讨论中达成一致的修正：撤回的条目不再出现，修订过的条目以修订后的形式给出。",
  "- 保持具体：每条指明文件/位置与问题，以及期望的修复方向。",
  ...VERDICT_INSTRUCTIONS,
].join("\n");

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

  /**
   * The single place a run becomes `failed`. Goes through a guarded transition
   * out of the run's CURRENT status rather than an unconditional status write,
   * so the failure milestone can only be created by the caller that actually
   * performed the transition — a run that concurrently completed or was
   * cancelled fails the CAS and writes nothing.
   *
   * The milestone targets the participant the user should inspect: the reviewer
   * when one exists, otherwise the source session (a run can fail before its
   * reviewer is ever created).
   */
  private async failRun(run: WorkflowRun, error: string): Promise<void> {
    // A run that already resolved is not failing now. Without this guard the
    // CAS below would trivially succeed (from === the terminal status it is
    // already in) and turn a completed or user-cancelled run into a spurious
    // "Workflow needs attention" notification — same guard cancelRun applies.
    if (TERMINAL_STATUSES.has(run.status)) return;
    const from = run.status;
    const ok = await this.storage.workflowRuns.transitionWithOutbox(
      run.id, from, "failed", { error },
      {
        // The state the run failed OUT OF: two distinct failures of one run are
        // distinct attention milestones, while a retried transition out of the
        // same state is not.
        id: workflowFailedId(run.id, from),
        kind: "workflow_failed",
        project_id: run.project_id,
        branch: run.branch,
        session_id: run.reviewer_session_id ?? run.source_session_id,
        workflow_run_id: run.id,
        created_at: Date.now(),
      },
    );
    if (!ok) return;
    const failed = await this.storage.workflowRuns.getById(run.id);
    if (failed) this.untrackRun(failed);
    this.onMilestoneCreated?.();
  }

  /** Test seam for the failure path (see failRun). */
  async failRunForTest(runId: string, error: string): Promise<void> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (run) await this.failRun(run, error);
  }

  /**
   * Injected by shared-services: nudges NotificationService to drain the local
   * outbox promptly. Latency only — correctness rests on the periodic/startup
   * drains, since this can't fire if the process dies right after the commit.
   */
  setMilestoneListener(listener: () => void): void {
    this.onMilestoneCreated = listener;
  }

  private onMilestoneCreated: (() => void) | null = null;

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
    const [sourceProjection, reviewerProjection] = await Promise.all([
      source ? this.storage.agentSessions.getActivityById(source.id, "workflow-reviewer") : undefined,
      this.storage.agentSessions.getActivityById(reviewer.id, "workflow-reviewer"),
    ]);
    if (!sourceProjection || !reviewerProjection) return unavailable("unavailable");
    if (sourceProjection.projectId !== reviewerProjection.projectId
      || reviewerProjection.projectId !== previous.project_id) {
      return unavailable("project-mismatch");
    }
    if (reviewerProjection.branch !== sourceProjection.branch
      || reviewerProjection.branch !== previous.branch) {
      return unavailable("branch-mismatch");
    }
    if ((reviewerProjection.binding === "checkout"
      && (reviewerProjection.checkoutDeletedAt !== null || reviewerProjection.checkoutStatus !== "ready"))) {
      return unavailable("unavailable");
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
    reviewSpan?: ReviewSpan;
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
    /** Stable identities supplied by a hub durable-intent replay. */
    runId?: string;
    newReviewerSessionId?: string;
  }): Promise<WorkflowRun> {
    if (opts.reviewerSessionId === opts.sourceSessionId) {
      throw new WorkflowError("reviewer-unavailable", "reviewer session 不能与 source session 相同");
    }
    if (opts.reviewerSessionId && opts.newReviewerSessionId) {
      throw new WorkflowError("reviewer-unavailable", "不能同时复用和新建 reviewer session");
    }
    const runId = opts.runId ?? randomUUID();
    const existingRun = opts.runId
      ? await this.storage.workflowRuns.getById(runId)
      : undefined;
    if (existingRun) {
      const sameRequest = existingRun.project_id === opts.project.id
        && existingRun.branch === opts.branch
        && existingRun.source_session_id === opts.sourceSessionId
        && existingRun.review_focus === (opts.reviewFocus ?? null)
        && existingRun.review_span === (opts.reviewSpan ?? "this_turn");
      if (!sameRequest) {
        throw new WorkflowError("reviewer-unavailable", "workflow run identity is already in use");
      }
      if (existingRun.reviewer_session_id) {
        if (opts.newReviewerSessionId
          && existingRun.reviewer_session_id !== opts.newReviewerSessionId) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session identity is already in use");
        }
        return existingRun;
      }
      if (existingRun.status !== "waiting_reviewer") {
        throw new WorkflowError("bad-state", "workflow run 已终止，不能作为未知创建结果重放");
      }
    }
    const participantIds = [opts.sourceSessionId, opts.reviewerSessionId, opts.newReviewerSessionId]
      .filter((id): id is string => Boolean(id));
    for (const sessionId of participantIds) {
      const participant = this.participants.get(sessionId);
      if (participant && participant.runId !== runId) {
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
    if (opts.newReviewerSessionId) {
      this.participants.set(opts.newReviewerSessionId, { runId, role: "reviewer" });
    }

    try {
      for (const sessionId of participantIds) {
        const active = await this.storage.workflowRuns.getActiveBySession(sessionId);
        if (active && active.id !== runId) {
          throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
        }
      }

      const sourceSession = await this.storage.agentSessions.getById(opts.sourceSessionId);
      const sourceProjection = sourceSession
        ? await this.storage.agentSessions.getActivityById(opts.sourceSessionId, "workflow-reviewer")
        : undefined;
      if (!sourceSession || !sourceProjection
        || sourceProjection.projectId !== opts.project.id
        || sourceProjection.branch !== opts.branch) {
        throw new WorkflowError("reviewer-unavailable", "source session 不属于当前 workspace");
      }
      if (sourceProjection.binding === "checkout"
        && (sourceProjection.checkoutDeletedAt !== null || sourceProjection.checkoutStatus !== "ready")) {
        throw new WorkflowError("reviewer-unavailable", "source session 的 workspace checkout 不可用");
      }
      if (sourceSession?.status === "running") {
        throw new WorkflowError("source-running", "source session 正在运行，请等待当前 turn 完成后再发起 review");
      }

      const entries = this.agentOps.getRawMessages(opts.sourceSessionId);
      const turnEndIndex = opts.sourceTurnEndIndex ?? extractLatestTurnEndIndex(entries);
      if (turnEndIndex === null) {
        throw new WorkflowError("no-completed-turn", "source session 还没有已完成的 turn 可供 review");
      }

      const worktreePath = sourceProjection.worktreePath
        ?? resolveWorktreePath(opts.project.path, opts.branch);
      const target = captureReviewTarget(worktreePath);

      let reviewerSession = null;
      if (opts.reviewerSessionId) {
        reviewerSession = await this.storage.agentSessions.getById(opts.reviewerSessionId);
        if (!reviewerSession) {
          throw new WorkflowError("reviewer-unavailable", "上次 reviewer session 已不存在");
        }
        const reviewerProjection = await this.storage.agentSessions.getActivityById(opts.reviewerSessionId, "workflow-reviewer");
        if (!reviewerProjection || reviewerProjection.projectId !== opts.project.id) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 不属于当前项目");
        }
        if (reviewerProjection.branch !== opts.branch) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 不属于当前 branch");
        }
        if (reviewerProjection.binding === "checkout"
          && (reviewerProjection.checkoutDeletedAt !== null || reviewerProjection.checkoutStatus !== "ready")) {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 的 workspace checkout 不可用");
        }
        if (!REVIEWER_AGENT_TYPES.has(reviewerSession.agent_type as AgentType)) {
          throw new WorkflowError("reviewer-unavailable", "reviewer agent 类型不可用");
        }
        if (reviewerSession.status !== "stopped") {
          throw new WorkflowError("reviewer-unavailable", "reviewer session 正在运行或不可用");
        }
      }

      if (existingRun && existingRun.source_turn_end_index !== turnEndIndex) {
        throw new WorkflowError("reviewer-unavailable", "workflow run cutoff does not match the replay request");
      }
      const run = existingRun ?? await this.storage.workflowRuns.create({
          id: runId,
          project_id: opts.project.id,
          branch: opts.branch,
          source_session_id: opts.sourceSessionId,
          source_turn_end_index: turnEndIndex,
          review_focus: opts.reviewFocus ?? null,
          review_target: JSON.stringify(target),
          reviewer_session_id: opts.reviewerSessionId ?? null,
          review_span: opts.reviewSpan ?? "this_turn",
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
          .sendUserMessage(opts.reviewerSessionId, prompt, opts.project.path, undefined, REVIEWER_TURN)
          .catch(() => false);
        if (!sent) {
          await this.failRun(run, "向上次 reviewer 投递复审任务失败");
          throw new WorkflowError("send-failed", "向上次 reviewer 投递复审任务失败");
        }
        this.emitRunUpdated(run);
        return run;
      }

      let scope: { changedFiles: string[]; startHead: string } | null = null;
      let endSnap: SnapshotState | null = null;
      try {
        endSnap = captureSnapshot(worktreePath);
        const startSnap = await resolveStartSnapshot(
          this.storage, opts.sourceSessionId, opts.reviewSpan ?? "this_turn", turnEndIndex,
        );
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
        // The reviewer's own session-start snapshot describes the same
        // worktree we just snapshotted for the scope, milliseconds earlier —
        // hand it over rather than walking the worktree a second time.
        const reviewerId = await this.agentOps.createNewSession(
          opts.project.id, opts.branch, opts.project.path, false, "plan", opts.reviewerAgentType ?? "claude-code", true,
          false, {
            startSnapshot: endSnap,
            ...(opts.newReviewerSessionId ? { sessionId: opts.newReviewerSessionId } : {}),
          },
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
        const sent = await this.agentOps.sendUserMessage(reviewerId, prompt, opts.project.path, undefined, REVIEWER_TURN);
        if (!sent) {
          // The reviewer session exists by now, so record it on the run before
          // failing — otherwise the failure milestone would point at the source
          // instead of the reviewer the user needs to inspect.
          await this.failRun({ ...run, reviewer_session_id: reviewerId }, "向 reviewer 投递任务失败");
          throw new WorkflowError("spawn-failed", "向 reviewer 投递任务失败");
        }
        const updated = await this.storage.workflowRuns.update(run.id, { reviewer_session_id: reviewerId });
        this.trackParticipants(updated!);
        this.emitRunUpdated(updated!);
        return updated!;
      } catch (err) {
        if (err instanceof WorkflowError && err.code === "spawn-failed") throw err;
        await this.failRun(run, `创建 reviewer 失败：${err instanceof Error ? err.message : String(err)}`);
        throw new WorkflowError("spawn-failed", "创建 reviewer session 失败");
      }
    } catch (err) {
      if (!existingRun) this.releaseReservations(runId);
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
      const sourceProjection = await this.storage.agentSessions.getActivityById(run.source_session_id, "workflow-reviewer");
      const worktreePath = sourceProjection?.worktreePath
        ?? (project ? resolveWorktreePath(project.path ?? "", run.branch) : null);
      if (target && worktreePath && hasDrifted(worktreePath, target)) {
        driftNote = "注意：workspace 在 review 期间发生了变化，部分反馈可能针对的不是被审工作。";
      }
    } catch { /* drift check is best-effort */ }

    // The attention milestone rides the state transition, NOT this event: the
    // reviewer's raw completion is not itself "review feedback is ready", and
    // deriving the notification from the event would ding even when the CAS
    // loses (run already advanced or cancelled). One transition ⇒ one
    // review_ready, guaranteed by the CAS plus the deterministic id.
    const ok = await this.storage.workflowRuns.transitionWithOutbox(
      run.id, "waiting_reviewer", "waiting_feedback",
      {
        feedback_snapshot: feedback,
        ...(driftNote ? { error: driftNote } : {}),
      },
      {
        id: reviewReadyId(run.id, boundary),
        kind: "review_ready",
        project_id: run.project_id,
        branch: run.branch,
        // Target the reviewer: that's where the feedback and the
        // approve/discard controls are.
        session_id: event.sessionId,
        workflow_run_id: run.id,
        created_at: Date.now(),
      },
    );
    if (!ok) return;
    this.onMilestoneCreated?.();
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
      .sendUserMessage(run.source_session_id, buildFeedbackMessage(feedback), project?.path ?? undefined, undefined, FEEDBACK_TURN)
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

  /**
   * Discussion → verdict: CAS the run back onto the reviewer track and inject
   * the final-verdict prompt. From waiting_reviewer the existing
   * handleTaskCompleted path reopens the gate with the new turn's output.
   * Send failure rolls the claim back so the finalize button stays actionable —
   * mirror of approveFeedback's no-auto-retry contract.
   */
  async requestFinalVerdict(runId: string): Promise<WorkflowRun> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run || run.status !== "discussing" || !run.reviewer_session_id) {
      throw new WorkflowError("bad-state", "run 不在讨论状态");
    }
    // Closes the realistic race: finalize clicked while the reviewer still has
    // an in-flight discussion turn. Without this, the CAS below would open the
    // gate immediately, and that stale turn's session:taskCompleted would
    // satisfy handleTaskCompleted's waiting_reviewer check with old content —
    // the real verdict turn's completion would then no-op silently against an
    // already-advanced run. Lenient on a missing row (e.g. the adhoc-start
    // mock path in tests never inserts one): only a positively "running"
    // session blocks. The residual micro-window — a completion event already
    // in flight the instant this check runs — is accepted; it self-heals via
    // re-discussing + re-finalizing.
    const reviewerSession = await this.storage.agentSessions.getById(run.reviewer_session_id);
    if (reviewerSession && reviewerSession.status === "running") {
      throw new WorkflowError("session-busy", "reviewer 正在回复中，请等待其完成后再生成终稿");
    }
    const claimed = await this.storage.workflowRuns.transition(runId, "discussing", "waiting_reviewer", { error: null });
    if (!claimed) throw new WorkflowError("bad-state", "run 状态已变化（可能已被处理）");

    const project = await this.storage.projects.getById(run.project_id);
    const sent = await this.agentOps
      .sendUserMessage(run.reviewer_session_id, FINAL_VERDICT_PROMPT, project?.path ?? undefined, undefined, REVIEWER_TURN)
      .catch(() => false);
    if (!sent) {
      const rolledBack = await this.storage.workflowRuns.transition(runId, "waiting_reviewer", "discussing", {
        error: "发送失败：reviewer session 可能未运行。请在其窗口中唤醒后重试，或结束本次 review。",
      });
      if (!rolledBack) {
        console.warn(
          `requestFinalVerdict: rollback CAS lost for run ${runId} — run moved concurrently (e.g. cancelled) while the send was in flight; rollback skipped`,
        );
      }
      const rolled = await this.storage.workflowRuns.getById(runId);
      if (rolled) this.emitRunUpdated(rolled);
      throw new WorkflowError("send-failed", "向 reviewer 发送终稿请求失败");
    }
    const updated = (await this.storage.workflowRuns.getById(runId))!;
    this.emitRunUpdated(updated);
    return updated;
  }

  async cancelRun(runId: string, reason?: string): Promise<WorkflowRun | undefined> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run) return undefined;
    if (TERMINAL_STATUSES.has(run.status)) return run;

    // CAS instead of an unconditional status write: `sending_feedback` is the
    // narrow window where approveFeedback is mid-`await` on
    // agentOps.sendUserMessage. A concurrent cancel must not stomp that —
    // only the three states below are safe for cancel to interrupt.
    const patch = reason ? { error: reason } : undefined;
    const cancelled =
      (await this.storage.workflowRuns.transition(runId, "waiting_reviewer", "cancelled", patch)) ||
      (await this.storage.workflowRuns.transition(runId, "waiting_feedback", "cancelled", patch)) ||
      (await this.storage.workflowRuns.transition(runId, "discussing", "cancelled", patch));

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
   * Handle a user message sent directly to a review participant.
   *
   * Reviewer 分流:向 reviewer 发消息会开启一轮讨论,把 run 移入
   * `discussing`(gate 收起),等待显式的 requestFinalVerdict 重新出稿。
   * 向 source session 发消息不改变 review run:review 针对启动时捕获的
   * 快照继续独立运行,只有显式取消操作才会结束它。
   *
   * Never-throws contract: this is called inline from the agent-session
   * `/message` route BEFORE the user's message is delivered
   * (agentOps.sendUserMessage). A throw here would abort delivery of that
   * message, so this method must never throw. Storage errors from the reviewer
   * transition are caught and swallowed so they cannot block message delivery.
   */
  async handleExternalUserMessage(sessionId: string): Promise<void> {
    const p = this.participants.get(sessionId);
    if (!p) return;
    if (p.role === "reviewer") {
      // 讨论不是接管:用户给 reviewer 发消息 → run 进入 discussing,gate 收起,
      // 等待显式的 requestFinalVerdict 重新出稿。两个 from 状态各试一次(同
      // cancelRun 的写法);都失败说明 run 处于 sending_feedback 或已终态——
      // 静默不动。清掉 error:上一轮的 drift/发送警告对讨论态是陈旧信息,
      // 下一轮终稿会重新计算。整段包 try/catch:never-throws 契约覆盖 storage
      // 异常本身,不止 CAS 落败——异常冒出会阻断 /message 路由的消息投递。
      try {
        const moved =
          (await this.storage.workflowRuns.transition(p.runId, "waiting_feedback", "discussing", { error: null })) ||
          (await this.storage.workflowRuns.transition(p.runId, "waiting_reviewer", "discussing", { error: null }));
        if (moved) {
          const updated = await this.storage.workflowRuns.getById(p.runId);
          if (updated) this.emitRunUpdated(updated);
        }
      } catch (err) {
        console.error(
          `[WorkflowEngine] handleExternalUserMessage: failed moving run ${p.runId} to discussing; swallowed to honor never-throws contract`,
          err,
        );
      }
      return;
    }
    // Source and reviewer are independent after the review snapshot is
    // captured. Continuing the source conversation must not implicitly cancel
    // the review or discard a verdict that is already in flight.
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
