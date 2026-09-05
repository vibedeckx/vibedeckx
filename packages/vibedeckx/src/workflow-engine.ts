import { randomUUID } from "crypto";
import type { ReviewSpan, Storage, WorkflowRun } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { AgentMessage, AgentType, NotificationDisposition, TextPart } from "./agent-types.js";
import { reviewReadyId, workflowFailedId } from "./notification-milestones.js";
import { captureReviewTarget, hasDrifted, type ReviewTarget } from "./utils/review-target.js";
import { captureSnapshot, computeScope, resolveStartSnapshot, type SnapshotState } from "./utils/review-snapshot.js";
import { snippetTitle } from "./utils/session-title.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import type {
  ActivateAgentSessionInput,
  ActivationResult,
  CancelPreparedSessionInput,
  CancelResult,
  PrepareAgentSessionInput,
  PrepareResult,
} from "./agent-session-lifecycle.js";

/**
 * Minimal surface the engine needs from the agent runtime (structural): the
 * prepared-session lifecycle for a fresh reviewer (design §10.4 — prepare
 * without spawning, activate with the prompt, cancel to a tombstone) and the
 * plain message path for everything that talks to an already-active session.
 */
export interface AgentOps {
  /** Lifecycle `prepare`: a pending reviewer identity — no process, no sidebar. */
  prepareReviewer(input: PrepareAgentSessionInput): Promise<PrepareResult>;
  /** Lifecycle `activate`: spawn + first instruction under a run-scoped key. */
  activateReviewer(input: ActivateAgentSessionInput): Promise<ActivationResult>;
  /** Lifecycle `cancel`: a pending reviewer becomes a tombstone; active rows are left alone. */
  cancelReviewer(input: CancelPreparedSessionInput): Promise<CancelResult>;
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
  /**
   * Raw sparse entries (holes preserved) — index space matches entry indices.
   * Async because a dormant session's transcript is read from storage.
   */
  getRawMessages(sessionId: string): Promise<AgentMessage[]>;
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
 *
 * The blocking bar is stated before the list because "blocking" is otherwise
 * read as "anything I would have done differently": reviewers with no cost
 * model escalate speculative hardening and taste into blockers, and the author
 * side of the loop then pays for it in complexity. Worth-fixing AND real is the
 * bar in both directions — it licenses genuine defects as much as it filters
 * over-engineering.
 */
const VERDICT_INSTRUCTIONS = [
  "\nThe bar for blocking: a real defect that is worth fixing — wrong behavior, a case a user or caller will actually hit, a security or data-loss risk, or a missing test for logic that matters. Report those plainly; do not soften a real problem because the fix is inconvenient.",
  "Not blocking: over-engineering — speculative hardening, defenses against inputs this code cannot receive, abstractions or configurability for cases nobody has asked for, or a rewrite in your preferred style. When the fix would add more complexity than the problem it prevents is worth, it is a non-blocking note at most.",
  "Both halves matter equally: solve real problems, and do not over-engineer.",
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
  /**
   * Blind review ("Blind" in the review dialog): withhold every
   * session-derived section — brief, verbatim excerpts, author self-report —
   * and tell the reviewer to infer intent from the repository alone. The
   * point is an unanchored second look: any author narrative would re-import
   * the assumptions the user asked to escape. Repo-derived context (scope,
   * git history) stays — it is evidence, not narrative.
   */
  blind?: boolean;
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
  const blind = opts.blind === true;
  // In single-turn sessions the first user message IS the turn's task — don't
  // print it twice.
  const intent = !blind && opts.originalIntent !== opts.taskContext ? opts.originalIntent : null;
  const brief = blind ? null : opts.intentBrief || null;
  const taskContext = blind ? null : opts.taskContext;
  const selfReport = blind ? null : opts.authorSelfReport;
  const hasExcerpt = Boolean(intent || taskContext || selfReport);
  const scope = opts.scope && opts.scope.changedFiles.length > 0 ? opts.scope : null;
  // A no-diff turn whose author left a substantial self-report was almost
  // certainly an analysis/plan turn: the deliverable IS that reasoning, not a
  // diff. Point the reviewer at it instead of declaring "nothing in scope".
  const noDiffWithAnalysis =
    Boolean(selfReport) && (selfReport as string).trim().length >= SELF_REPORT_MIN_CHARS;
  return [
    "You are a code reviewer agent. Another agent just completed work in this workspace; review it critically and independently.",
    blind
      ? "\n## Independent review\nBy design you have been given no context from the conversation that produced this work — no task statement, no author summary. Infer the intent from the change itself, the repository, and its history, and open your verdict message by stating that inferred intent in one or two sentences. Do not assume any agreement, exemption, or constraint that is not evidenced in the repository; if a behavior looks wrong but could plausibly be intentional, report it marked \"possibly intended — needs author confirmation\" rather than staying silent."
      : null,
    brief ? `\n## Intent brief (distilled from the source conversation)\n${brief}` : null,
    !brief && intent ? `\n## Original request (the user's first message in this session, verbatim)\n${intent}` : null,
    // Deliberately not titled "Original task": in confirmation-style
    // conversations the latest message is often just "ok" — informative as
    // the user's last word, misleading as a statement of the task.
    !brief && taskContext ? `\n## Latest user message (verbatim)\n${taskContext}` : null,
    selfReportSection(selfReport),
    opts.reviewFocus ? `\n## Review focus (from the user)\n${opts.reviewFocus}` : null,
    scope
      ? `\n## Scope — the change under review\n\nThe reviewed turn changed exactly these files:\n${scope.changedFiles.map((f) => `- \`${f}\``).join("\n")}\n\nIt starts from commit \`${scope.startHead}\` — use \`git diff ${scope.startHead} -- <file>\` and \`git log ${scope.startHead}..HEAD\` to see the content.\n\nConfine your review to these files and changes. Other uncommitted or pre-existing changes in the worktree, or changes from other turns, are out of scope unless this change depends on them.`
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
    blind
      ? "- Judge correctness and code quality on the change's own evidence — there is no task statement to judge completeness against. Be specific: reference files and lines."
      : noDiffWithAnalysis
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
    // "deliberately withheld" vs the tier-3 "was unavailable": both are
    // workspace-only prompts, but post-hoc attribution must be able to tell a
    // user choice from a degradation.
    blind
      ? "\n(review context: independent review — session context deliberately withheld; live workspace only)"
      : brief
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
  /**
   * Epoch ms of the reviewer session's last activity, so the UI can say how
   * stale the reused context is. Optional on the wire: workers older than the
   * field simply omit it and the caller shows no timestamp.
   */
  lastActiveAt?: number | null;
  reason: ReviewerCandidateUnavailableReason | null;
}

export const REVIEWER_AGENT_TYPES = new Set<AgentType>(["claude-code", "codex"]);

/**
 * How long a run may sit in `preparing` before the engine fails it. The
 * activation call comes from whoever distills the intent brief — this process
 * for local reviews, the hub over the tunnel for remote ones — and that caller
 * can die without a trace (hub restart mid-distill, tunnel drop). Distillation
 * normally takes 1–2 minutes; ten is decisively "not coming back".
 */
export const PREPARE_TIMEOUT_MS = 10 * 60_000;

/**
 * Prompt inputs captured at prepare time and carried in memory to activation.
 * Captured then, not rebuilt at activation, because the source conversation
 * may keep moving while the brief distills — a late rebuild could read past
 * the reviewed turn. Lost on restart; activation then recomputes from the
 * stored cutoff (and degrades scope to null, since the snapshots backing it
 * were in memory too).
 */
interface PendingActivation {
  scope: { changedFiles: string[]; startHead: string } | null;
  taskContext: string | null;
  originalIntent: string | null;
  authorSelfReport: string | null;
}

function parsePreparedContext(raw: string | null | undefined): PendingActivation | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingActivation>;
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      scope: parsed.scope ?? null,
      taskContext: parsed.taskContext ?? null,
      originalIntent: parsed.originalIntent ?? null,
      authorSelfReport: parsed.authorSelfReport ?? null,
    };
  } catch {
    return undefined;
  }
}

/** The run-scoped activation key: one prompt per run, replay-safe (§10.4). */
export function reviewerActivationKey(runId: string): string {
  return `review:${runId}`;
}

function describePrepareFailure(result: Exclude<PrepareResult, { kind: "prepared" | "replayed" }>): string {
  switch (result.kind) {
    case "expired": return "reviewer 的准备身份已过期或被取消";
    case "idempotency_conflict": return `reviewer 身份冲突：${result.detail}`;
    case "workspace_unavailable": return `workspace 不可用：${result.detail}`;
  }
}

function describeActivationFailure(result: Exclude<ActivationResult, { kind: "activated" | "replayed" | "uncertain" | "in_progress" }>): string {
  switch (result.kind) {
    case "resident_limit": return "常驻 agent 进程已达上限，无法启动 reviewer";
    case "expired": return "reviewer 的准备身份已过期或被取消";
    case "not_found": return "reviewer session 不存在";
    case "idempotency_conflict": return "reviewer 首条指令与已记录的内容不一致";
    case "activation_conflict": return "reviewer 已被其它操作激活";
    case "retryable_failure": return `向 reviewer 投递任务失败（${result.errorCode}）`;
    case "permanent_failure": return `reviewer 无法启动（${result.errorCode}）`;
  }
}

export interface AdhocReviewOptions {
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
   * Consumed at activation, not preparation.
   */
  intentBrief?: string;
  /**
   * Blind review: withhold all session-derived context from the reviewer
   * prompt (see buildReviewerPrompt). Fresh reviewers only — a reused
   * reviewer already carries earlier rounds' context, so blind would be a
   * fiction there; routes reject the combination.
   */
  blind?: boolean;
  /** Existing reviewer session to continue. Mutually exclusive with reviewerAgentType. */
  reviewerSessionId?: string;
  /** Agent that runs the review; defaults to claude-code. */
  reviewerAgentType?: AgentType;
  /** Stable identities supplied by a hub durable-intent replay. */
  runId?: string;
  newReviewerSessionId?: string;
}

export class WorkflowEngine {
  private eventBus?: EventBus;
  /** sessionId → participation in an active run (rebuilt on boot). */
  private participants = new Map<string, Participant>();
  /** runId → prompt inputs captured at prepare time (see PendingActivation). */
  private pendingActivations = new Map<string, PendingActivation>();
  /** runId → armed preparation-timeout timer. */
  private prepareTimers = new Map<string, NodeJS.Timeout>();
  /** runId → in-flight activation, so concurrent calls join instead of double-sending. */
  private activationFlights = new Map<string, Promise<WorkflowRun>>();

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
      } else if (run.status === "preparing") {
        // Restart lost the in-memory prompt inputs, but the activation call
        // may still arrive (a hub distilling for a remote review survives a
        // worker restart). Give it the remainder of the window, then fail
        // visibly instead of leaving the placeholder spinning forever.
        const createdAt = Date.parse(
          run.created_at.includes("T") ? run.created_at : run.created_at.replace(" ", "T") + "Z",
        );
        const elapsed = Number.isFinite(createdAt) ? Date.now() - createdAt : PREPARE_TIMEOUT_MS;
        this.armPrepareTimeout(run.id, PREPARE_TIMEOUT_MS - elapsed);
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
    this.clearPendingActivation(run.id);
  }

  private clearPendingActivation(runId: string): void {
    this.pendingActivations.delete(runId);
    const timer = this.prepareTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.prepareTimers.delete(runId);
    }
  }

  /**
   * Backstop for a run stuck in `preparing` (see PREPARE_TIMEOUT_MS). A timed
   * out preparation becomes a normal failed run — visible in the UI and as a
   * workflow_failed milestone — instead of a placeholder that spins forever.
   * `unref` so an armed timer never holds the process open.
   */
  private armPrepareTimeout(runId: string, delayMs: number): void {
    const existing = this.prepareTimers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.prepareTimers.delete(runId);
      void (async () => {
        const run = await this.storage.workflowRuns.getById(runId);
        if (run?.status === "preparing") {
          await this.failRun(run, "review 准备超时：intent brief 的生成方没有回来激活 reviewer。可结束后重新发起。");
        }
        this.pendingActivations.delete(runId);
      })().catch((err) => console.error("[WorkflowEngine] prepare-timeout sweep failed:", err));
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.prepareTimers.set(runId, timer);
  }

  private releaseReservations(runId: string): void {
    for (const [sid, participant] of this.participants) {
      if (participant.runId === runId) this.participants.delete(sid);
    }
  }

  /**
   * A run that ends before its fresh reviewer was activated leaves that
   * reviewer as a pending identity nobody will ever activate. Cancel it to a
   * tombstone (lifecycle §11.1) so the row can never surface or be replayed
   * into a session. An already-active reviewer (reuse, or activation won the
   * race) reports `not_pending` and is deliberately left untouched — the user
   * may still want to read it.
   */
  private async expirePendingReviewer(run: WorkflowRun, reason: "cancelled" | "owner_failed"): Promise<void> {
    if (!run.reviewer_session_id) return;
    try {
      await this.agentOps.cancelReviewer({ sessionId: run.reviewer_session_id, reason });
    } catch (err) {
      console.warn(`[WorkflowEngine] failed to cancel pending reviewer ${run.reviewer_session_id} for run ${run.id}:`, err);
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
    if (failed) {
      this.untrackRun(failed);
      if (from === "preparing") await this.expirePendingReviewer(failed, "owner_failed");
      // Push, don't just persist: a failed run leaves the active set, so pull
      // paths (active-run list) go blank — the reviewer window's failure view
      // and the source panel both live off this pushed terminal frame.
      this.emitRunUpdated(failed);
    }
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
      lastActiveAt: null,
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
      lastActiveAt: reviewerProjection.lastActiveAt,
      reason: null,
    };
  }

  /**
   * Single-shot start, preserved for old callers and durable-intent replays:
   * prepare + activate back to back. The reuse-reviewer path delivers its
   * prompt inside prepare (no preparing state — nothing distills for a
   * re-review); a fresh reviewer comes back `preparing` and is activated
   * inline, which also completes a replayed run that a previous caller
   * prepared but never activated.
   */
  async startAdhocReview(opts: AdhocReviewOptions): Promise<WorkflowRun> {
    const run = await this.prepareAdhocReview(opts);
    if (opts.reviewerSessionId || run.status !== "preparing") return run;
    return this.activateAdhocReview(run.id, { intentBrief: opts.intentBrief, blind: opts.blind });
  }

  /**
   * Phase 1 of the two-phase adhoc review: validate, reserve participants,
   * create the run row and (for a fresh review) a PENDING reviewer identity —
   * no process, absent from every sidebar/alive projection (design §10.4) —
   * WITHOUT sending the reviewer prompt. Fast
   * (no model calls), so the route can respond immediately and let the
   * intent-brief distillation happen after the user has moved on. The run
   * stays `preparing` until activateAdhocReview delivers the first message,
   * bounded by PREPARE_TIMEOUT_MS.
   */
  async prepareAdhocReview(opts: AdhocReviewOptions): Promise<WorkflowRun> {
    if (opts.reviewerSessionId === opts.sourceSessionId) {
      throw new WorkflowError("reviewer-unavailable", "reviewer session 不能与 source session 相同");
    }
    if (opts.reviewerSessionId && opts.newReviewerSessionId) {
      throw new WorkflowError("reviewer-unavailable", "不能同时复用和新建 reviewer session");
    }
    if (opts.blind && opts.reviewerSessionId) {
      throw new WorkflowError("reviewer-unavailable", "blind review 不能复用已有 reviewer session");
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
        // A `preparing` result flows back to startAdhocReview, whose inline
        // activation completes a run that an earlier caller prepared but
        // never activated (hub died mid-distill, replay arrives here).
        return existingRun;
      }
      if (existingRun.status !== "waiting_reviewer" && existingRun.status !== "preparing") {
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

      const entries = await this.agentOps.getRawMessages(opts.sourceSessionId);
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
          // Reuse skips the preparing state entirely: its prompt is delivered
          // below, before this method returns.
          status: opts.reviewerSessionId ? "waiting_reviewer" : "preparing",
        });
      this.trackParticipants(run);

      // Legacy durable replay: a run created by a pre-two-phase caller was
      // born `waiting_reviewer` and died before binding its reviewer. Move it
      // into `preparing` so activation owns delivering the prompt — otherwise
      // the inline activation in startAdhocReview would see a non-preparing
      // run and skip the send, leaving a bound reviewer that never hears
      // anything.
      if (existingRun && !existingRun.reviewer_session_id && !opts.reviewerSessionId
          && run.status === "waiting_reviewer") {
        const flipped = await this.storage.workflowRuns.transition(run.id, "waiting_reviewer", "preparing");
        if (!flipped) throw new WorkflowError("bad-state", "run 在重放期间已被取消或失败");
        run.status = "preparing";
      }

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
        //
        // Lifecycle `prepare` (design §10.4): an identity only. Nothing
        // spawns, no resident slot is taken and the reviewer is in no sidebar
        // projection until activation delivers its prompt — a prepare that
        // times out or is cancelled leaves a tombstone, not a process. The
        // run id is the prepare key, so a durable replay gets the same row.
        const prepared = await this.agentOps.prepareReviewer({
          operationId: run.id,
          ...(opts.newReviewerSessionId ? { sessionId: opts.newReviewerSessionId } : {}),
          projectId: opts.project.id,
          branch: opts.branch,
          permissionMode: "plan",
          agentType: (opts.reviewerAgentType ?? "claude-code") as AgentType,
          purpose: "workflow_review",
          owner: { kind: "workflow_run", id: run.id },
          startSnapshot: endSnap,
        });
        if (prepared.kind !== "prepared" && prepared.kind !== "replayed") {
          throw new Error(describePrepareFailure(prepared));
        }
        const reviewerId = prepared.view.sessionId;
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
        // Prompt inputs are captured NOW — at review start — and carried to
        // activation in memory (see PendingActivation for why not rebuilt
        // later, and what happens to them across a restart).
        const pendingContext: PendingActivation = {
          scope,
          taskContext,
          originalIntent: extractFirstUserMessage(entries),
          authorSelfReport: extractAuthorSelfReport(entries, turnEndIndex),
        };
        this.pendingActivations.set(run.id, pendingContext);
        const updated = await this.storage.workflowRuns.update(run.id, {
          reviewer_session_id: reviewerId,
          // Durable copy of the prompt inputs (§10.4): a restart between
          // prepare and activate rebuilds the same prompt from here.
          prepared_context: JSON.stringify(pendingContext),
          // Legacy replay backfill: a durable run interrupted before reviewer
          // binding may carry no stored target. Activation builds the prompt
          // from the stored one, so persist the target just captured (same
          // worktree, cutoff verified above to match the stored run).
          ...(run.review_target ? {} : { review_target: JSON.stringify(target) }),
        });
        this.trackParticipants(updated!);
        this.armPrepareTimeout(run.id, PREPARE_TIMEOUT_MS);
        this.emitRunUpdated(updated!);
        return updated!;
      } catch (err) {
        await this.failRun(run, `创建 reviewer 失败：${err instanceof Error ? err.message : String(err)}`);
        throw new WorkflowError("spawn-failed", "创建 reviewer session 失败");
      }
    } catch (err) {
      if (!existingRun) this.releaseReservations(runId);
      throw err;
    }
  }

  /**
   * Phase 2 of the two-phase adhoc review: build the reviewer prompt and send
   * the first message. Called after the intent brief finished distilling —
   * inline for single-shot starts, in the background (or over the tunnel, for
   * remote reviews) after the route already responded. Idempotent: replaying
   * an already-activated run returns it unchanged, which the durable-intent
   * replay path relies on.
   */
  async activateAdhocReview(
    runId: string,
    opts: { intentBrief?: string; blind?: boolean } = {},
  ): Promise<WorkflowRun> {
    // Same-process dedup is sufficient: every activation of a run lands on the
    // engine that owns it — the local engine, or this worker via its activate
    // route (the hub only retries requests that never arrived).
    const existing = this.activationFlights.get(runId);
    if (existing) return existing;
    const flight = this.runActivation(runId, opts);
    this.activationFlights.set(runId, flight);
    const clear = () => {
      if (this.activationFlights.get(runId) === flight) this.activationFlights.delete(runId);
    };
    flight.then(clear, clear);
    return flight;
  }

  private async runActivation(
    runId: string,
    opts: { intentBrief?: string; blind?: boolean },
  ): Promise<WorkflowRun> {
    const run = await this.storage.workflowRuns.getById(runId);
    if (!run) throw new WorkflowError("bad-state", "run 不存在，无法激活");
    if (run.status !== "preparing") {
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new WorkflowError("bad-state", "run 已结束，无法激活");
      }
      return run;
    }
    if (!run.reviewer_session_id) {
      // A crash between run creation and reviewer creation left nothing to
      // prompt. The durable replay recreates the reviewer via
      // startAdhocReview; direct activation cannot.
      throw new WorkflowError("bad-state", "run 还没有 reviewer session，无法激活");
    }
    if (!run.review_target) {
      throw new WorkflowError("bad-state", "run 缺少 review target，无法激活");
    }
    // The send happens while the run is still `preparing` — the recoverable
    // state. Claiming waiting_reviewer BEFORE the send would open a window
    // where a crash or hung send leaves a prompt-less run that presents as
    // reviewing forever and that replayed activation skips (not `preparing`
    // anymore). Staying `preparing` keeps every recovery path live: the
    // preparation timeout (re-armed on boot) fails a run whose send died, and
    // a replay re-enters here and re-sends. The price is at-least-once
    // delivery — a crash after the send but before the CAS below re-prompts
    // the reviewer on replay — which beats a silently stuck run. Concurrent
    // duplicates are excluded by the in-flight map in activateAdhocReview; a
    // concurrent cancel by the CAS after the send. The pending inputs and the
    // timer are cleared only on a known outcome (CAS success below, or
    // failRun's untrackRun).
    const pending = this.pendingActivations.get(runId) ?? parsePreparedContext(run.prepared_context);
    let outcome: ActivationResult;
    try {
      // Last-resort fallback for legacy rows prepared before the context was
      // persisted: recompute from the stored cutoff. Scope is unrecoverable
      // there and degrades to "scope unknown" rather than blocking.
      const entries = pending ? null : await this.agentOps.getRawMessages(run.source_session_id);
      const prompt = buildReviewerPrompt({
        taskContext: pending
          ? pending.taskContext
          : extractTaskContextBefore(entries!, run.source_turn_end_index),
        originalIntent: pending ? pending.originalIntent : extractFirstUserMessage(entries!),
        authorSelfReport: pending
          ? pending.authorSelfReport
          : extractAuthorSelfReport(entries!, run.source_turn_end_index),
        intentBrief: opts.intentBrief ?? null,
        blind: opts.blind,
        reviewFocus: run.review_focus,
        target: JSON.parse(run.review_target) as ReviewTarget,
        scope: pending?.scope ?? null,
      });
      // Lifecycle `activate` (§10.4): hydrate + spawn + first instruction
      // under a run-scoped key, so a replayed activation returns the same
      // outcome instead of prompting the reviewer twice.
      outcome = await this.agentOps.activateReviewer({
        sessionId: run.reviewer_session_id,
        activationKey: reviewerActivationKey(run.id),
        instruction: prompt,
        ...REVIEWER_TURN,
      });
    } catch (err) {
      await this.failRun(run, `激活 reviewer 失败：${err instanceof Error ? err.message : String(err)}`);
      throw new WorkflowError("spawn-failed", "激活 reviewer session 失败");
    }
    switch (outcome.kind) {
      case "activated":
      case "replayed":
        break;
      case "in_progress":
        // Another activation of this run holds the lease (a hub retry that
        // raced this one). Its outcome will move the run; nothing to do here.
        return run;
      case "uncertain": {
        // The prompt is durable but stdin acceptance is unprovable (§5.2).
        // Never re-send: move on with an honest note so a reviewer that did
        // start can still complete the run, and the user can end it if not.
        const claimed = await this.storage.workflowRuns.transition(runId, "preparing", "waiting_reviewer", {
          error: "reviewer 首次指令投递结果未知：服务在投递期间中断。若 reviewer 没有开始工作，请结束本次 review 后重新发起。",
        });
        if (!claimed) throw new WorkflowError("bad-state", "run 在准备期间已被取消或失败");
        this.clearPendingActivation(runId);
        const updated = (await this.storage.workflowRuns.getById(runId))!;
        this.emitRunUpdated(updated);
        return updated;
      }
      default: {
        const message = describeActivationFailure(outcome);
        await this.failRun(run, message);
        throw new WorkflowError("spawn-failed", message);
      }
    }
    const claimed = await this.storage.workflowRuns.transition(runId, "preparing", "waiting_reviewer");
    if (!claimed) {
      // Cancel or preparation timeout won during the send. The prompt reached
      // a run that is no longer live — harmless: handleTaskCompleted gates on
      // waiting_reviewer, so the reviewer's completion is ignored.
      throw new WorkflowError("bad-state", "run 在准备期间已被取消或失败");
    }
    this.clearPendingActivation(runId);
    const updated = (await this.storage.workflowRuns.getById(runId))!;
    this.emitRunUpdated(updated);
    return updated;
  }

  private async handleTaskCompleted(event: Extract<GlobalEvent, { type: "session:taskCompleted" }>): Promise<void> {
    const p = this.participants.get(event.sessionId);
    if (!p || p.role !== "reviewer") return;
    const run = await this.storage.workflowRuns.getById(p.runId);
    if (!run || run.status !== "waiting_reviewer") return;

    const entries = await this.agentOps.getRawMessages(event.sessionId);
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
      (await this.storage.workflowRuns.transition(runId, "preparing", "cancelled", patch)) ||
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
      if (run.status === "preparing") await this.expirePendingReviewer(updated, "cancelled");
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
        await this.storage.workflowRuns.transition(p.runId, "waiting_feedback", "discussing", { error: null })
          || await this.storage.workflowRuns.transition(p.runId, "waiting_reviewer", "discussing", { error: null });
        // Broadcast regardless of whether the CAS moved anything. The run is
        // already `discussing` on every message after the first one, and
        // gating the frame on the transition left that case with no frame at
        // all — a client that missed the one frame we did send had nothing to
        // recover from. Re-broadcasting the current row is idempotent on both
        // consumers (the panel just refreshes; useReviewerRun re-sets the same
        // value), so unconditional delivery costs nothing and closes the hole.
        const updated = await this.storage.workflowRuns.getById(p.runId);
        if (updated) this.emitRunUpdated(updated);
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
