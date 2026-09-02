import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { WebSocket } from "@fastify/websocket";
import type { AgentSession as AgentSessionRow, Storage } from "./storage/types.js";
import type {
  AgentMessage,
  AgentSessionStatus,
  AgentType,
  ContentPart,
  NotificationDisposition,
  TurnOutcome,
} from "./agent-types.js";
import {
  findTurnOpeningUserEntry,
  findLatestUserEntry,
  resolveNotificationDisposition,
  sessionMilestoneForTurnEnd,
} from "./notification-milestones.js";
import { getProvider } from "./providers/index.js";
import type { ParsedAgentEvent } from "./agent-provider.js";
import { crossRemoteMcpEnabled, mintCrossRemoteMcpConfig, type CrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
import { mintSessionToolsMcpConfig } from "./session-tools-mcp.js";
import { getBinaryVersion } from "./protocol/shared/binary.js";
import { ConversationPatch, type Patch, type AgentWsMessage } from "./conversation-patch.js";
import type { EventBus } from "./event-bus.js";
import { EntryIndexProvider, EntryTracker } from "./entry-index-provider.js";
import { getRegisteredWorktreeBranches, resolveWorktreePath } from "./utils/worktree-paths.js";
import { generateSessionTitle, snippetTitle, extractUserText } from "./utils/session-title.js";
import { recordTurnSnapshot, type SnapshotState } from "./utils/review-snapshot.js";
import { logSessionLifecycle, type SessionPurpose } from "./session-lifecycle-log.js";
import {
  BranchActivityDedupe,
  computeBranchActivity,
  type BranchActivity,
  type BranchActivityState,
} from "./branch-activity.js";
import {
  normalizeAgentProcessSettings,
  pickIdleResidentEvictionCandidate,
  ResidentProcessLimitError,
  type AliveAgentSession,
  type ResidentProcessScope,
  type RunningResidentProcess,
} from "./resident-agent-processes.js";
import {
  COMPLETION_GRACE_MS,
  PARK_TIMEOUT_MS,
  TurnCompletionLedger,
  type CompletionAction,
  type CompletionPayload,
} from "./turn-completion.js";

/**
 * Build a user-facing message for when an agent process fails to start.
 *
 * Both streams are folded in: claude reports an unusable --model on STDOUT
 * (verified 2026-07-26 against claude 2.1.220 — exit 1, stderr empty), and
 * that line is not stream-json so it never becomes a parsed event. Without the
 * stdout tail the user would see only a "did you install it?" hint for a CLI
 * that is plainly installed.
 *
 * The install hint is suppressed only when the agent spoke on STDOUT: that is
 * the stream a launched CLI diagnoses itself on, so output there means the
 * binary plainly exists and the problem is its arguments. STDERR is NOT
 * evidence of that — the primary "not installed" path after ENOENT is the npx
 * fallback failing to fetch the package, which writes `npm ERR! …` to stderr
 * and exits non-zero. Keying off stderr would drop the hint in exactly the
 * case it was written for. Codex is a second instance: its JSON-RPC `response`
 * frames parse to zero events, so a codex process that dies after `initialize`
 * has an unparsed stdout tail full of protocol noise and no hint would be
 * lost — but that noise is on stdout, which is the correct signal.
 *
 * Hint and details are independent: both can appear in one message.
 */
export function buildStartupFailureMessage(
  agentType: AgentType,
  stderrTail: string,
  stdoutTail: string,
): string {
  const provider = getProvider(agentType);
  const name = provider.getDisplayName();
  const details = [stdoutTail.trim(), stderrTail.trim()].filter(Boolean).join("\n");
  const hint = stdoutTail.trim() ? undefined : provider.getInstallHint?.();

  let msg = `Couldn't start ${name}.`;
  if (hint) msg += `\n\n${hint}`;
  if (details) msg += `\n\nDetails:\n${details}`;
  return msg;
}

// ============ Session Store Types ============

/** Max chars of the agent's final message carried in the taskCompleted event. */
const SUMMARY_TEXT_CAP = 1500;

/**
 * Pull the agent's last assistant message out of the store so the orchestrator
 * chat can summarize a completed task without a round-trip to read history.
 * Entries are sparse (indices assigned non-contiguously) so scan from the end
 * skipping holes; truncate to keep the event small and bound injection surface.
 */
function extractLastAssistantText(entries: AgentMessage[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "assistant") continue;
    const text = entry.content?.trim();
    if (!text) continue;
    return text.length > SUMMARY_TEXT_CAP
      ? text.slice(0, SUMMARY_TEXT_CAP) + "… (truncated — read full history for detail)"
      : text;
  }
  return undefined;
}

interface MessageStore {
  /** All patches sent for this session (for history replay) */
  patches: Patch[];
  /** Reconstructed entries from patches (for quick access) */
  entries: AgentMessage[];
  /** Index provider for monotonic indices */
  indexProvider: EntryIndexProvider;
  /** Tracks tool_use/tool_result blocks by ID to prevent duplicates from streaming replays */
  toolTracker: EntryTracker;
  /** Index of the current streaming assistant message, or null if not streaming */
  currentAssistantIndex: number | null;
}

interface RunningSession {
  id: string;
  projectId: string;
  branch: string | null;
  workspaceCheckoutId: string | null;
  /** Last validated path for snapshots while the process is already running. */
  checkoutPath: string | null;
  process: ChildProcess | null;
  dormant: boolean; // true when restored from DB (no process yet)
  /**
   * How many operations are currently on their way to spawning a process for
   * this session — a wake, or a restart. Incremented SYNCHRONOUSLY before the
   * operation's first `await`, so a retention sweep can never observe the
   * "still dormant, no process" window such an operation is already committed
   * to leaving (docs/plans/2026-08-08-session-retention.md §1.5). The
   * mirror-image guard, `retentionDeleting`, lives on the manager.
   *
   * A COUNT, not a flag: two messages can wake the same dormant session
   * concurrently (both see `dormant === true`, since it is only cleared after
   * the checkout lookup), and with a boolean the first one to finish would
   * clear the guard out from under the second — handing retention a session
   * that is still mid-spawn. Same for a wake overlapping a restart.
   */
  processStartsInFlight: number;
  /** Durable generation of this session's entry-index namespace. */
  historyEpoch: number;
  store: MessageStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  buffer: string; // Buffer for incomplete JSON lines
  skipDb: boolean; // Skip DB operations for remote path-based sessions
  permissionMode: "plan" | "edit"; // Claude Code permission mode
  agentType: AgentType; // Which agent provider to use
  /**
   * Per-session agent model, or null for the CLI default. Read at spawn time
   * and re-read from the DB on every respawn path, so it can be changed
   * whenever no turn is in flight (see `setModel`) — never while one is.
   */
  model: string | null;
  /**
   * The agent CLI's own session id (Claude Code system/init session_id,
   * Codex thread/start thread.id). In-memory dedupe only — the durable copy
   * lives on agent_sessions.native_session_id.
   */
  nativeSessionId?: string;
  /**
   * Send-back pointer: the session this one was branched from, or absent for
   * non-branch sessions and pre-feature branches. Mirror of
   * agent_sessions.branched_from_session_id; may dangle once the parent is
   * retention-deleted, so consumers must re-resolve the target before use.
   */
  branchedFromSessionId?: string | null;
  /**
   * The turn_end entry index the branched copy ended at. Entry indices are
   * preserved by the copy, so dividers ABOVE this index are inherited history
   * (send-back would echo the parent's own content) and only dividers beyond
   * it are turns this branch produced itself.
   */
  branchedFromEntryIndex?: number | null;
  producedOutput?: boolean; // Whether the current process has emitted any parsed agent output (reset per spawn)
  /** Tail of stdout lines that produced no parsed events (reset per spawn). */
  unparsedStdoutTail?: string;
  /**
   * Turn-completion state machine (see turn-completion.ts): tracks live
   * background tasks and decides whether a `result` commits completion side
   * effects immediately, defers them (tasks still running), or holds them
   * for a grace window (tasks ran this turn, an auto-resume may be queued).
   * Reset per spawn and on stopSession/hibernate/agent switch.
   */
  completion: TurnCompletionLedger;
  /** Live grace timer for a held completion candidate, if any. */
  graceTimer: NodeJS.Timeout | null;
  /** Bound on a parked completion — see PARK_TIMEOUT_MS. */
  parkTimer: NodeJS.Timeout | null;
  /**
   * Per-session serial work queue. Stdout chunks, the grace-timer commit,
   * and process-exit handling all run through it, so a completion commit
   * can never interleave with the event that should cancel it (handleStdout
   * awaits storage calls, and the stdout data callback can't await).
   */
  eventChain: Promise<void>;
  /**
   * Protocol-drift detection, both counted since the last `result`. A
   * `run_in_background: true` tool_use input is a model request parameter
   * (very unlikely to change shape); if a turn contains one but no
   * task_started system event arrived, the CLI's task-lifecycle event names
   * have probably changed — warn loudly instead of silently reverting to
   * premature-completion behavior.
   */
  bgSpawnHintsThisTurn: number;
  taskStartedThisTurn: number;
  lastActiveAt: number;
  /**
   * Wall-clock start of the currently open user turn, or null when no turn
   * is in flight. Cleared by endActiveTurn after the turn_end entry is
   * written. Two openers, both guarded on "no turn already open":
   *  - sendUserMessage, when the send finds the session idle (accurate start,
   *    and the turn is open before any output can race in), and
   *  - processAgentEvent, on turn_started / first turn activity, for turns
   *    that start inside the process with no send behind them (a queued
   *    message the CLI held until the previous turn ended, a background
   *    auto-resume). A message sent mid-turn deliberately does NOT open one:
   *    it either gets injected into the running turn, or the CLI starts its
   *    turn later and processAgentEvent opens it then.
   * In-memory only — a crash mid-turn is repaired by restoreSessionsFromDb
   * (see repairInterruptedTurn).
   */
  turnOpenSince: number | null;
  /**
   * Notification disposition of the currently open turn, set alongside
   * `turnOpenSince` and cleared with it. Resolved from the send's intent when
   * the send opens the turn, and from the latest user entry in history
   * (findLatestUserEntry) when the process does — a turn opened in-process has
   * no send to ask, and the queued message that owns it sits before the
   * previous turn_end, out of findTurnOpeningUserEntry's reach.
   * The same value is ALSO persisted on the opening user entry, which is what
   * lets crash repair recover it after this field is gone.
   */
  turnDisposition: NotificationDisposition | null;
  /** Injected at spawn, never persisted: a token is useless once the process holding it exits. */
  crossRemoteMcp?: CrossRemoteMcpConfig;
  /**
   * The authenticated owner, when known — used to re-mint the cross-remote
   * token on every spawn so a wake never reuses one past its exp. Only real
   * user ids are stored; the "local" solo sentinel is filtered at every write
   * (solo mode deliberately mints no cross-remote token). Never set on
   * workers: their sessions are created over the tunnel without user auth,
   * which is what keeps worker-side self-minting off.
   */
  userId?: string;
  /**
   * Phase 0 lifecycle observability (session-lifecycle-log.ts). Set only by
   * createNewSession — restored/branched sessions have no first-instruction
   * window to measure. `firstInstructionAccepted` flips once, on the first
   * provider-accepted send, so a session logs exactly one accept/reject.
   */
  lifecycle?: {
    purpose: SessionPurpose;
    operationId?: string;
    createdAt: number;
    firstInstructionAccepted: boolean;
  };
}

/** Options for `sendUserMessage`; see `onUserEntryPersisted` for the lifecycle hook. */
export interface FirstSendOptions {
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  /**
   * Called once the user entry is persisted and before the provider stdin
   * write. Only the lifecycle service sets it (activation evidence, §8.2).
   */
  onUserEntryPersisted?: (entryIndex: number) => Promise<void>;
}

/**
 * Result of `branchSession`. `not-found`: source session unknown.
 * `empty-history`: source has no persisted entries to copy (or none survive
 * the cutoff). `invalid-cutoff`: `upToEntryIndex` doesn't land on a
 * `turn_end` row. `running-needs-cutoff`: no-cutoff branch requested while
 * the source is running — refused so a half-finished turn is never copied.
 */
export type BranchResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not-found" | "empty-history" | "invalid-cutoff" | "running-needs-cutoff" };

export class WorkspaceCheckoutUnavailableError extends Error {
  readonly code = "workspace_checkout_unavailable";
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCheckoutUnavailableError";
  }
}

export class AgentSessionManager {
  private sessions: Map<string, RunningSession> = new Map();
  private storage: Storage;
  private eventBus: EventBus | null = null;
  /**
   * Single source of truth for `branch:activity` emit dedupe. All call sites
   * that publish branch activity go through `emitDerivedBranchActivity` /
   * `emitBranchActivityIfChanged`, which check this gate before emitting.
   */
  private branchActivityDedupe = new BranchActivityDedupe();
  /** Sessions for which title generation is currently in flight or already done. */
  private titleResolved: Set<string> = new Set();
  /**
   * Reverse-connect (remote-node) mode disables local title generation. The
   * upstream server runs `generateAndPushRemoteSessionTitle` and PATCHes the
   * result back, so generating here would waste tokens and emit a duplicate
   * Langfuse trace tagged `userId="local"` (the remote node has no Clerk auth).
   * Set to true from `vibedeckx connect` after `createServer`.
   */
  suppressTitleGeneration: boolean = false;
  /**
   * Loopback base URL of this process's own HTTP server (e.g.
   * "http://127.0.0.1:5173"), set by server.start/startLocal once bound. Agent
   * processes are spawned by this same process, so this is how they reach the
   * session-scoped MCP tools. Null until the server listens, and under local
   * TLS termination — in both cases the tools are simply not offered.
   */
  localApiOrigin: string | null = null;
  private capacityQueue: Promise<void> = Promise.resolve();
  /**
   * Sessions whose retention delete has passed its re-check and is in flight.
   * The mirror image of `RunningSession.processStartsInFlight`: together they
   * cover both orderings of the race, because each side plants its marker
   * synchronously before its own first `await`, so there is no instant at
   * which neither can see the other
   * (docs/plans/2026-08-08-session-retention.md §1.5).
   */
  private retentionDeleting: Set<string> = new Set();
  /**
   * User-message deliveries that have synchronously claimed a session but
   * may still be suspended on checkout validation or persistence. A counter
   * (not a Set) is required because callers can overlap.
   */
  private userMessagesInFlight: Map<string, number> = new Map();
  /** Grace window before committing a held completion (injectable for tests). */
  private readonly completionGraceMs: number;
  /** Bound on a parked completion (injectable for tests). */
  private readonly parkTimeoutMs: number;
  private workflowSuppressionCheck: ((sessionId: string) => boolean) | null = null;

  constructor(storage: Storage, opts?: { completionGraceMs?: number; parkTimeoutMs?: number }) {
    this.storage = storage;
    this.completionGraceMs = opts?.completionGraceMs ?? COMPLETION_GRACE_MS;
    this.parkTimeoutMs = opts?.parkTimeoutMs ?? PARK_TIMEOUT_MS;
  }

  private async resolveSessionWorktreePath(
    session: Pick<RunningSession, "workspaceCheckoutId" | "projectId" | "branch" | "checkoutPath">,
    legacyProjectPath: string,
  ): Promise<string> {
    if (!session.workspaceCheckoutId) {
      return resolveWorktreePath(legacyProjectPath, session.branch);
    }
    const registered = await this.storage.workspaceRegistry.getCheckoutById(session.workspaceCheckoutId);
    if (!registered || registered.checkout.deleted_at || registered.checkout.status !== "ready") {
      throw new WorkspaceCheckoutUnavailableError(
        `Workspace checkout ${session.workspaceCheckoutId} is no longer available`,
      );
    }
    const branch = session.branch ?? "";
    if (registered.workspace.project_id !== session.projectId || registered.workspace.branch !== branch) {
      throw new WorkspaceCheckoutUnavailableError(
        `Workspace checkout ${session.workspaceCheckoutId} does not match session workspace`,
      );
    }
    session.checkoutPath = registered.checkout.worktree_path;
    return registered.checkout.worktree_path;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * Injected by shared-services: nudges NotificationService to drain the local
   * outbox right after a milestone lands, so the bell is fast in the common
   * case. Purely a latency optimization — correctness comes from the periodic
   * and startup drains, because this hook can't fire if the process dies
   * between the commit and the import.
   */
  setMilestoneListener(listener: () => void): void {
    this.onMilestoneCreated = listener;
  }

  private onMilestoneCreated: (() => void) | null = null;

  /**
   * Decide the disposition to persist on an outgoing user turn.
   *
   * Ordinary user input defaults to `result`. Workflow callers must be explicit:
   * `origin: "workflow"` alone is NOT enough to infer `internal`, because
   * approved review feedback is also a workflow-authored turn yet starts a
   * user-visible source result. An omission is therefore a caller bug — warn
   * loudly rather than silently picking a disposition that suppresses a real
   * notification.
   */
  private resolveOutgoingDisposition(
    sessionId: string,
    opts?: { origin?: "workflow"; notificationDisposition?: NotificationDisposition },
  ): NotificationDisposition {
    if (opts?.notificationDisposition) return opts.notificationDisposition;
    if (opts?.origin === "workflow") {
      console.warn(
        `[AgentSession] workflow-origin turn for ${sessionId} carries no explicit notificationDisposition; defaulting to "result"`,
      );
    }
    return "result";
  }

  /**
   * Injected by shared-services: lets commitCompletion mark taskCompleted WS
   * frames whose completion the local WorkflowEngine claims (reviewer
   * sessions of active runs). A front server bridging this frame must not
   * wake its commander for it (spec §Phase 1.5 抑制协调).
   */
  setWorkflowSuppressionCheck(check: (sessionId: string) => boolean): void {
    this.workflowSuppressionCheck = check;
  }

  /**
   * Broadcast a freshly-generated title on the global event bus so the sidebar
   * (`useResidentSessions`) updates regardless of which workspace is currently
   * focused. The per-session WS `titleUpdated` broadcast only reaches the one
   * mounted AgentConversation, which is lost when the user navigates to another
   * workspace before the ~1-2s title generation completes. Used by both the
   * local title path and the remote proxy path.
   */
  emitSessionTitle(projectId: string, branch: string | null, sessionId: string, title: string | null): void {
    this.eventBus?.emit({ type: "session:title", projectId, branch, sessionId, title });
  }

  /**
   * Single emit path for `branch:activity` events. Derives the current
   * activity from local DB state (the source of truth — see
   * `computeBranchActivity`) and emits iff the value changed since the
   * last emit for this branch. Returns the emitted state or null when
   * deduped.
   *
   * Use this for any local state change that affects branch activity
   * (createNewSession / persistEntry / taskCompleted / stopSession /
   * deleteSession). Sites that already know the intended activity but
   * can't derive it from local DB (e.g. forwarding from a remote backend)
   * should use `emitBranchActivityIfChanged` instead.
   */
  async emitDerivedBranchActivity(
    projectId: string,
    branch: string | null,
  ): Promise<BranchActivityState | null> {
    const sessions = await this.storage.agentSessions.listByBranch(projectId, branch ?? "", "runtime");
    const derived = computeBranchActivity(sessions).get(branch ?? "")
                  ?? { activity: "idle", since: Date.now() };
    return this.emitBranchActivityIfChanged(projectId, branch, derived);
  }

  /**
   * Emit `branch:activity` with the given state iff it differs from the
   * last emit for this branch. Used by forwarding paths that have the
   * activity value but no local DB to derive from (remote-proxied
   * sessions). Returns the emitted state or null when deduped.
   */
  emitBranchActivityIfChanged(
    projectId: string,
    branch: string | null,
    state: BranchActivityState,
  ): BranchActivityState | null {
    if (!this.branchActivityDedupe.shouldEmit(projectId, branch, state.activity, state.since)) {
      return null;
    }
    this.eventBus?.emit({
      type: "branch:activity",
      projectId,
      branch,
      activity: state.activity,
      since: state.since,
      sessionId: state.sessionId,
    });
    return state;
  }

  /**
   * Read the last-emitted `branch:activity` for a branch (what the workspace
   * dot currently shows), or undefined if nothing has been emitted yet. Reads
   * the shared dedupe cache without mutating it. Used by ChatSessionManager to
   * tell whether a stale orchestrator `main-running` is still on screen.
   */
  getCurrentBranchActivity(
    projectId: string,
    branch: string | null,
  ): BranchActivity | undefined {
    return this.branchActivityDedupe.peek(projectId, branch);
  }

  /**
   * All cached `branch:activity` dot states for a project, keyed by branch
   * ("" for the null/main worktree). The REST `/branches/activity` route uses
   * this to replay the orchestrator (`main-*`) overlay onto the DB-derived
   * activity — see `overlayOrchestratorActivity`. Without it, switching away
   * from a project and back loses the live orchestrator dot.
   */
  getProjectBranchStates(projectId: string): Map<string, BranchActivityState> {
    return this.branchActivityDedupe.getProjectStates(projectId);
  }

  /**
   * Idempotency guard for one-shot title generation per session. Returns
   * true if the caller is the first to claim the slot (and should proceed
   * with generation), false if another path has already taken it.
   */
  markTitleResolved(sessionId: string): boolean {
    if (this.titleResolved.has(sessionId)) return false;
    this.titleResolved.add(sessionId);
    return true;
  }

  /**
   * Write a caller-determined final title and claim the one-shot slot so the
   * AI title generator never fires for this session — same pattern as the
   * Branch path's "Branch - <source title>". The slot is claimed before the
   * DB write: even if the write fails, a degraded placeholder title beats an
   * AI title racing in over the caller's intent.
   */
  async setFinalSessionTitle(sessionId: string, title: string): Promise<void> {
    this.markTitleResolved(sessionId);
    await this.storage.agentSessions.updateTitle(sessionId, title);
    this.broadcastRaw(sessionId, { titleUpdated: { title } });
    const session = this.sessions.get(sessionId);
    if (session) this.emitSessionTitle(session.projectId, session.branch, sessionId, title);
  }

  private isProcessAlive(session: RunningSession): boolean {
    return !!session.process && session.process.exitCode === null && !session.dormant;
  }

  private touchSession(session: RunningSession): void {
    session.lastActiveAt = Date.now();
  }

  /**
   * Claim a session for an operation that will spawn a process for it — a
   * wake or a restart. Both begin on a session that looks exactly like a
   * retention candidate (no process, status "stopped") and stay that way
   * across several awaits before `spawnAgent` runs, so without this claim a
   * sweep landing in that window deletes the row underneath them and leaves
   * an orphan process whose every subsequent write fails on the foreign key.
   *
   * Returns null when retention has already claimed the session — the caller
   * must abandon the operation and report it as gone. Otherwise it returns a
   * release function; call it in a `finally`.
   *
   * MUST be called synchronously, before the caller's first `await`. That is
   * the entire guarantee: paired with `retentionDeleting` (planted before
   * retention's own first await), there is no instant at which a sweep and a
   * process start can both fail to see each other
   * (docs/plans/2026-08-08-session-retention.md §1.5).
   */
  private beginProcessStart(session: RunningSession): (() => void) | null {
    if (this.retentionDeleting.has(session.id)) return null;
    session.processStartsInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.processStartsInFlight--;
    };
  }

  private emitProcessAlive(session: RunningSession, alive: boolean): void {
    this.eventBus?.emit({
      type: "session:process",
      projectId: session.projectId,
      branch: session.branch,
      sessionId: session.id,
      alive,
    });
    this.broadcastRaw(session.id, { processAlive: { alive } });
  }

  getSessionProcessAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? this.isProcessAlive(session) : false;
  }

  /**
   * Every session with a live process belonging to one of `projectIds` — the
   * whole-project answer behind GET /api/projects/:id/agent-sessions/alive.
   * Callers pass more than one id only on the worker, where a project reached
   * by path can be known under both its registered id and the `path:` pseudo id.
   *
   * Alive, not running: a session sitting idle between turns still owns a
   * process the user can resume instantly, which is precisely what the sidebar
   * marks. `getRunningResidentProcesses` answers a different question.
   *
   * Most recently active FIRST — the order the sidebar renders in. Sorting here
   * rather than shipping the timestamp keeps recency a server decision (and
   * `getRunningResidentProcesses` sorts the other way on purpose: it is looking
   * for the stalest process to evict).
   */
  listAliveSessions(projectIds: string[]): AliveAgentSession[] {
    const scope = new Set(projectIds);
    return [...this.sessions.values()]
      .filter((session) => scope.has(session.projectId) && this.isProcessAlive(session))
      .map((session) => ({
        id: session.id,
        projectId: session.projectId,
        // "" is the main-branch sentinel in storage; the API speaks null.
        branch: session.branch === "" ? null : session.branch,
        status: session.status,
        lastActiveAt: session.lastActiveAt,
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getRunningResidentProcesses(scope?: ResidentProcessScope): RunningResidentProcess[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          this.isProcessAlive(session) &&
          session.status === "running" &&
          (!scope || (session.projectId === scope.projectId && session.branch === scope.branch)),
      )
      .map((session) => ({
        id: session.id,
        projectId: session.projectId,
        branch: session.branch,
        lastActiveAt: session.lastActiveAt,
      }))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  }

  private async getMaxResidentAgentProcesses(): Promise<number> {
    const saved = await this.storage.settings.get("agentProcesses");
    if (!saved) return normalizeAgentProcessSettings(undefined).maxResidentAgentProcesses;
    try {
      return normalizeAgentProcessSettings(JSON.parse(saved)).maxResidentAgentProcesses;
    } catch {
      return normalizeAgentProcessSettings(undefined).maxResidentAgentProcesses;
    }
  }

  private async withCapacityLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.capacityQueue;
    let release: () => void = () => {};
    this.capacityQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async ensureResidentCapacity(
    scope: ResidentProcessScope,
    options?: { force?: boolean; excludeSessionId?: string },
  ): Promise<void> {
    await this.withCapacityLock(async () => {
      const maxResidentAgentProcesses = await this.getMaxResidentAgentProcesses();
      const live = [...this.sessions.values()].filter(
        (session) =>
          session.id !== options?.excludeSessionId &&
          session.projectId === scope.projectId &&
          session.branch === scope.branch &&
          this.isProcessAlive(session),
      );
      if (live.length < maxResidentAgentProcesses) return;

      const candidate = pickIdleResidentEvictionCandidate(
        live.map((session) => ({
          id: session.id,
          processAlive: this.isProcessAlive(session),
          status: session.status,
          dormant: session.dormant,
          backgroundTasksProtect: session.completion.backgroundTasksProtectSession,
          lastActiveAt: session.lastActiveAt,
          projectId: session.projectId,
          branch: session.branch,
        })),
        scope,
      );
      if (candidate) {
        await this.hibernateSession(candidate.id);
        return;
      }

      if (options?.force) {
        const running = live
          .filter((session) => session.status === "running")
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
        if (running) {
          await this.stopSession(running.id);
          return;
        }
      }

      throw new ResidentProcessLimitError(maxResidentAgentProcesses, this.getRunningResidentProcesses(scope));
    });
  }

  /**
   * Find an existing agent session for a branch, or return null. Never creates.
   *
   * Sessions are only persisted on first user message (see `createNewSession`),
   * so "auto-load" callers must handle the null case (empty placeholder UI).
   *
   * Resolution order:
   * 1. DB-first: query `getLatestByBranch` (ORDER BY updated_at DESC LIMIT 1)
   *    so we always return the most-recently-updated session, not whichever
   *    one happened to be inserted first into the in-memory Map.
   * 2. skipDb fallback (remote path-based pseudo-projects): scan `this.sessions`.
   * 3. No match anywhere → null.
   */
  async findExistingSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb = false,
  ): Promise<string | null> {
    console.log(`[findExisting] ENTER projectId=${projectId} branch=${branch ?? "<null>"} skipDb=${skipDb} sessionsMapSize=${this.sessions.size}`);
    if (!skipDb) {
      const latestDbRow = await this.storage.agentSessions.getLatestByBranch(
        projectId,
        branch ?? "",
        "runtime",
      );
      console.log(`[findExisting] DB latestByBranch(${projectId}, ${branch ?? ""}) → ${latestDbRow ? `id=${latestDbRow.id} status=${latestDbRow.status} updatedAt=${latestDbRow.updated_at}` : "NONE"}`);
      if (latestDbRow) {
        const inMemory = this.sessions.get(latestDbRow.id);
        if (inMemory) {
          return this.reuseExistingSession(inMemory, projectPath);
        }
        // DB row exists but session isn't in memory. The restore path
        // populates in-memory on startup, so this shouldn't normally happen.
        // Treat as "no active session" — the user can pick the row from the
        // history dropdown to explicitly load it.
      }
      return null;
    }
    // skipDb fallback: in-memory scan for remote path-based sessions.
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.branch === branch) {
        console.log(`[findExisting] skipDb in-memory match: ${session.id} (entries=${session.store.entries.filter(Boolean).length})`);
        return this.reuseExistingSession(session, projectPath);
      }
    }
    return null;
  }

  /**
   * Lifecycle `prepare` (design §7, §8): persist a `pending_first_turn`
   * identity bound to the branch's ready checkout — and nothing else. No
   * RunningSession, no capacity check, no process. The row becomes a session
   * only through `hydratePendingSession` + first send, driven by
   * AgentSessionLifecycleService.
   */
  async prepareSessionRow(input: {
    sessionId: string;
    projectId: string;
    branch: string | null;
    projectPath: string;
    permissionMode: "plan" | "edit";
    agentType: AgentType;
    model: string | null;
    purpose: SessionPurpose;
    owner: { kind: string; id: string } | null;
    prepareOperationId: string;
    pendingExpiresAt: number;
    startSnapshot?: SnapshotState | null;
  }): Promise<{ workspaceCheckoutId: string; worktreePath: string }> {
    const branchKey = input.branch ?? "";
    const existingCheckout = await this.storage.workspaceRegistry.getByProjectBranch(
      input.projectId, branchKey, "local",
    );
    if (!existingCheckout) {
      await getRegisteredWorktreeBranches(this.storage, input.projectId, input.projectPath);
    }
    const bound = await this.storage.agentSessions.createPending({
      id: input.sessionId,
      project_id: input.projectId,
      branch: branchKey,
      target_id: "local",
      permission_mode: input.permissionMode,
      agent_type: input.agentType,
      model: input.model,
      purpose: input.purpose,
      owner_kind: input.owner?.kind ?? null,
      owner_id: input.owner?.id ?? null,
      prepare_operation_id: input.prepareOperationId,
      pending_expires_at: input.pendingExpiresAt,
    });
    await recordTurnSnapshot(this.storage, input.sessionId, -1, bound.checkout.worktree_path, input.startSnapshot);
    return { workspaceCheckoutId: bound.checkout.id, worktreePath: bound.checkout.worktree_path };
  }

  /**
   * Lifecycle `activate`, runtime half (design §8.2): rebuild the
   * RunningSession for a pending row by id, take a resident slot and spawn.
   * The pending row is never in the manager map — startup restore skips
   * zero-entry rows — so this is the hydrate step the design calls
   * mandatory. Throws ResidentProcessLimitError / WorkspaceCheckoutUnavailableError.
   */
  async hydratePendingSession(
    sessionId: string,
    row: { projectId: string; branch: string | null; permissionMode: "plan" | "edit"; agentType: AgentType; model: string | null; purpose: SessionPurpose; operationId: string },
    opts: { projectPath: string; force?: boolean; crossRemoteMcp?: CrossRemoteMcpConfig; userId?: string },
  ): Promise<void> {
    await this.createNewSession(
      row.projectId, row.branch, opts.projectPath, false, row.permissionMode, row.agentType,
      false, opts.force === true,
      {
        sessionId, crossRemoteMcp: opts.crossRemoteMcp, userId: opts.userId,
        // The stored model is part of the identity CAS in createNewSession:
        // omitting it normalizes to null and refuses every prepared row that
        // chose a model.
        model: row.model,
        purpose: row.purpose, operationId: row.operationId, allowPending: true,
      },
    );
  }

  /**
   * Commander surfacing (design §10.2), called by the lifecycle service only
   * AFTER the first instruction is committed: announcing at spawn could push
   * an empty pending session into an open agent window if the send then
   * failed — the very race this lifecycle removes.
   */
  announceSessionRunning(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") return;
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "running" });
  }

  /**
   * Tear a runtime down without touching its row's conversation: kill the
   * process, drop the map entry, mark the row stopped. Used by the lifecycle
   * service when an activation cannot proceed after spawn (capacity race,
   * cancel race, provider rejected before any entry). Unlike `stopSession`
   * this pushes NO system entry — a pending row must stay entry-free, or
   * recovery would misread it.
   */
  async dropRuntime(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const proc = session.process;
    session.process = null;
    this.killProcess(proc);
    this.emitProcessAlive(session, false);
    this.resetCompletion(session);
    session.dormant = true;
    session.status = "stopped";
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);
    if (!session.skipDb) {
      await this.storage.agentSessions.updateStatusPreservingTimestamp(sessionId, "stopped").catch((err) => {
        console.error(`[AgentSession] dropRuntime: failed to mark ${sessionId} stopped:`, err);
      });
    }
    this.broadcastRaw(sessionId, { finished: true });
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Always create a brand-new session row and spawn a process.
   * Unlike getOrCreateSession, this never reuses an existing row for the branch.
   * Used by "New Conversation" flow where the user explicitly wants a fresh conversation.
   */
  async createNewSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb: boolean = false,
    permissionMode: "plan" | "edit" = "edit",
    agentType: AgentType = "claude-code",
    announceRunning: boolean = false,
    force: boolean = false,
    opts: {
      sessionId?: string;
      crossRemoteMcp?: CrossRemoteMcpConfig;
      model?: string | null;
      /** Worktree state the caller already captured — reused for the session-start snapshot. */
      startSnapshot?: SnapshotState | null;
      /** Authenticated owner; enables per-spawn cross-remote token re-minting. */
      userId?: string;
      /** Business origin, for lifecycle logging (design §5.3). Defaults to interactive. */
      purpose?: SessionPurpose;
      /** Caller's stable operation key, when it has one (project-chat op, commander tool call, workflow run). */
      operationId?: string;
      /**
       * Lifecycle-service only: hydrate a `pending_first_turn` row (design
       * §8.2). Every other caller is refused a non-active stored identity so
       * the legacy `/new` path can neither resurrect a tombstone nor spawn a
       * pending session behind the service's back.
       */
      allowPending?: boolean;
    } = {},
  ): Promise<string> {
    // The caller may supply the id so it can mint a session-scoped token before spawn.
    const sessionId = opts.sessionId ?? randomUUID();
    const branchKey = branch ?? "";
    const model = opts.model?.trim() ? opts.model.trim() : null;

    const active = opts.sessionId ? this.sessions.get(sessionId) : undefined;
    if (active) {
      if (active.projectId !== projectId || active.branch !== branch
        || active.permissionMode !== permissionMode || active.agentType !== agentType
        || (active.model ?? null) !== model || active.skipDb !== skipDb) {
        throw new Error("Session identity is already in use");
      }
      return this.reuseExistingSession(active, projectPath);
    }
    if (this.sessions.has(sessionId)) {
      throw new Error("Session identity is already active");
    }
    const stored = !skipDb && opts.sessionId
      ? await this.storage.agentSessions.getById(sessionId)
      : undefined;
    if (stored && (!(["running", "stopped"] as string[]).includes(stored.status)
      || stored.project_id !== projectId
      || stored.branch !== branchKey
      || stored.permission_mode !== permissionMode
      || stored.agent_type !== agentType
      || (stored.model ?? null) !== model)) {
      throw new Error("Session identity is already in use");
    }
    if (stored && stored.lifecycle_state !== undefined && stored.lifecycle_state !== "active"
      && !(opts.allowPending && stored.lifecycle_state === "pending_first_turn")) {
      throw new Error(`Session identity is ${stored.lifecycle_state}; it must be activated through the lifecycle service`);
    }

    await this.ensureResidentCapacity({ projectId, branch }, { force });

    let workspaceCheckoutId = stored?.workspace_checkout_id ?? null;
    let absoluteWorktreePath: string;
    if (skipDb) {
      absoluteWorktreePath = resolveWorktreePath(projectPath, branch);
    } else if (stored) {
      absoluteWorktreePath = await this.resolveSessionWorktreePath({
        workspaceCheckoutId,
        projectId,
        branch,
        checkoutPath: null,
      }, projectPath);
    } else {
      // Lazy registration covers the main checkout and any git-discovered
      // worktrees before the transaction resolves the exact incarnation.
      const existingCheckout = await this.storage.workspaceRegistry.getByProjectBranch(
        projectId, branchKey, "local",
      );
      if (!existingCheckout) {
        await getRegisteredWorktreeBranches(this.storage, projectId, projectPath);
      }
      const bound = await this.storage.agentSessions.createBound({
        id: sessionId,
        project_id: projectId,
        branch: branchKey,
        target_id: "local",
        permission_mode: permissionMode,
        agent_type: agentType,
        model,
      });
      workspaceCheckoutId = bound.checkout.id;
      absoluteWorktreePath = bound.checkout.worktree_path;
    }

    if (!skipDb && !stored) {
      await recordTurnSnapshot(this.storage, sessionId, -1, absoluteWorktreePath, opts.startSnapshot);
    }

    // Explicit durable recovery keeps any transcript rows. Zero-entry rows get
    // the same fresh store as a newly allocated session, but retain identity.
    const storedEntries = stored ? await this.storage.agentSessions.getEntries(sessionId) : [];
    const store: MessageStore = storedEntries.length > 0
      ? this.rebuildStoreFromRows(storedEntries, sessionId)
      : (() => {
        const indexProvider = new EntryIndexProvider();
        return { patches: [], entries: [], indexProvider,
          toolTracker: new EntryTracker(indexProvider), currentAssistantIndex: null };
      })();

    // Initialize running session
    const session: RunningSession = {
      id: sessionId,
      projectId,
      branch,
      workspaceCheckoutId,
      checkoutPath: absoluteWorktreePath,
      process: null,
      dormant: false,
      processStartsInFlight: 0,
      historyEpoch: stored?.history_epoch ?? 0,
      store,
      subscribers: new Set(),
      status: "running",
      buffer: "",
      skipDb,
      permissionMode,
      crossRemoteMcp: opts.crossRemoteMcp,
      userId: opts.userId && opts.userId !== "local" ? opts.userId : undefined,
      agentType,
      model,
      completion: new TurnCompletionLedger(this.parkTimeoutMs),
      graceTimer: null,
      parkTimer: null,
      eventChain: Promise.resolve(),
      bgSpawnHintsThisTurn: 0,
      taskStartedThisTurn: 0,
      lastActiveAt: Date.now(),
      turnOpenSince: null,
      turnDisposition: null,
      lifecycle: {
        purpose: opts.purpose ?? "interactive",
        operationId: opts.operationId,
        createdAt: Date.now(),
        // A recovered row that already carries a user turn has had its first
        // instruction; only a fresh/zero-entry identity is still waiting.
        firstInstructionAccepted: storedEntries.some((row) => {
          try { return (JSON.parse(row.data) as { type?: string }).type === "user"; } catch { return false; }
        }),
      },
    };

    this.sessions.set(sessionId, session);

    // Notify provider of session creation (for per-session state init)
    const provider = getProvider(agentType);
    provider.onSessionCreated?.(sessionId, permissionMode);

    // Spawn agent process
    await this.spawnAgent(session, absoluteWorktreePath);
    console.log(`[AgentSession] createNewSession: id=${sessionId}, projectId=${projectId}, branch=${branchKey}`);
    logSessionLifecycle({
      event: "created", sessionId, projectId, branch,
      purpose: session.lifecycle!.purpose, operationId: opts.operationId, recovered: stored !== undefined,
    });

    // Announce the freshly-running session over the event bus so live
    // consumers can react to it — in particular the agent panel's
    // commander-surface hook (useSurfaceCommanderSession), which swaps an open
    // window (incl. a blank "New Conversation" placeholder) onto a session a
    // commander just spawned on this workspace. Without this, createNewSession
    // emits no `session:status` event: status is already "running" so the
    // subsequent sendUserMessage skips its emit, and spawnAgent only emits on
    // error/exit — so the new session would silently land in the history
    // dropdown without surfacing.
    //
    // Gated behind `announceRunning` (only the commander spawn opts in): the
    // interactive REST create paths must NOT emit here, or the running event
    // could beat their own HTTP response to the browser and surface-then-reload
    // the very window that just created the session. spawnAgent flips status to
    // "error" (and emits its own event) when the cwd is missing, so only
    // announce a session that actually came up running.
    if (announceRunning && session.status === "running") {
      this.eventBus?.emit({ type: "session:status", projectId, branch, sessionId, status: "running" });
    }

    // The new session has fresh updated_at and no timestamps, so the branch
    // resets to idle (see computeBranchActivity). Emit so SSE consumers don't
    // sit on a stale "completed" until the next user message arrives.
    await this.emitDerivedBranchActivity(projectId, branch);

    return sessionId;
  }

  /**
   * Handle reuse of an existing in-memory session found by findExistingSession:
   * - dormant: return as-is (wakes lazily on next message)
   * - running OR process alive (stream-json between-turns: status="stopped"
   *   but the CLI is still waiting on stdin): return as-is, entries intact
   * - process actually dead: restart the process so callers always get a
   *   running session
   * Returns the session id.
   *
   * Deliberately does NOT touch the session's permission mode: this sits on
   * the load path (workspace auto-start), so coercing mode here would let a
   * read silently kill/respawn the process and flip a workflow reviewer out
   * of read-only plan mode. Mode changes only happen through the explicit
   * switch-mode route, which carries actual user intent.
   */
  private async reuseExistingSession(
    session: RunningSession,
    projectPath: string,
  ): Promise<string> {
    const entriesCount = session.store.entries.filter(Boolean).length;
    this.touchSession(session);
    if (session.dormant) {
      console.log(`[AgentSession] Returning dormant session ${session.id} (entries=${entriesCount})`);
      return session.id;
    }

    // stream-json CLIs (Claude Code) keep the process alive between turns and
    // flip status="stopped" via the result-event handler. Treat that state as
    // "still reusable" — restarting would clear entries and wipe the
    // conversation. sendUserMessage flips status back to "running" and writes
    // to stdin on the next turn.
    const processAlive = session.process != null && session.process.exitCode === null;
    if (processAlive) {
      console.log(`[AgentSession] Returning existing session ${session.id} (status=${session.status}, processAlive=${processAlive}, entries=${entriesCount})`);
      return session.id;
    }

    // Dead session (process exited, not dormant) — restart so callers always get a running session
    console.log(`[AgentSession] Session ${session.id} is ${session.status} (entries=${entriesCount} — WILL BE CLEARED), restarting`);
    await this.restartSession(session.id, projectPath);
    return session.id;
  }

  /**
   * Replace the session's cross-remote MCP config for its NEXT spawn. Worker
   * side of the hub's per-message token refresh: a live process keeps the
   * token it was spawned with (baked into --mcp-config), but the next wake
   * picks this one up instead of the possibly-expired original.
   */
  updateCrossRemoteMcp(sessionId: string, config: CrossRemoteMcpConfig): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.crossRemoteMcp = config;
    return true;
  }

  /**
   * Kill an agent process and its entire process tree.
   * Uses negative PID to signal the process group (requires detached: true at spawn).
   */
  private killProcess(proc: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
    if (!proc?.pid) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Process group kill failed (e.g. already dead) — try direct kill as fallback
      try { proc.kill(signal); } catch { /* already dead */ }
    }
  }

  /**
   * Spawn agent process using the provider for this session's agent type
   */
  private async spawnAgent(session: RunningSession, cwd: string): Promise<void> {
    const provider = getProvider(session.agentType);
    console.log(`[AgentSession] Spawning ${provider.getDisplayName()} in ${cwd}`);

    // Verify cwd exists
    if (!existsSync(cwd)) {
      console.error(`[AgentSession] ERROR: cwd does not exist: ${cwd}`);
      session.status = "error";
      if (!session.skipDb) {
        await this.storage.agentSessions.updateStatus(session.id, "error").catch((err) => {
          console.error(`[AgentSession] Failed to update status for ${session.id}:`, err);
        });
      }
      await this.pushEntry(session.id, {
        type: "error",
        message: `Error: Working directory does not exist: ${cwd}`,
        timestamp: Date.now(),
      });
      this.broadcastPatch(session.id, ConversationPatch.updateStatus("error"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "error" });
      this.broadcastRaw(session.id, { finished: true });
      return;
    }

    // Minted per spawn, never persisted: the token is only usable by the
    // process about to be started, on this machine's loopback endpoint.
    const sessionToolsMcp = await mintSessionToolsMcpConfig(
      { storage: this.storage },
      { sessionId: session.id, origin: this.localApiOrigin },
    ).catch((err) => {
      // A missing tool surface must never block the session itself.
      console.error(`[AgentSession] Failed to mint session tools MCP config for ${session.id}:`, err);
      return undefined;
    });

    // Re-minted per spawn like sessionToolsMcp: the token cached at creation
    // would otherwise be reused across hibernate/wake cycles past its exp.
    // Only runs where minting is possible at all — hub-side sessions with a
    // known owner. Workers keep the hub-signed token they were handed (they
    // hold neither the hub secret nor a userId), refreshed via the message
    // route instead. A successful mint returning undefined means the user has
    // no reachable cross-remote target right now, so clearing is correct.
    if (session.userId && crossRemoteMcpEnabled()) {
      try {
        session.crossRemoteMcp = await mintCrossRemoteMcpConfig(
          { storage: this.storage },
          { userId: session.userId, sessionId: session.id, sourceRemoteServerId: null },
        );
      } catch (err) {
        console.error(`[AgentSession] Cross-remote token re-mint failed for ${session.id}, keeping cached config:`, err);
      }
    }

    const config = provider.buildSpawnConfig(
      cwd, session.permissionMode, session.crossRemoteMcp, session.model, sessionToolsMcp,
    );

    // Log the agent CLI version once per binary so protocol failures can be
    // attributed to an agent version. npx runs are logged as such (probing
    // `npx --version` would report npx itself, not the agent).
    if (config.command !== "npx") {
      const agentVersion = getBinaryVersion(config.command);
      console.log(`[AgentSession] ${provider.getDisplayName()} version: ${agentVersion ?? "unknown (--version probe failed)"}`);
    } else {
      console.log(`[AgentSession] ${provider.getDisplayName()} running via npx (version resolved at spawn by npm)`);
    }

    // Per-spawn state for diagnosing startup failures (e.g. agent not installed).
    session.producedOutput = false;
    session.unparsedStdoutTail = "";
    // A fresh process has no background tasks and no held completion — stale
    // ledger state from a previous process would wedge completion detection
    // in "intermediate turn" forever (or commit a dead process's candidate).
    this.resetCompletion(session);
    let stderrTail = "";
    let spawnFailed = false;

    const childProcess = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1", ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: config.shell ?? false,
      detached: true, // Own process group so we can kill the entire tree
    });

    session.process = childProcess;
    session.dormant = false;
    this.touchSession(session);
    this.emitProcessAlive(session, true);

    console.log(`[AgentSession] Process ${session.id} started, PID: ${childProcess.pid}`);

    // Pre-initialize provider protocol (e.g. Codex needs initialize + thread/start handshake)
    if (provider.getInitializationMessages) {
      const initMsgs = provider.getInitializationMessages(session.id);
      if (initMsgs) {
        childProcess.stdin?.write(initMsgs);
      }
    }

    // Handle stdout (JSON messages from Claude). Serialized through the
    // session's event chain: handleStdout awaits storage calls, so without
    // the queue a second data chunk (or the completion-grace timer) could
    // interleave mid-await and race the turn-completion state.
    childProcess.stdout?.on("data", (data: Buffer) => {
      this.enqueueSessionWork(session, () => this.handleStdout(session, data.toString()), "stdout");
    });

    // Handle stderr (errors and debug info)
    childProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log(`[AgentSession] stderr: ${text}`);
      // Don't treat all stderr as errors - Claude Code uses it for progress.
      // Keep a capped tail so we can surface it if the process fails to start.
      stderrTail = (stderrTail + text).slice(-4000);
    });

    // Handle process exit — queued behind any still-processing stdout chunks
    // so exit handling can't overtake the events the process flushed at death.
    childProcess.on("close", (code) => {
      this.enqueueSessionWork(session, async () => {
      console.log(`[AgentSession] Process ${session.id} exited with code ${code}`);

      // Don't update status or send finished signal if this is an old process
      // (happens when we restart - old process closes but new one is already running)
      if (session.process !== childProcess) {
        console.log(`[AgentSession] Old process closed, new process already running, skipping finished signal`);
        return;
      }

      session.process = null;
      this.emitProcessAlive(session, false);

      // A clean exit with a held completion commits it immediately: the
      // process can never auto-resume again, so waiting for the grace window
      // (or discarding the candidate) would drop markCompleted and the
      // completion notification entirely. Crash exits discard held state.
      this.clearGraceTimer(session);
      const action = session.completion.processExited(code);
      if (action.kind === "commit") {
        await this.commitCompletion(session, action.payload);
      }
      // processExited also clears the ledger on any non-committing exit
      // (crash, or a clean exit with tasks still listed). The tasks died with
      // the process either way, so the bar has to be told.
      this.broadcastBackgroundTasks(session);

      // A non-zero exit with no agent output means the process never really
      // started — most often the agent isn't installed (and the npx fallback
      // couldn't run/download it). The "error" handler already reports ENOENT;
      // for other startup failures, surface a friendly hint here.
      if (code !== 0 && !spawnFailed && !session.producedOutput) {
        // Awaited so the error entry lands before the final status broadcast
        // (turn_end/status ordering guarantee). Persistence errors are still
        // swallowed inside persistEntry; this only fixes ordering.
        try {
          await this.pushEntry(session.id, {
            type: "error",
            message: buildStartupFailureMessage(session.agentType, stderrTail, session.unparsedStdoutTail ?? ""),
            timestamp: Date.now(),
          }, true);
        } catch (err) {
          console.error(`[AgentSession] Failed to push startup-failure entry for ${session.id}:`, err);
        }
      }

      // Persist any partial streaming assistant text before the turn_end
      // marker: a mid-stream crash must not leave a DB index hole under the
      // divider — the branch-cutoff protocol assumes dense entry indices.
      await this.finalizeStreamingEntry(session);
      session.store.currentAssistantIndex = null;

      // Stop point for a turn the process took down with it. If a held
      // completion just committed above, endActiveTurn already ran inside
      // commitCompletion and this is a no-op.
      await this.endActiveTurn(session, "process_exit");

      session.status = code === 0 ? "stopped" : "error";
      if (!session.skipDb) {
        this.storage.agentSessions.updateStatus(session.id, session.status).catch((err) => {
          console.error(`[AgentSession] Failed to update status for ${session.id}:`, err);
        });
      }

      // Send status patch and finished signal
      this.broadcastPatch(session.id, ConversationPatch.updateStatus(session.status));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: session.status });
      this.broadcastRaw(session.id, { finished: true });
      }, "process-close");
    });

    // Handle spawn errors
    childProcess.on("error", (error) => {
      console.error(`[AgentSession] Process ${session.id} error:`, error);
      spawnFailed = true;
      session.status = "error";
      if (!session.skipDb) {
        this.storage.agentSessions.updateStatus(session.id, "error").catch((err) => {
          console.error(`[AgentSession] Failed to update status for ${session.id}:`, err);
        });
      }
      // ENOENT means the command (native binary or `npx`) wasn't found — almost
      // always the agent isn't installed. Show install instructions instead of
      // the cryptic "spawn npx ENOENT".
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      // Sync event-callback boundary — fire-and-forget with .catch (see the
      // matching note in the "close" handler above).
      this.pushEntry(session.id, {
        type: "error",
        message: isNotFound
          ? buildStartupFailureMessage(session.agentType, stderrTail, session.unparsedStdoutTail ?? "")
          : error.message,
        timestamp: Date.now(),
      }, true).catch((err) => {
        console.error(`[AgentSession] Failed to push spawn-error entry for ${session.id}:`, err);
      });
    });
  }

  /**
   * Append work to the session's serial event chain. Everything that mutates
   * turn-completion state (stdout parsing, grace-timer expiry, process exit)
   * runs through here so steps never interleave across await points.
   */
  private enqueueSessionWork(session: RunningSession, work: () => Promise<void>, label: string): void {
    session.eventChain = session.eventChain.then(work).catch((err) => {
      console.error(`[AgentSession] Error in ${label} handler for ${session.id}:`, err);
    });
  }

  /**
   * Same serial chain as `enqueueSessionWork`, for a caller that needs the
   * result back. The chain itself absorbs the outcome (success or failure) so
   * one queued step can never break the next; the caller gets the real promise.
   */
  private runSerialForResult<T>(session: RunningSession, work: () => Promise<T>): Promise<T> {
    const result = session.eventChain.then(work);
    session.eventChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private clearGraceTimer(session: RunningSession): void {
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
  }

  /**
   * (Re)arm the completion-grace timer for the held candidate. Expiry only
   * enqueues a generation-checked probe — the ledger decides inside the
   * serial chain whether the candidate is still current, so a timer armed
   * for a superseded result can never commit it.
   */
  private armGraceTimer(session: RunningSession, generation: number): void {
    this.clearGraceTimer(session);
    const timer = setTimeout(() => {
      session.graceTimer = null;
      this.enqueueSessionWork(session, async () => {
        const action = session.completion.graceElapsed(generation);
        if (action.kind === "commit") {
          await this.commitCompletion(session, action.payload);
        }
      }, "completion-grace");
    }, this.completionGraceMs);
    // Don't keep the server process alive just for a pending chime.
    timer.unref?.();
    session.graceTimer = timer;
  }

  /** Apply a cancel/schedule ledger action to the grace timer (commit actions
   * are handled at their call sites, which can await the side effects). */
  private applyCompletionTimerAction(session: RunningSession, action: CompletionAction): void {
    if (action.kind === "cancel") {
      this.clearGraceTimer(session);
    } else if (action.kind === "schedule") {
      this.armGraceTimer(session, action.generation);
    }
    this.syncParkTimer(session);
  }

  /**
   * Keep the park timer in step with the ledger's deadline.
   *
   * Driven by ledger STATE rather than by an action kind, because the deadline
   * survives across many actions (every task event returns `cancel` while a
   * completion stays parked) and can also be lifted without any action at all
   * when the user vouches for the last unvouched task. Re-reading the state
   * after each mutation is the only way the two can't drift.
   */
  private syncParkTimer(session: RunningSession): void {
    const deadlineAt = session.completion.parkDeadlineAt;
    if (deadlineAt === null) {
      if (session.parkTimer) {
        clearTimeout(session.parkTimer);
        session.parkTimer = null;
      }
      return;
    }
    if (session.parkTimer) return; // already armed for this park
    const timer = setTimeout(() => {
      session.parkTimer = null;
      this.enqueueSessionWork(session, async () => {
        const action = session.completion.parkDeadlineElapsed();
        if (action.kind !== "commit") return;
        console.log(
          `[AgentSession] parked completion exceeded ${this.parkTimeoutMs}ms with ` +
          `${session.completion.pendingTaskCount} background task(s) still running — ` +
          `committing the turn anyway (session=${session.id})`,
        );
        // `completed_with_pending_tasks`, not `completed`: the tasks outlived
        // the turn, and a divider claiming a clean finish would be the second
        // lie after the one this whole mechanism exists to stop.
        await this.commitCompletion(session, action.payload, "completed_with_pending_tasks");
        // The turn is closed but the tasks are not — repaint the bar so it
        // switches from "counting down" to "still running after the turn".
        this.broadcastBackgroundTasks(session);
      }, "completion-park-deadline");
    }, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
    session.parkTimer = timer;
  }

  /**
   * The user vouched for a background task: it stops counting toward the park
   * deadline, restoring the original wait-for-auto-resume behavior for that
   * task alone — now as an explicit choice rather than a silent assumption.
   */
  /**
   * Ask the agent to stop one background task.
   *
   * Returns "unsupported" for agents with no such primitive (Codex), so the
   * caller can say "stop the session instead" rather than showing a dead
   * button. On success nothing is updated here: the CLI's own
   * `background_tasks_changed` snapshot drains the ledger, which then commits
   * the parked turn through the normal path.
   */
  stopBackgroundTask(sessionId: string, taskId: string): "ok" | "unsupported" | "not_found" {
    const session = this.sessions.get(sessionId);
    if (!session?.process?.stdin) return "not_found";
    const frame = getProvider(session.agentType).formatStopBackgroundTask?.(taskId, sessionId);
    if (!frame) return "unsupported";
    session.process.stdin.write(frame);
    console.log(`[AgentSession] stop_task sent for ${taskId} (session=${sessionId})`);
    return "ok";
  }

  sanctionBackgroundTask(sessionId: string, taskId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.completion.sanction(taskId);
    this.syncParkTimer(session);
    this.broadcastBackgroundTasks(session);
    return true;
  }

  /** Discard all turn-completion state (fresh spawn / stop / hibernate / agent switch). */
  private resetCompletion(session: RunningSession): void {
    this.clearGraceTimer(session);
    session.completion.reset();
    this.syncParkTimer(session);
    // Every caller kills or respawns the process, which takes its background
    // tasks with it. Subscribers keep their socket across a Stop/hibernate, so
    // without this the bar would keep counting down tasks that are already
    // dead — and on a placeholder or dormant session no later frame arrives to
    // correct it.
    this.broadcastBackgroundTasks(session);
  }

  /**
   * The single place completion side effects run. Fired by processAgentEvent
   * for turns with no background activity (zero delay), by the grace timer
   * for held candidates, and by the close handler on a clean process exit.
   */
  /**
   * Push the live background-task set to every subscriber. Called on each
   * lifecycle event rather than diffed: the set is tiny and the harness
   * already only speaks on change, so a plain snapshot keeps the client
   * stateless (no patch application, no ordering assumptions).
   */
  private broadcastBackgroundTasks(session: RunningSession): void {
    this.broadcastRaw(session.id, this.backgroundTasksMessage(session));
  }

  /**
   * Reported rather than inferred client-side: whether a single task can be
   * stopped is a property of the agent (Claude Code has `stop_task`, Codex has
   * nothing equivalent), and the server is the only side that knows. A client
   * guessing from the agent type would drift the day Codex gains one.
   */
  private backgroundTasksMessage(session: RunningSession): AgentWsMessage {
    return {
      backgroundTasks: {
        tasks: session.completion.backgroundTasks,
        turnParked: session.completion.hasPendingCompletion,
        parkDeadlineAt: session.completion.parkDeadlineAt,
        canStopTasks: !!getProvider(session.agentType).formatStopBackgroundTask,
      },
    };
  }

  private async commitCompletion(
    session: RunningSession,
    payload: CompletionPayload,
    outcome: "completed" | "completed_with_pending_tasks" = "completed",
  ): Promise<void> {
    const sessionId = session.id;
    console.log(`[AgentSession] taskCompleted: sessionId=${sessionId}, eventBus=${!!this.eventBus}, projectId=${session.projectId}, branch=${session.branch}`);
    const completedAt = Date.now();
    if (!session.skipDb) {
      await this.storage.agentSessions.markCompleted(sessionId, completedAt);
    }
    // Stop point: persist the turn_end marker BEFORE the completion event goes
    // out, so event consumers can use its index as a turn boundary / branch cutoff.
    const turnEndEntryIndex = await this.endActiveTurn(session, outcome);
    // The turn is no longer parked; any task still running is now plainly
    // outliving its turn rather than holding it open.
    this.broadcastBackgroundTasks(session);
    const summaryText = extractLastAssistantText(session.store.entries);
    this.broadcastRaw(sessionId, {
      taskCompleted: {
        duration_ms: payload.duration_ms,
        cost_usd: payload.cost_usd,
        input_tokens: payload.input_tokens,
        output_tokens: payload.output_tokens,
        summaryText,
        turnEndEntryIndex: turnEndEntryIndex ?? undefined,
        workflowSuppressed: this.workflowSuppressionCheck?.(sessionId) || undefined,
      },
    });
    this.eventBus?.emit({
      type: "session:taskCompleted",
      projectId: session.projectId,
      branch: session.branch,
      sessionId,
      duration_ms: payload.duration_ms,
      cost_usd: payload.cost_usd,
      input_tokens: payload.input_tokens,
      output_tokens: payload.output_tokens,
      summaryText,
      turnEndEntryIndex: turnEndEntryIndex ?? undefined,
    });
    await this.emitDerivedBranchActivity(session.projectId, session.branch);

    // Turn finished — process stays alive (stream-json) waiting for next
    // input, but status now reflects "between turns" so UI affordances
    // like "New Conversation" don't prompt for a running confirmation.
    if (session.status !== "stopped") {
      session.status = "stopped";
      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "stopped");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "stopped" });
    }

    // Auto-update task status to "done" for the branch's assigned task.
    // Pushed into a single atomic storage call (find-first-match +
    // update) so a concurrent edit to the task between the read and
    // the write can't be silently clobbered back to "done".
    const branchKey = session.branch ?? "";
    const completedTask = await this.storage.tasks.completeIfAssigned(session.projectId, branchKey);
    if (completedTask) {
      this.eventBus?.emit({
        type: "task:updated",
        projectId: session.projectId,
        task: { ...completedTask } as Record<string, unknown>,
      });
    }
  }

  /**
   * Handle stdout data from agent process
   */
  private async handleStdout(session: RunningSession, data: string): Promise<void> {
    // Ignore output from a process that has been stopped — the process may
    // still flush data to stdout while shutting down after SIGTERM.
    if (session.dormant) return;

    // Add to buffer
    session.buffer += data;

    // Process complete lines
    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    const provider = getProvider(session.agentType);

    for (const line of lines) {
      if (!line.trim()) continue;

      const events = provider.parseStdoutLine(line, session.id);
      if (events.length > 0) {
        // The process produced real agent output, so it started successfully —
        // a later non-zero exit is a runtime error, not a "not installed" case.
        session.producedOutput = true;
      } else {
        // Keep a capped tail so a plain-text startup diagnosis (claude prints
        // model errors here) can be surfaced if the process fails to start.
        session.unparsedStdoutTail = ((session.unparsedStdoutTail ?? "") + line + "\n").slice(-4000);
      }
      for (const event of events) {
        await this.processAgentEvent(session.id, event);
      }
    }
  }

  /**
   * Process a single parsed agent event (provider-agnostic).
   * Routes each ParsedAgentEvent to the appropriate message store / broadcast action.
   * Includes input_tokens/output_tokens in taskCompleted broadcast for token reporting.
   */
  private async processAgentEvent(sessionId: string, event: ParsedAgentEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const timestamp = Date.now();
    session.lastActiveAt = timestamp;

    // Late output the provider attributed to an already-completed turn (a
    // codex backgrounded exec finishing after turn/completed, with no
    // follow-up turn behind it). It is persisted and broadcast below like any
    // tool activity, but must sit out every turn-lifecycle decision in this
    // method: discarding a grace-held completion would eat the milestone, and
    // opening a turn / flipping to running would stick forever — nothing is
    // coming to close it.
    const outOfTurn = (event.type === "tool_use" || event.type === "tool_result") && event.outOfTurn === true;

    // Turn activity while a completion candidate is held for grace means the
    // previous `result` was intermediate — an auto-resume turn is running and
    // its own result will become the new candidate. Discard the held one
    // before it can commit. `turn_started` (system/init) is the signal that
    // makes this work in practice: it lands ~20ms behind the intermediate
    // result, while the resume's first assistant event lags a full LLM
    // roundtrip — far past any sane grace window. (Deliberately NOT wired to
    // generic "system" messages: hooks can emit those outside any turn, and
    // cancelling on an event that has no result behind it would drop the
    // completion entirely.)
    if (
      !outOfTurn &&
      (event.type === "turn_started" ||
        event.type === "text" ||
        event.type === "thinking" ||
        event.type === "tool_use" ||
        event.type === "tool_result" ||
        event.type === "approval_request")
    ) {
      this.applyCompletionTimerAction(session, session.completion.noteTurnActivity());
    }

    // A turn can *open* with no send reaching sendUserMessage at all, so the
    // open has to be driven off the process, not off our own writes:
    //
    //  - Queued message. A message written to stdin mid-turn is enqueued by
    //    the CLI and dequeued only when the running turn ends — it can be
    //    injected into that turn at a tool boundary, but a turn that makes no
    //    tool call (a plain text answer) offers none, so the message becomes
    //    a turn of its own. sendUserMessage can't know which will happen: the
    //    boundary is decided by the model, after the send.
    //  - Background auto-resume, when the grace window committed the previous
    //    completion before the resume announced itself.
    //
    // Left unopened, such a turn's `result` hits the turnOpenSince===null
    // guard in endActiveTurn: no turn_end stop point (no divider, no Branch
    // affordance) and — because pushTurnEnd is the only writer of the
    // attention outbox — no durable milestone either, so the turn finishes
    // silently. `turn_started` (system/init) fires per turn (recorded
    // fixtures show it on auto-resume turns mid-stream, not just at spawn),
    // making it the earliest and most accurate open signal; the activity
    // events are the fallback for a provider or CLI version that doesn't emit
    // it, so a drift there degrades the turn's start time rather than
    // dropping its milestone. An already-open turn is never re-opened: a
    // message that WAS injected mid-turn leaves the turn's clock and
    // disposition alone, exactly as before.
    if (
      session.turnOpenSince === null &&
      !outOfTurn &&
      (event.type === "turn_started" ||
        event.type === "text" ||
        event.type === "thinking" ||
        event.type === "tool_use" ||
        event.type === "tool_result" ||
        event.type === "approval_request")
    ) {
      session.turnOpenSince = timestamp;
      // Not findTurnOpeningUserEntry: a queued message sits *before* the
      // previous turn_end, which that helper treats as a hard boundary.
      session.turnDisposition = resolveNotificationDisposition(findLatestUserEntry(session.store.entries));
    }

    // A turn can start without any user message going through this server:
    // Claude Code auto-resumes the same process when a background task
    // (background subagent, run_in_background command) completes. The prior
    // turn's `result` already flipped status to "stopped", so live activity
    // from the process must flip it back or the UI Stop button stays
    // disabled for the whole resumed turn. Stray flushes from a manually
    // stopped process can't reach here — handleStdout drops dormant output.
    if (
      session.status !== "running" &&
      !outOfTurn &&
      (event.type === "text" ||
        event.type === "thinking" ||
        event.type === "tool_use" ||
        event.type === "tool_result" ||
        event.type === "approval_request")
    ) {
      session.status = "running";
      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "running");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "running" });

      // Also repaint the workspace dot: `working` requires
      // last_user_message_at > last_completed_at, but the resume carries no
      // user message (the provider drops stream-json `user` lines), so bump
      // the timestamp to the wake moment. This also re-arms the
      // completed transition, so the bell/sound fire again when the resumed
      // turn ends — at the cost of one ring per intermediate turn.
      if (!session.skipDb) {
        await this.storage.agentSessions.markUserMessage(sessionId, timestamp);
        await this.emitDerivedBranchActivity(session.projectId, session.branch);
      }
    }

    switch (event.type) {
      case "text":
        await this.updateAssistantMessage(sessionId, event.content, timestamp);
        break;

      case "tool_use": {
        // Drift-detection hint: the model requested background execution.
        if (
          typeof event.input === "object" && event.input !== null &&
          (event.input as Record<string, unknown>).run_in_background === true
        ) {
          session.bgSpawnHintsThisTurn++;
        }
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        const tuKey = `tool_use:${event.toolUseId}`;
        const { index: tuIndex, isNew: tuIsNew } = session.store.toolTracker.getOrCreate(tuKey);
        const tuMessage: AgentMessage = {
          type: "tool_use",
          tool: event.tool,
          input: event.input,
          toolUseId: event.toolUseId,
          timestamp,
        };
        if (tuIsNew) {
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.addEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        } else {
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.replaceEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        }
        if (!session.skipDb) {
          await this.persistEntry(session, tuIndex, tuMessage);
        }
        break;
      }

      case "tool_result": {
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        const trKey = `tool_result:${event.toolUseId}`;
        const { index: trIndex, isNew: trIsNew } = session.store.toolTracker.getOrCreate(trKey);
        const trMessage: AgentMessage = {
          type: "tool_result",
          tool: event.tool,
          output: event.output,
          toolUseId: event.toolUseId,
          timestamp,
        };
        if (trIsNew) {
          session.store.entries[trIndex] = trMessage;
          const patch = ConversationPatch.addEntry(trIndex, trMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        } else {
          session.store.entries[trIndex] = trMessage;
          const patch = ConversationPatch.replaceEntry(trIndex, trMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        }
        if (!session.skipDb) {
          await this.persistEntry(session, trIndex, trMessage);
        }
        break;
      }

      case "thinking":
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        await this.pushEntry(sessionId, {
          type: "thinking",
          content: event.content,
          timestamp,
        }, true);
        break;

      case "system":
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        await this.pushEntry(sessionId, {
          type: "system",
          content: event.content,
          timestamp,
        }, true);
        break;

      // Background-task ledger. Inner tasks launched by subagents also emit
      // these events; their started/notification pairs balance out, so we
      // count everything rather than trying to establish parentage. While a
      // completion candidate is held, task events re-arm the grace window
      // (delay, don't cancel): an orphaned inner-task notification may have
      // no auto-resume behind it, and cancelling on it would drop the
      // completion entirely.
      case "task_started":
        this.applyCompletionTimerAction(session, session.completion.taskStarted({
          taskId: event.taskId,
          taskType: event.taskType,
          description: event.description,
        }, timestamp));
        session.taskStartedThisTurn++;
        this.broadcastBackgroundTasks(session);
        console.log(`[AgentSession] Background task started: ${event.taskId} (${event.taskType ?? "?"}) — ${session.completion.pendingTaskCount} pending in ${sessionId}`);
        break;

      case "task_finished":
        this.applyCompletionTimerAction(session, session.completion.taskFinished(event.taskId, timestamp));
        this.broadcastBackgroundTasks(session);
        console.log(`[AgentSession] Background task finished: ${event.taskId} (${event.status ?? "?"}) — ${session.completion.pendingTaskCount} pending in ${sessionId}`);
        break;

      // Authoritative running-task snapshot from the CLI — resyncs the ledger
      // so add/delete drift in the started/finished pairs can't accumulate.
      case "task_list_changed":
        this.applyCompletionTimerAction(session, session.completion.taskListChanged(event.tasks, timestamp));
        this.broadcastBackgroundTasks(session);
        console.log(`[AgentSession] Background task snapshot: [${event.tasks.map((t) => t.taskId).join(", ")}] in ${sessionId}`);
        break;

      // Handled above (cancels a grace-held completion); no store entry.
      case "turn_started":
        break;

      // The CLI's own session identity. Fires once per turn (claude) or once
      // per thread/start (codex); only the first sighting per value hits the
      // DB, where it both updates the newest-pointer column and appends to
      // the native-id history (older transcripts keep their association).
      // No store entry — this is a join key, not conversation content.
      case "native_session_id":
        if (session.nativeSessionId !== event.id) {
          session.nativeSessionId = event.id;
          if (!session.skipDb) {
            await this.storage.agentSessions.setNativeSessionId(session.id, event.id, session.agentType);
          }
        }
        break;

      case "error":
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        await this.pushEntry(sessionId, {
          type: "error",
          message: event.message,
          timestamp,
        }, true);
        break;

      case "result":
        console.log(`[Agent:result] sessionId=${sessionId} subtype=${event.subtype} prevStatus=${session.status}`);
        // Protocol-drift check: the model asked for background execution this
        // turn, but no task_started system event ever arrived. Most likely
        // the CLI renamed its task-lifecycle events — the pending-task ledger
        // is blind, so completion below fires prematurely (pre-ledger
        // behavior). Warn loudly so it doesn't degrade silently.
        if (session.bgSpawnHintsThisTurn > 0 && session.taskStartedThisTurn === 0) {
          console.warn(
            `[AgentSession] PROTOCOL DRIFT? Saw ${session.bgSpawnHintsThisTurn} run_in_background tool_use(s) this turn but no task_started event — ` +
            `the Claude Code CLI's task-lifecycle stream events may have changed; background-task completion deferral is inactive. (session=${sessionId})`,
          );
        }
        session.bgSpawnHintsThisTurn = 0;
        session.taskStartedThisTurn = 0;
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;

        if (event.subtype === "error" && event.error) {
          await this.pushEntry(sessionId, {
            type: "error",
            message: event.error,
            timestamp,
          }, true);
        }

        if (event.subtype === "error") {
          // A failed turn never dings — discard any held completion candidate.
          this.applyCompletionTimerAction(session, session.completion.errorResult());
          await this.endActiveTurn(session, "failed");
          // The turn is over even though it failed — without this the UI
          // keeps a perpetual "running" dot after an error result.
          if (session.status !== "stopped") {
            session.status = "stopped";
            if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "stopped");
            this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
            this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "stopped" });
          }
        }

        if (event.subtype === "success") {
          // The ledger decides what this result means (see turn-completion.ts):
          //  - cancel:   intermediate turn — background tasks still running,
          //              Claude Code will auto-resume this process. Status
          //              stays "running": semantically true and it keeps the
          //              Stop button usable. If a notification never arrives,
          //              the session honestly shows "running" and Stop/
          //              process-exit clears the state.
          //  - commit:   no background activity this turn → no auto-resume
          //              can be queued; complete immediately (common case).
          //  - schedule: background tasks ran this turn, so an auto-resume
          //              may be queued behind this result even though the
          //              ledger is empty (notifications can arrive before the
          //              result they interrupt). Hold as candidate; commit
          //              after the grace window unless new turn activity
          //              supersedes it. Each newer result replaces the held
          //              candidate, so only the last result of a resume chain
          //              commits — with its own duration/cost/token payload.
          const action = session.completion.successResult({
            duration_ms: event.duration_ms,
            cost_usd: event.cost_usd,
            input_tokens: event.input_tokens,
            output_tokens: event.output_tokens,
          }, timestamp);
          if (action.kind === "commit") {
            await this.commitCompletion(session, action.payload);
          } else {
            if (action.kind === "cancel") {
              console.log(`[AgentSession] result with ${session.completion.pendingTaskCount} background task(s) pending — intermediate turn, deferring completion for ${sessionId}`);
            } else {
              console.log(`[AgentSession] result after background-task activity — holding completion for ${this.completionGraceMs}ms grace (session=${sessionId})`);
            }
            this.applyCompletionTimerAction(session, action);
            // The park/hold itself is the state change worth showing: the
            // agent has stopped answering and only these tasks are keeping
            // the turn open. No task event follows it, so nothing else would
            // tell the client.
            this.broadcastBackgroundTasks(session);
          }
        }
        break;

      case "approval_request":
        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        if (event.requestType === "command") {
          await this.pushEntry(sessionId, {
            type: "approval_request",
            requestType: "command",
            requestId: event.requestId,
            command: event.command,
            cwd: event.cwd,
            timestamp,
          }, true);
        } else {
          await this.pushEntry(sessionId, {
            type: "approval_request",
            requestType: "fileChange",
            requestId: event.requestId,
            changes: event.changes,
            timestamp,
          }, true);
        }
        break;

      case "stdin_write":
        // Provider needs to send deferred data to the agent's stdin
        session.process?.stdin?.write(event.content);
        break;
    }
  }

  /**
   * Update or add an assistant message using JSON Patch semantics
   * This is the key method that handles streaming updates correctly
   */
  private async updateAssistantMessage(sessionId: string, content: string, timestamp: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { store } = session;

    // Check if we have an ongoing assistant message (streaming update)
    if (store.currentAssistantIndex !== null) {
      const existingIndex = store.currentAssistantIndex;
      const existing = store.entries[existingIndex];
      const message: AgentMessage = {
        type: "assistant",
        content,
        agentType: existing?.type === "assistant" ? existing.agentType ?? session.agentType : session.agentType,
        timestamp,
      };
      // Update the entry in our store
      store.entries[existingIndex] = message;
      // Create and broadcast REPLACE patch
      const patch = ConversationPatch.replaceEntry(existingIndex, message);
      store.patches.push(patch);
      this.broadcastPatch(sessionId, patch);
      return;
    }

    // Start new assistant message (ADD)
    const message: AgentMessage = {
      type: "assistant",
      content,
      agentType: session.agentType,
      timestamp,
    };
    const index = await this.pushEntry(sessionId, message, true);
    // Remember this index for streaming updates
    store.currentAssistantIndex = index;
  }

  /**
   * Push a new entry with ADD patch
   */
  /**
   * Allocate the next entry index, record the message in the in-memory store,
   * and build its ADD replay patch. Shared by `pushEntry` and `pushTurnEnd` so
   * the two persistence paths can't drift on index allocation or patch shape.
   */
  private stageEntry(session: RunningSession, message: AgentMessage): { index: number; patch: Patch } {
    const index = session.store.indexProvider.next();
    session.store.entries[index] = message;
    const patch = ConversationPatch.addEntry(index, message);
    session.store.patches.push(patch);
    return { index, patch };
  }

  private async pushEntry(
    sessionId: string,
    message: AgentMessage,
    broadcast: boolean = true,
    userId: string = "local",
    pushOpts?: { strictPersist?: boolean },
  ): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;

    const { index, patch } = this.stageEntry(session, message);

    // Persist to DB (skip streaming assistant text — those get finalized later)
    if (!session.skipDb && message.type !== "assistant") {
      await this.persistEntry(session, index, message, userId, { strict: pushOpts?.strictPersist });
    }

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }

  /**
   * Persist a `turn_end` together with the attention milestone it earns.
   *
   * Deliberately NOT routed through `pushEntry`: the milestone id embeds the
   * turn_end's entry index, so the index has to be allocated before the write,
   * and the write itself has to be the atomic turn-end/outbox operation rather
   * than a plain entry upsert. Ordering matches `pushEntry` (persist, then
   * broadcast) so the existing turn_end-before-status contract still holds.
   *
   * `entryIndexOverride` re-persists an already-staged boundary (crash-repair
   * replay); without it a fresh index is allocated.
   */
  private async pushTurnEnd(
    session: RunningSession,
    outcome: TurnOutcome,
    disposition: NotificationDisposition,
    endedAt: number,
    durationMs?: number,
    entryIndexOverride?: number,
  ): Promise<number> {
    const message: AgentMessage = {
      type: "turn_end",
      timestamp: endedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      outcome,
      notificationDisposition: disposition,
    };

    let index: number;
    let patch: Patch;
    if (entryIndexOverride !== undefined) {
      index = entryIndexOverride;
      patch = ConversationPatch.addEntry(index, message);
    } else {
      ({ index, patch } = this.stageEntry(session, message));
    }

    // skipDb sessions (remote path-based pseudo-sessions) have no durable store,
    // so no milestone is possible — an explicit non-durable internal path, not a
    // silent promise of recovery.
    if (!session.skipDb) {
      const activityReader = this.storage.agentSessions.getActivityById;
      const projected = typeof activityReader === "function"
        ? await activityReader(session.id, "notification")
        : undefined;
      // Custom/old storage may lack the projection API. Snapshot fallback is
      // allowed only for a genuinely unbound legacy session; a bound row that
      // cannot be projected keeps its durable turn_end but emits no possibly
      // misattributed notification.
      const notificationScope = projected
        ? { projectId: projected.projectId, branch: projected.branch }
        : session.workspaceCheckoutId
          ? null
          : { projectId: session.projectId, branch: session.branch };
      const outbox = notificationScope ? sessionMilestoneForTurnEnd({
        sessionId: session.id,
        projectId: notificationScope.projectId,
        branch: notificationScope.branch,
        entryIndex: index,
        outcome,
        disposition,
        createdAt: endedAt,
      }) : undefined;
      try {
        await this.storage.agentSessions.upsertTurnEndWithOutbox({
          sessionId: session.id,
          entryIndex: index,
          entryData: JSON.stringify(message),
          outbox,
        });
        await this.storage.agentSessions.touchUpdatedAt(session.id);
        if (outbox) this.onMilestoneCreated?.();
      } catch (error) {
        console.error(`[AgentSession] Failed to persist turn_end ${index} for ${session.id}:`, error);
      }
    }

    if (entryIndexOverride === undefined) this.broadcastPatch(session.id, patch);
    return index;
  }

  /**
   * Persist a single entry to the database
   */
  private async persistEntry(
    session: RunningSession,
    index: number,
    message: AgentMessage,
    userId: string = "local",
    opts?: {
      /**
       * Rethrow an entry-write failure instead of swallowing it. Set only for
       * the lifecycle first send: its evidence contract ("entry durable, THEN
       * stdin", design §8.2) is void if the upsert silently failed — the
       * session would go active with an empty transcript and be skipped by
       * restore. The ancillary writes below stay best-effort either way.
       */
      strict?: boolean;
    },
  ): Promise<void> {
    if (session.skipDb) return;
    if (opts?.strict) {
      await this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
    }
    try {
      if (!opts?.strict) {
        await this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
      }
      await this.storage.agentSessions.touchUpdatedAt(session.id);
      if (message.type === "user") {
        const now = Date.now();
        await this.storage.agentSessions.markUserMessage(session.id, now);
        await this.emitDerivedBranchActivity(session.projectId, session.branch);
        if (!this.suppressTitleGeneration) {
          const dbRow = await this.storage.agentSessions.getById(session.id);
          if (dbRow && (dbRow.title === null || dbRow.title === undefined)) {
            const text = extractUserText(message.content);
            if (text.trim().length > 0 && this.markTitleResolved(session.id)) {
              void this.ensureSessionTitle(session, text, userId);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[AgentSession] Failed to persist entry ${index}:`, error);
    }
  }

  /**
   * Finalize and persist the current streaming assistant message
   */
  private async finalizeStreamingEntry(session: RunningSession): Promise<void> {
    const index = session.store.currentAssistantIndex;
    if (index === null || session.skipDb) return;

    const entry = session.store.entries[index];
    if (entry) {
      await this.persistEntry(session, index, entry);
    }
  }

  /**
   * Close the open turn with a persisted turn_end stop-point entry, plus the
   * attention milestone the turn's disposition earns (written in the same
   * storage transaction — see pushTurnEnd).
   *
   * turn_end entries are constructed ONLY here and in repairInterruptedTurn
   * (restore path). Wall clock only — see design doc for why the CLI's
   * payload.duration_ms is not used.
   */
  private async endActiveTurn(
    session: RunningSession,
    outcome: Exclude<TurnOutcome, "server_restart">,
  ): Promise<number | null> {
    if (session.turnOpenSince === null) return null; // no turn in flight
    const endedAt = Date.now(); // single clock read: timestamp === end bound of durationMs
    const durationMs = endedAt - session.turnOpenSince;
    // Live path: the disposition was decided when this turn opened. The history
    // fallback only covers a turn whose open state predates the field (and is
    // the same resolution crash repair uses), so the two paths never disagree.
    const disposition = session.turnDisposition ?? resolveNotificationDisposition(
      findTurnOpeningUserEntry(session.store.entries, session.store.entries.length),
    );
    const index = await this.pushTurnEnd(session, outcome, disposition, endedAt, durationMs);
    session.turnOpenSince = null; // cleared only after the write resolves
    session.turnDisposition = null;
    if (!session.skipDb && index >= 0) {
      try {
        const project = await this.storage.projects.getById(session.projectId);
        if (project?.path) {
          await recordTurnSnapshot(this.storage, session.id, index,
            session.checkoutPath ?? resolveWorktreePath(project.path, session.branch));
        }
      } catch (error) {
        console.warn(`[AgentSession] Turn snapshot lookup failed for ${session.id}@${index}:`, error);
      }
    }
    return index >= 0 ? index : null;
  }

  /**
   * Send a user message to the agent
   */
  async sendUserMessage(
    sessionId: string,
    content: string | ContentPart[],
    projectPath?: string,
    userId: string = "local",
    opts?: FirstSendOptions,
  ): Promise<boolean> {
    // Pair with discardSessionIfEmpty: whichever operation plants
    // its synchronous marker first owns the session until it settles.
    if (!this.sessions.has(sessionId) || this.retentionDeleting.has(sessionId)) return false;
    this.userMessagesInFlight.set(sessionId, (this.userMessagesInFlight.get(sessionId) ?? 0) + 1);
    try {
      // Phase 0 observability: the first provider-accepted send closes the
      // create-then-send window the lifecycle design measures. Logged once
      // per session, on whichever path (resident or wake) delivers it.
      const lifecycle = this.sessions.get(sessionId)?.lifecycle;
      const pendingFirst = lifecycle !== undefined && !lifecycle.firstInstructionAccepted ? lifecycle : undefined;
      let accepted: boolean;
      try {
        accepted = await this.sendUserMessageClaimed(sessionId, content, projectPath, userId, opts);
      } catch (error) {
        if (pendingFirst) {
          logSessionLifecycle({
            event: "first_instruction_rejected", sessionId, purpose: pendingFirst.purpose,
            operationId: pendingFirst.operationId, reason: "send_threw",
          });
        }
        throw error;
      }
      if (pendingFirst) {
        if (accepted) {
          pendingFirst.firstInstructionAccepted = true;
          logSessionLifecycle({
            event: "first_instruction_accepted", sessionId, purpose: pendingFirst.purpose,
            operationId: pendingFirst.operationId, msSinceCreated: Date.now() - pendingFirst.createdAt,
          });
        } else {
          logSessionLifecycle({
            event: "first_instruction_rejected", sessionId, purpose: pendingFirst.purpose,
            operationId: pendingFirst.operationId, reason: "provider_rejected",
          });
        }
      }
      return accepted;
    } finally {
      const remaining = (this.userMessagesInFlight.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.userMessagesInFlight.set(sessionId, remaining);
      else this.userMessagesInFlight.delete(sessionId);
    }
  }

  private async sendUserMessageClaimed(
    sessionId: string,
    content: string | ContentPart[],
    projectPath?: string,
    userId: string = "local",
    opts?: FirstSendOptions,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Learn the owner as soon as an authenticated message arrives: sessions
    // restored after a server restart lose the in-memory userId, and this is
    // what re-arms per-spawn cross-remote token minting for them.
    if (userId && userId !== "local" && !session.userId) session.userId = userId;

    const disposition = this.resolveOutgoingDisposition(sessionId, opts);

    // If session is dormant, wake it up
    if (session.dormant) {
      if (!projectPath) {
        console.error(`[AgentSession] Cannot wake dormant session ${sessionId} without projectPath`);
        return false;
      }
      return this.wakeDormantSession(session, projectPath, content, userId, opts?.origin, disposition);
    }

    // A resident CLI can survive after its worktree was removed. Revalidate
    // the durable checkout before opening every subsequent turn as well.
    if (session.workspaceCheckoutId) {
      await this.resolveSessionWorktreePath(session, projectPath ?? session.checkoutPath ?? "");
    }

    if (!session.process?.stdin) {
      return false;
    }

    // The user moved on: a message sent while a completion candidate is held
    // for grace discards it — the new turn's own result will complete, and a
    // late chime for the abandoned turn would just be noise (the workspace
    // dot flips to "working" via markUserMessage regardless). Also resets the
    // background flag so this turn's result commits with zero grace delay
    // unless it launches background tasks of its own.
    this.applyCompletionTimerAction(session, session.completion.userTurnStarted());

    // Start-of-turn: if the previous turn ended (status="stopped" but process
    // still alive in stream-json mode), flip back to "running" and broadcast
    // so subscribers see the transition.
    if (session.status !== "running") {
      session.status = "running";
      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "running");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "running" });
    }
    this.touchSession(session);

    // Clear current assistant key - user message breaks streaming
    await this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;

    // Add user message with ADD patch. The disposition is persisted here, on
    // the turn's opening entry, because that's the only place the *intent*
    // behind the turn is known — and it has to survive a restart for crash
    // repair and remote outbox generation to agree with the live path.
    const userEntryIndex = await this.pushEntry(sessionId, {
      type: "user",
      content,
      timestamp: Date.now(),
      ...(opts?.origin ? { origin: opts.origin } : {}),
      notificationDisposition: disposition,
      // Lifecycle activation: an entry-write failure must abort before stdin
      // (strict), or the session would be marked active with no durable turn.
    }, true, userId, { strictPersist: opts?.onUserEntryPersisted !== undefined });
    // Lifecycle activation records the evidence line here — after the entry
    // is durable, before the stdin write — so crash recovery can tell "no
    // side effect yet" from "delivery unprovable" (design §8.2/§8.3).
    if (opts?.onUserEntryPersisted) await opts.onUserEntryPersisted(userEntryIndex);

    // Send to agent stdin via provider
    try {
      const provider = getProvider(session.agentType);
      const formatted = provider.formatUserInput(content, session.id);
      if (formatted.length === 0) {
        console.warn(
          `[AgentSession] sendUserMessage: provider buffered the input for ${session.agentType} session ${sessionId} — no stdin payload yet`,
        );
        // Empty payload = the provider accepted and buffered the input (Codex
        // before the thread/start response). The send is initiated — the
        // provider flushes the buffered turn/start itself — so the turn opens
        // here too, or its completion would skip the turn_end stop point.
        if (session.turnOpenSince === null) {
          session.turnOpenSince = Date.now();
          session.turnDisposition = disposition;
        }
        return true;
      }
      console.log(
        `[AgentSession] sendUserMessage: wrote ${formatted.length}B to ${session.agentType} stdin (session=${sessionId})`,
      );
      session.process.stdin.write(formatted);
      // The session was idle, so this send genuinely starts a turn. A send
      // that lands mid-turn must not reset the clock — nor the disposition: a
      // user steering an in-flight reviewer turn doesn't turn it into a
      // generic session result. Nor does it open a turn of its own here: the
      // CLI decides whether to inject it into the running turn or run it as
      // the next turn, and processAgentEvent opens that one when the process
      // announces it.
      if (session.turnOpenSince === null) {
        session.turnOpenSince = Date.now();
        session.turnDisposition = disposition;
      }
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to send message:`, error);
      return false;
    }
  }

  /**
   * Send an approval response to the agent process (for agents with approval flow).
   * Returns false if session not found, not running, or provider doesn't support approvals.
   */
  sendApprovalResponse(sessionId: string, requestId: string, decision: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status !== "running" || !session.process?.stdin) {
      return false;
    }

    try {
      const provider = getProvider(session.agentType);
      const formatted = provider.formatApprovalResponse?.(requestId, decision, session.id);
      if (!formatted) return false;
      session.process.stdin.write(formatted);
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to send approval response:`, error);
      return false;
    }
  }

  /**
   * Subscribe to session updates (WebSocket connection)
   */
  subscribe(
    sessionId: string,
    ws: WebSocket,
    opts: { afterEntryIndex?: number; historyEpoch?: number } = {},
  ): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.subscribers.add(ws);

    // A mismatched epoch means the client is naming an old index namespace;
    // replay the replacement conversation from its beginning.
    const after = opts.historyEpoch === undefined || opts.historyEpoch === session.historyEpoch
      ? (opts.afterEntryIndex ?? -1)
      : -1;
    ws.send(JSON.stringify({
      HistorySync: {
        historyEpoch: session.historyEpoch,
        reset: opts.historyEpoch !== undefined && opts.historyEpoch !== session.historyEpoch,
      },
    }));

    // Send the live background-task set BEFORE the history replay. The harness
    // pushes these only on change, so without a snapshot here a reload during a
    // long-running background task shows an empty bar while the task is still
    // running — exactly the case the bar exists for. It goes first because it
    // is a standalone snapshot, not a patch: it depends on nothing that
    // replays, and putting it last made the bar wait out the whole transcript
    // on every reload. The client renders it against the status it already got
    // from the REST session load; the status patch below only reconciles.
    ws.send(JSON.stringify(this.backgroundTasksMessage(session)));

    // Send historical entry patches after the client's sealed boundary. Keep
    // every replace for the active tail: multiple patches may target the same
    // entry index while assistant text streams.
    for (const patch of session.store.patches) {
      const entryIndices = patch.flatMap((op) => {
        const match = op.path.match(/^\/entries\/(\d+)$/);
        return match ? [Number(match[1])] : [];
      });
      if (entryIndices.length > 0 && entryIndices.every((index) => index <= after)) continue;
      const msg: AgentWsMessage = { JsonPatch: patch };
      ws.send(JSON.stringify(msg));
    }

    // Send Ready signal to indicate history is complete
    ws.send(JSON.stringify({ Ready: true, historyEpoch: session.historyEpoch }));

    // Send current status
    const statusPatch = ConversationPatch.updateStatus(session.status);
    ws.send(JSON.stringify({ JsonPatch: statusPatch }));

    // Return unsubscribe function
    return () => {
      session.subscribers.delete(ws);
    };
  }

  /**
   * Get all messages for a session (reconstructed from patches)
   */
  getMessages(sessionId: string): AgentMessage[] {
    const session = this.sessions.get(sessionId);
    return session?.store.entries.filter(Boolean) ?? [];
  }

  /** Raw sparse entries (holes preserved) — index space matches entry indices. */
  getRawMessages(sessionId: string): AgentMessage[] {
    return this.sessions.get(sessionId)?.store.entries ?? [];
  }

  getHistoryEpoch(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.historyEpoch;
  }

  /**
   * Public wrapper over broadcastRaw for the WorkflowEngine: mirror a raw WS
   * frame to a session's stream subscribers (a front server subscribed to
   * this stream relies on it for run-transition delivery — spec §Phase 1.5).
   */
  broadcastRawToSession(sessionId: string, payload: Record<string, unknown>): void {
    this.broadcastRaw(sessionId, payload as AgentWsMessage);
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): RunningSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get session by branch
   */
  getSessionByBranch(projectId: string, branch: string | null): RunningSession | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.branch === branch) {
        return session;
      }
    }
    return null;
  }

  /**
   * Get all sessions for a project regardless of branch
   */
  getSessionsByProject(projectId: string): RunningSession[] {
    const results: RunningSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        results.push(session);
      }
    }
    return results;
  }

  /**
   * Ids of the sessions in one workspace that still own a live child process,
   * whatever their turn status. Deliberately broader than
   * `getRunningResidentProcesses`, which also demands `status === "running"`:
   * a resident process idling between turns is exactly the one that would be
   * orphaned when its worktree is deleted.
   */
  getLiveSessionIdsForBranch(projectId: string, branch: string | null): string[] {
    return [...this.sessions.values()]
      .filter((session) =>
        session.projectId === projectId
        && session.branch === branch
        && this.isProcessAlive(session))
      .map((session) => session.id);
  }

  /**
   * Check if a session is running
   */
  isRunning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.status === "running";
  }

  /**
   * Stop a session — kills the process but preserves conversation history
   * (like pressing ESC in Claude Code). The session becomes dormant so the
   * next user message will spawn a fresh process with full context replay.
   * The WebSocket stays alive so the UI remains connected.
   *
   * `opts.note` overrides the system entry written into the conversation, for
   * stops the user did not press Stop for (e.g. the worktree being deleted).
   */
  async stopSession(sessionId: string, opts?: { note?: string }): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      const proc = session.process;

      // Try provider-specific interrupt first (e.g. turn/interrupt for Codex)
      const provider = getProvider(session.agentType);
      const interruptMsg = provider.formatInterrupt?.(sessionId);
      if (interruptMsg && proc?.stdin) {
        proc.stdin.write(interruptMsg);
      }

      // Clear session.process before killing so the process close handler
      // (which checks session.process !== childProcess) skips its cleanup —
      // we handle status + broadcast here instead.
      session.process = null;
      this.killProcess(proc);
      this.emitProcessAlive(session, false);

      // Finalize any in-flight streaming assistant text
      await this.finalizeStreamingEntry(session);
      session.store.currentAssistantIndex = null;

      // Add a system message so the UI shows the stop event in the conversation
      await this.pushEntry(sessionId, {
        type: "system",
        content: opts?.note ?? "Session stopped by user.",
        timestamp: Date.now(),
      });

      // Stop point: user interrupted the turn. Written after the visible
      // system note so the divider closes the turn's rendering.
      await this.endActiveTurn(session, "stopped");

      // Mark as dormant so the next message triggers wakeDormantSession
      // (which spawns a new process and replays the full conversation context).
      session.dormant = true;
      // Killing the process kills its background tasks with it — and a user
      // Stop must never ding, so any held completion candidate goes too.
      this.resetCompletion(session);
      session.status = "stopped";
      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "stopped");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
      // The derived activity is "stopped" iff the user's last message hadn't
      // reached completion — that's the "interrupted, unfinished work" case
      // we want to surface as amber. If the prior turn already completed
      // naturally (e.g. New Conversation stops a dormant session between
      // turns), the derived activity is still "completed" and dedupe
      // suppresses any redundant emit, so the workspace dot stays green.
      // Both rules live in `computeBranchActivity`; this site doesn't
      // re-derive them inline.
      if (!session.skipDb) {
        const emitted = await this.emitDerivedBranchActivity(session.projectId, session.branch);
        if (emitted?.activity === "stopped") {
          // Mirror over the per-session WS so the local-side bridge for
          // remote sessions can re-emit on the local EventBus (parallel to
          // how taskCompleted bridges into branch:activity:completed).
          // Local-direct subscribers ignore unknown message types, so this
          // is a no-op there.
          this.broadcastRaw(sessionId, {
            branchActivity: { activity: emitted.activity, since: emitted.since },
          });
        }
      }
      // Don't send { finished: true } — keep the WebSocket connection alive
      // so the UI stays "Connected" and the user can continue the conversation.
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to stop session:`, error);
      return false;
    }
  }

  /**
   * Stop a session and confirm its agent process actually exited, escalating
   * to SIGKILL when SIGTERM is ignored. Returns false if the process is still
   * alive after that.
   *
   * `stopSession` returns as soon as the signal has been sent, which is fine
   * for the Stop button but not for a caller that is about to delete the
   * session's working directory: an agent that traps SIGTERM to flush state
   * would keep writing into a tree that no longer exists.
   *
   * Confirms the tracked agent process, and with it whatever else shared its
   * process group. A grandchild that detached into its own group or session
   * (an MCP server started with `setsid`, say) is not observable here.
   */
  async stopSessionAndWait(
    sessionId: string,
    opts?: { note?: string; termGraceMs?: number; killGraceMs?: number },
  ): Promise<boolean> {
    // Captured up front: stopSession clears session.process before killing, so
    // afterwards there is no handle left to watch.
    const proc = this.sessions.get(sessionId)?.process ?? null;
    const stopped = await this.stopSession(sessionId, { note: opts?.note });
    if (!stopped || !proc) return stopped;

    if (await this.waitForProcessExit(proc, opts?.termGraceMs ?? 3000)) return true;

    console.warn(`[AgentSession] Session ${sessionId} ignored SIGTERM, escalating to SIGKILL`);
    this.killProcess(proc, "SIGKILL");
    const exited = await this.waitForProcessExit(proc, opts?.killGraceMs ?? 2000);
    if (!exited) {
      console.error(`[AgentSession] Session ${sessionId} survived SIGKILL — cannot confirm exit`);
    }
    return exited;
  }

  private async waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // exitCode/signalCode rather than `killed`, which Node sets on signal
    // delivery rather than on the process actually going away.
    while (proc.exitCode === null && proc.signalCode === null) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private async hibernateSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      const proc = session.process;
      session.process = null;
      this.killProcess(proc);
      this.emitProcessAlive(session, false);

      await this.finalizeStreamingEntry(session);
      session.store.currentAssistantIndex = null;
      session.buffer = "";
      this.resetCompletion(session);
      session.dormant = true;
      session.status = "stopped";
      this.touchSession(session);

      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "stopped");
      await this.pushEntry(sessionId, {
        type: "system",
        content: "Agent process hibernated to free resident capacity. Send a message to wake it.",
        timestamp: Date.now(),
      });
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({
        type: "session:status",
        projectId: session.projectId,
        branch: session.branch,
        sessionId: session.id,
        status: "stopped",
      });
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to hibernate session:`, error);
      return false;
    }
  }

  /**
   * Delete a session (stop and remove)
   *
   * Steps (in spec order):
   * 1. stopSession — kills the process and transitions to dormant (no-op if already stopped)
   * 2. delete — ONE parent-row DELETE; the children (entries, turn_snapshots,
   *    native_ids, instruction deliveries) go with it via ON DELETE CASCADE
   *    (skipped for remote sessions)
   * 3. broadcastRaw({finished: true}) — signal subscribers to disconnect cleanly
   *    (must happen before sessions.delete because broadcastRaw looks up the
   *    session by id to reach its subscriber set).
   * 4. sessions.delete — remove from in-memory map
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);

    // 1. Stop the process (safe if already stopped/dormant)
    await this.stopSession(sessionId);

    // 2. Clear DB rows (skip for remote path-based sessions). Deliberately a
    //    SINGLE statement: the old two-step (deleteEntries then delete) could
    //    fail after step one and leave a header row whose conversation was
    //    permanently gone — a state that contradicts "delete the whole
    //    session". Every child table declares ON DELETE CASCADE and the
    //    runtime opens the database with `foreign_keys = ON`, so the parent
    //    DELETE is both sufficient and atomic.
    if (!session.skipDb) {
      await this.storage.agentSessions.delete(sessionId);
    }

    // 3. Signal terminal state so subscribers stop reconnecting — must run
    //    before sessions.delete() since broadcastRaw reads this.sessions.
    this.broadcastRaw(sessionId, { finished: true });

    // 4. Remove from in-memory map
    this.sessions.delete(sessionId);

    // 5. Re-derive branch activity — deleting the latest session can change
    //    which session is now "latest" for the branch, so the activity might
    //    flip (e.g. removing the only stopped session, leaving a completed
    //    one, should turn the dot green). Dedupe handles the no-change case.
    if (!session.skipDb) {
      await this.emitDerivedBranchActivity(session.projectId, session.branch);
    }
    return true;
  }

  /**
   * Retention's own delete path (docs/plans/2026-08-08-session-retention.md
   * §1.4). Deliberately NOT a call into `deleteSession`: that one is
   * stop-first, so a candidate the user woke a moment ago would be killed
   * mid-turn even when the conditional DELETE then declines to remove it.
   * Retention never stops anything — a session with a live process is simply
   * skipped, and the resident-pool LRU will hibernate it into a later sweep.
   *
   * Order is load-bearing: re-check in memory, claim the id, DELETE with the
   * full predicate, and only then produce side effects. A miss (0 rows) means
   * the session was rescued between the scan and now, and nothing at all has
   * happened to it.
   *
   * Returns true only when the row was actually deleted.
   */
  async deleteDormantSessionIfExpired(sessionId: string, cutoff: number): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    // In-memory re-check. `skipDb` sessions (the hub's remote mirrors) own no
    // local row and are never retention candidates; a live process, or any
    // in-flight wake/restart, means someone is using this session right now.
    if (session && (session.skipDb || session.process !== null || session.processStartsInFlight > 0)) {
      return false;
    }
    if (this.retentionDeleting.has(sessionId)) return false;
    // Claim BEFORE the first await: from here on `wakeDormantSession` refuses
    // this id, so a wake can no longer slip in while the DELETE is in flight
    // and end up owning a process whose session row is gone.
    this.retentionDeleting.add(sessionId);
    try {
      const deleted = await this.storage.agentSessions.deleteIfExpired(sessionId, cutoff);
      if (!deleted) return false;

      // Side effects only after the row is gone for good. Same shape as the
      // manual delete: subscribers get a terminal `finished` so an open
      // window stops reconnecting and reports the session as cleaned up.
      if (session) {
        getProvider(session.agentType).onSessionDestroyed?.(sessionId);
        this.broadcastRaw(sessionId, { finished: true });
        this.sessions.delete(sessionId);
        await this.emitDerivedBranchActivity(session.projectId, session.branch);
      }
      return true;
    } finally {
      // Released last, after the map entry is gone — releasing it earlier
      // would reopen the very gap the claim exists to close.
      this.retentionDeleting.delete(sessionId);
    }
  }

  /**
   * Compensating delete for a session whose initial instruction failed.
   *
   * The database DELETE is the linearization point and succeeds only while no
   * transcript entry exists. The in-memory and in-flight checks close the two
   * gaps before persistence. This is deliberately an exact-id operation, not
   * an age-based background policy.
   */
  async discardSessionIfEmpty(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const retained = (outcome: Exclude<Extract<Parameters<typeof logSessionLifecycle>[0], { event: "discard" }>["outcome"], "discarded">) => {
      logSessionLifecycle({ event: "discard", sessionId, outcome });
      return false;
    };
    if (session?.skipDb) return retained("retained_skip_db");
    if ((this.userMessagesInFlight.get(sessionId) ?? 0) > 0) return retained("retained_in_flight");
    if (this.retentionDeleting.has(sessionId)) return retained("retained_deleting");

    // Persistence follows the in-memory append. Never let a conditional DB
    // delete race through that small window.
    if (session?.store.entries.some((entry) => entry !== undefined)) return retained("retained_has_entries");

    this.retentionDeleting.add(sessionId);
    try {
      const deleted = await this.storage.agentSessions.deleteIfEmpty(sessionId);
      if (!deleted) return retained("retained_db_not_empty");
      logSessionLifecycle({ event: "discard", sessionId, outcome: "discarded" });

      if (session) {
        getProvider(session.agentType).onSessionDestroyed?.(sessionId);
        const proc = session.process;
        session.process = null;
        this.killProcess(proc);
        this.emitProcessAlive(session, false);
        this.broadcastRaw(sessionId, { finished: true });
        this.sessions.delete(sessionId);
        await this.emitDerivedBranchActivity(session.projectId, session.branch);
      }
      return true;
    } finally {
      this.retentionDeleting.delete(sessionId);
    }
  }

  /**
   * Restart a session (stop process, clear history, respawn)
   * Returns the same session ID with a fresh conversation
   */
  async restartSession(sessionId: string, projectPath: string, agentType?: AgentType): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    // Restarting a long-dormant session is the second path that spawns a
    // process for a row retention considers expired, and it stays
    // process-less across several awaits below. Claim it synchronously, the
    // same way a wake does (§1.5) — otherwise a sweep can delete the row
    // while this is suspended and the respawn below produces an orphan.
    const release = this.beginProcessStart(session);
    if (!release) {
      console.log(`[AgentSession] Refusing to restart ${sessionId}: retention is deleting it`);
      return false;
    }
    try {
      return await this.restartSessionInner(session, sessionId, projectPath, agentType);
    } finally {
      release();
    }
  }

  private async restartSessionInner(
    session: RunningSession,
    sessionId: string,
    projectPath: string,
    agentType?: AgentType,
  ): Promise<boolean> {
    // Validate the bound incarnation before killing a healthy process or
    // clearing history. A tombstoned checkout makes restart a no-op failure.
    const absoluteWorktreePath = await this.resolveSessionWorktreePath(session, projectPath);

    console.log(`[AgentSession] Restarting session ${sessionId}`);

    // 1. Kill the existing process
    const proc = session.process;
    session.process = null;
    this.killProcess(proc);
    this.emitProcessAlive(session, false);
    // Before the first await: steps 2-7 below are all async, and a grace timer
    // armed for the killed turn would otherwise fire inside that window and
    // commit it — writing a turn_end into the history this restart is about to
    // wipe, and dinging a completion for a turn the user just discarded. The
    // background tasks died with the process, so their snapshot goes too.
    // spawnAgent resets again; that one stays as the fresh-process guard.
    this.resetCompletion(session);

    // 2. Clear persisted entries
    if (!session.skipDb) {
      await this.storage.agentSessions.deleteEntries(sessionId);
      session.historyEpoch = await this.storage.agentSessions.incrementHistoryEpoch(sessionId);
    } else {
      session.historyEpoch += 1;
    }

    // 3. Clear message store
    session.store.patches = [];
    session.store.entries = [];
    session.store.indexProvider.reset();
    session.store.toolTracker.clear();
    session.store.currentAssistantIndex = null;
    session.buffer = "";
    session.dormant = false;
    // The restarted conversation starts with no open turn — never inherit the wiped history's clock.
    session.turnOpenSince = null;
    this.touchSession(session);

    // 4. Broadcast clear signal to all subscribers
    this.broadcastRaw(sessionId, {
      HistorySync: { historyEpoch: session.historyEpoch, reset: true },
    });
    const clearPatch = ConversationPatch.clearAll();
    this.broadcastPatch(sessionId, clearPatch);

    // 5. Update status to running
    session.status = "running";
    if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "running");
    this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // 6. Reset provider state and update agent type if specified
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);
    if (agentType) {
      session.agentType = agentType;
      if (!session.skipDb) await this.storage.agentSessions.updateAgentType(sessionId, agentType);
    }
    getProvider(session.agentType).onSessionCreated?.(sessionId, session.permissionMode);

    // 7. Calculate absolute worktree path and respawn
    await this.ensureResidentCapacity(
      { projectId: session.projectId, branch: session.branch },
      { excludeSessionId: session.id },
    );
    await this.spawnAgent(session, absoluteWorktreePath);

    return true;
  }

  /**
   * Switch a session's coding agent WITHOUT touching its conversation history.
   * Kills the current process (if any) and puts the session into the dormant
   * state; the next user message goes through wakeDormantSession, which spawns
   * the new agent and replays the full conversation context — the same path
   * branch sessions use, so cross-agent continuation is already proven.
   *
   * Refused ("busy") while a turn is in flight on a session that has history:
   * switching mid-run would orphan the in-flight work. A fresh session that is
   * "running" but has no entries yet (idle process waiting for the first
   * message) is safe to switch.
   */
  async switchAgentType(sessionId: string, agentType: AgentType): Promise<"ok" | "not_found" | "busy"> {
    const session = this.sessions.get(sessionId);
    if (!session) return "not_found";
    if (session.agentType === agentType) return "ok";

    const hasHistory = session.store.entries.some(Boolean);
    if (session.status === "running" && hasHistory) return "busy";

    console.log(`[AgentSession] Switching session ${sessionId} agent ${session.agentType} → ${agentType} (dormant, history preserved)`);

    // Kill the idle process — clear session.process first so the close
    // handler skips its own status/broadcast cleanup (same as stopSession).
    const proc = session.process;
    session.process = null;
    this.killProcess(proc);
    this.emitProcessAlive(session, false);

    await this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;
    session.buffer = "";
    this.resetCompletion(session);

    const previousAgentType = session.agentType;
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);
    session.agentType = agentType;
    if (!session.skipDb) await this.storage.agentSessions.updateAgentType(sessionId, agentType);

    // A model name is agent-specific by definition: "opus" is meaningless to
    // Codex, and carrying it across would spawn `codex -c model="opus"` and
    // fail every turn until the user noticed and cleared it by hand. Drop back
    // to the new CLI's own default instead — the picker is live on the dormant
    // session this leaves behind, so naming a Codex model stays one click away.
    const clearedModel = session.model;
    if (clearedModel !== null) {
      session.model = null;
      if (!session.skipDb) await this.storage.agentSessions.updateModel(sessionId, null);
    }

    const agentDisplayName = (t: AgentType) => (t === "codex" ? "Codex" : "Claude Code");

    // Visible confirmation in the conversation; replayed to the new agent as
    // part of the context like other system entries ("Session stopped by user.")
    // Models are free text, so we can't claim the cleared name was invalid for
    // the new agent (the user may have typed a name that's actually valid
    // there) — only state what's known: it was set for the previous agent.
    await this.pushEntry(sessionId, {
      type: "system",
      content: `Coding agent switched to ${agentDisplayName(agentType)}.`
        + (clearedModel !== null
          ? ` Model reset to the default (\`${clearedModel}\` was set for ${agentDisplayName(previousAgentType)}).`
          : ""),
      timestamp: Date.now(),
    });

    session.dormant = true;
    if (session.status !== "stopped") {
      session.status = "stopped";
      if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "stopped");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
    }

    return "ok";
  }

  /**
   * Set (or clear, with null) a session's model. The model is a spawn
   * argument, so it takes effect on the next process the session spawns —
   * immediately for a dormant session (a branch, or one that was stopped),
   * and after retiring the idle process for a session that has one.
   *
   * Refused ("busy") under exactly the rule switchAgentType uses: a turn in
   * flight on a session that has history. Both are respawn-shaped changes, so
   * a divergent rule here would only mean the model chip and the agent chip
   * lock at different moments in the same header row.
   *
   * The name is never validated — an unknown one is passed to the CLI and
   * fails there, same as at creation.
   *
   * The whole transition runs on the session's serial event chain and writes
   * the row BEFORE touching memory, so the three places a model lives — the
   * row, `session.model`, and the process spawned from it — can never disagree:
   * a failed write ("error") leaves all three exactly as they were.
   */
  async setModel(sessionId: string, model: string | null): Promise<"ok" | "not_found" | "busy" | "error"> {
    const session = this.sessions.get(sessionId);
    if (!session) return "not_found";
    const normalized = model?.trim() ? model.trim() : null;

    // Queued behind whatever else is mutating this session (stdout parsing, a
    // turn ending, an earlier model change), so two changes cannot interleave
    // at an await and leave the row holding one name and memory the other.
    return this.runSerialForResult(session, async () => {
      // Re-read every precondition here, not before the queue: what was true
      // when the request arrived may not be true when it reaches the front.
      //
      // Re-picking the model already in force is a no-op, not a change — it
      // must not cost the session its idle process (nor be refused mid-turn).
      if (session.model === normalized) return "ok";
      if (this.isModelChangeTooLate(session)) return "busy";

      console.log(`[AgentSession] Setting session ${sessionId} model ${session.model ?? "default"} → ${normalized ?? "default"}`);

      // Persist first. Memory is what the next spawn reads and the row is what
      // survives a restart; writing the row first means a failure here has
      // changed nothing at all, rather than leaving the two to disagree until
      // the next restart silently reverts the user's choice.
      const previous = session.model;
      if (!session.skipDb) {
        try {
          await this.storage.agentSessions.updateModel(sessionId, normalized);
        } catch (err) {
          console.error(`[AgentSession] Failed to persist model for ${sessionId}:`, err);
          return "error";
        }
        // sendUserMessage does not run on the event chain, so a message could
        // have woken this session across the write above — and that process is
        // already running on `previous`. Undo the row rather than kill a turn
        // the user just started.
        if (this.isModelChangeTooLate(session)) {
          try {
            await this.storage.agentSessions.updateModel(sessionId, previous);
          } catch (err) {
            console.error(`[AgentSession] Failed to roll back model for ${sessionId}:`, err);
          }
          return "busy";
        }
      }

      session.model = normalized;

      // An idle process was spawned with the old model and cannot be told
      // about the new one, so it is retired here exactly as switchAgentType
      // retires it: the next user message goes through wakeDormantSession,
      // which spawns with the new model and replays the full context. No
      // process at all (dormant) is the common case and skips this entirely.
      if (session.process) {
        const proc = session.process;
        session.process = null;
        this.killProcess(proc);
        this.emitProcessAlive(session, false);

        await this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        session.buffer = "";
        this.resetCompletion(session);

        session.dormant = true;
        if (session.status !== "stopped") {
          session.status = "stopped";
          // Best-effort: the model change is already committed, and a restart
          // resets every restored row to "stopped" anyway, so a failure here
          // must not report the model change as failed.
          if (!session.skipDb) {
            try {
              await this.storage.agentSessions.updateStatus(sessionId, "stopped");
            } catch (err) {
              console.error(`[AgentSession] Failed to persist stopped status for ${sessionId}:`, err);
            }
          }
          this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
          this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
        }
      }

      return "ok";
    });
  }

  /**
   * True once the model can no longer reach the CLI: a turn is in flight on a
   * session that has history. Same rule switchAgentType refuses on — both are
   * respawn-shaped changes, and a divergent rule would only mean the model
   * chip and the agent chip lock at different moments in the same header row.
   */
  private isModelChangeTooLate(session: RunningSession): boolean {
    return session.status === "running" && session.store.entries.some(Boolean);
  }

  /**
   * Switch permission mode for a session (preserves conversation history)
   */
  async switchMode(
    sessionId: string,
    projectPath: string,
    newMode: "plan" | "edit",
    initialMessage?: string
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    // Do not mutate mode/process state unless the exact checkout can respawn.
    const absoluteWorktreePath = await this.resolveSessionWorktreePath(session, projectPath);

    console.log(`[AgentSession] Switching session ${sessionId} from ${session.permissionMode} to ${newMode}`);

    // 1. Kill existing process. Discard turn-completion state with it —
    // spawnAgent resets too, but a held candidate's grace timer must not
    // fire in the gap between kill and respawn.
    this.resetCompletion(session);
    const proc = session.process;
    session.process = null;
    this.killProcess(proc);
    this.emitProcessAlive(session, false);

    // 2. Keep message store intact (preserve history in UI)
    // Only reset streaming state and buffer
    await this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;
    session.buffer = "";
    session.dormant = false;
    this.touchSession(session);

    // 3. Set new permission mode + persist
    session.permissionMode = newMode;
    if (!session.skipDb) {
      await this.storage.agentSessions.updatePermissionMode(session.id, newMode);
    }

    // Provider per-session state belongs to the killed process. Without this
    // reset, getInitializationMessages sees initialized=true so the fresh
    // process never receives initialize/thread-start, and the context replay
    // fast-paths a turn/start with the dead process's threadId — Codex
    // rejects it with "Not initialized" (mirrors wakeDormantSession and
    // restartSession step 6).
    const provider = getProvider(session.agentType);
    provider.onSessionDestroyed?.(session.id);
    provider.onSessionCreated?.(session.id, newMode);

    // 4. Update status to running, broadcast
    session.status = "running";
    if (!session.skipDb) await this.storage.agentSessions.updateStatus(sessionId, "running");
    this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // 5. Respawn Claude Code with new mode flags
    await this.ensureResidentCapacity(
      { projectId: session.projectId, branch: session.branch },
      { excludeSessionId: session.id },
    );
    await this.spawnAgent(session, absoluteWorktreePath);

    // 6. Send initial message or conversation summary
    if (initialMessage) {
      // Wait a bit for process to be ready, then send
      setTimeout(() => {
        this.sendUserMessage(sessionId, initialMessage).catch((err) => {
          console.error(`[AgentSession] Failed to send initial message for ${sessionId}:`, err);
        });
      }, 500);
    } else {
      // Build full conversation context from existing entries
      const context = this.buildFullConversationContext(session.store.entries);
      if (context) {
        setTimeout(() => {
          // Send context without adding to visible messages
          const provider = getProvider(session.agentType);
          const formatted = provider.formatUserInput(context, session.id);
          try {
            session.process?.stdin?.write(formatted);
          } catch (error) {
            console.error(`[AgentSession] Failed to send conversation context:`, error);
          }
        }, 500);
      }
    }

    return true;
  }

  /**
   * Accept a plan and restart the session in edit mode
   */
  acceptPlanAndRestart(
    sessionId: string,
    projectPath: string,
    planContent: string
  ): Promise<boolean> {
    return this.switchMode(sessionId, projectPath, "edit", planContent);
  }

  /**
   * Build full conversation context from message entries for context transfer.
   * Uses XML-tagged format to prevent Claude from confusing historical context
   * with actual tool executions in the current session.
   */
  private buildFullConversationContext(entries: AgentMessage[]): string | null {
    const lines: string[] = [];

    for (const entry of entries) {
      if (!entry) continue;

      switch (entry.type) {
        case "user": {
          const text = typeof entry.content === "string"
            ? entry.content
            : entry.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
          lines.push(`<user_message>${text}</user_message>`);
          break;
        }
        case "assistant":
          lines.push(`<assistant_message>${entry.content}</assistant_message>`);
          break;
        case "tool_use": {
          const inputStr = typeof entry.input === "string"
            ? entry.input
            : JSON.stringify(entry.input);
          const truncatedInput = inputStr.length > 2000 ? inputStr.substring(0, 2000) + "..." : inputStr;
          lines.push(`<historical_tool_call tool="${entry.tool}">${truncatedInput}</historical_tool_call>`);
          break;
        }
        case "tool_result": {
          const truncatedOutput = entry.output.length > 2000 ? entry.output.substring(0, 2000) + "..." : entry.output;
          lines.push(`<historical_tool_result>${truncatedOutput}</historical_tool_result>`);
          break;
        }
        case "error":
          lines.push(`<error>${entry.message}</error>`);
          break;
        case "system":
          // Skip system messages (session lifecycle noise)
          break;
        case "turn_end":
          // UI stop-point marker, not conversation content.
          break;
        // Skip thinking blocks (internal)
      }
    }

    if (lines.length === 0) return null;

    return [
      `<conversation_summary>`,
      `This is a READ-ONLY summary of a previous conversation session. The session was interrupted and you are now in a NEW process.`,
      ``,
      `IMPORTANT:`,
      `- You did NOT execute any of the tool calls shown below in THIS session. They happened in a previous, now-terminated process.`,
      `- Any file edits, reads, or other tool actions shown here may or may not have been applied. Do NOT assume they succeeded.`,
      `- If you need to read or edit files, you MUST make new tool calls. Do not reference previous tool calls as if they are still in effect.`,
      `- Respond naturally to the user's latest message below. Use your tools normally — do not format tool calls as text.`,
      ``,
      ...lines,
      `</conversation_summary>`,
    ].join("\n");
  }

  /**
   * Wake a dormant session: spawn process, send full context + user message.
   * Returns false when the session is being reclaimed by retention right now
   * — see the `retentionDeleting` / `processStartsInFlight` pair in
   * `beginProcessStart`.
   */
  private async wakeDormantSession(
    session: RunningSession,
    projectPath: string,
    userMessage: string | ContentPart[],
    userId: string = "local",
    origin?: "workflow",
    notificationDisposition: NotificationDisposition = "result",
  ): Promise<boolean> {
    // Claimed synchronously, before every `await` below — see beginProcessStart.
    const release = this.beginProcessStart(session);
    if (!release) {
      console.log(`[AgentSession] Refusing to wake ${session.id}: retention is deleting it`);
      return false;
    }
    console.log(`[AgentSession] Waking dormant session ${session.id}`);

    try {
      await this.wakeDormantSessionInner(
        session, projectPath, userMessage, userId, origin, notificationDisposition,
      );
      return true;
    } finally {
      release();
    }
  }

  private async wakeDormantSessionInner(
    session: RunningSession,
    projectPath: string,
    userMessage: string | ContentPart[],
    userId: string,
    origin: "workflow" | undefined,
    notificationDisposition: NotificationDisposition,
  ): Promise<void> {
    const absoluteWorktreePath = await this.resolveSessionWorktreePath(session, projectPath);

    await this.ensureResidentCapacity(
      { projectId: session.projectId, branch: session.branch },
      { excludeSessionId: session.id },
    );
    session.dormant = false;
    session.status = "running";
    this.touchSession(session);
    if (!session.skipDb) await this.storage.agentSessions.updateStatus(session.id, "running");
    this.broadcastPatch(session.id, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // Provider per-session state belongs to the previous (killed) process.
    // Without this reset, getInitializationMessages sees initialized=true and
    // the fresh process never receives initialize/thread-start — Codex then
    // rejects every turn/start with "Not initialized" (mirrors restartSession
    // step 6).
    const provider = getProvider(session.agentType);
    provider.onSessionDestroyed?.(session.id);
    provider.onSessionCreated?.(session.id, session.permissionMode);

    // Spawn Claude Code process
    await this.spawnAgent(session, absoluteWorktreePath);

    // Push user message to store (+ persist to DB)
    await this.pushEntry(session.id, {
      type: "user",
      content: userMessage,
      timestamp: Date.now(),
      ...(origin ? { origin } : {}),
      notificationDisposition,
    }, true, userId);
    session.turnOpenSince = Date.now();
    session.turnDisposition = notificationDisposition;

    // After process ready: send full context + new message to stdin
    setTimeout(() => {
      const context = this.buildFullConversationContext(session.store.entries);
      if (context) {
        const provider = getProvider(session.agentType);
        const formatted = provider.formatUserInput(context, session.id);
        try {
          session.process?.stdin?.write(formatted);
        } catch (error) {
          console.error(`[AgentSession] Failed to send context to woken session:`, error);
        }
      }
    }, 500);
  }

  /**
   * Rebuild an in-memory MessageStore (entries, replay patches, tool tracker,
   * index provider) from persisted entry rows. Shared by startup restore and
   * branchSession — entry indices are preserved so replay patches match the
   * original conversation exactly.
   */
  private rebuildStoreFromRows(
    rows: Array<{ entry_index: number; data: string }>,
    sessionIdForLog: string,
  ): MessageStore {
    const indexProvider = new EntryIndexProvider();
    const toolTracker = new EntryTracker(indexProvider);
    const store: MessageStore = {
      patches: [],
      entries: [],
      indexProvider,
      toolTracker,
      currentAssistantIndex: null,
    };

    let maxIndex = -1;
    for (const row of rows) {
      try {
        const message = JSON.parse(row.data) as AgentMessage;
        const idx = row.entry_index;
        store.entries[idx] = message;

        // Generate ADD patch for history replay
        const patch = ConversationPatch.addEntry(idx, message);
        store.patches.push(patch);

        // Rebuild tool tracker for tool_use and tool_result entries
        if (message.type === "tool_use" && message.toolUseId) {
          toolTracker.set(`tool_use:${message.toolUseId}`, idx);
        } else if (message.type === "tool_result" && message.toolUseId) {
          toolTracker.set(`tool_result:${message.toolUseId}`, idx);
        }

        if (idx > maxIndex) maxIndex = idx;
      } catch (error) {
        console.error(`[AgentSession] Failed to parse entry for session ${sessionIdForLog}:`, error);
      }
    }

    // Set index provider to continue after the max restored index
    indexProvider.setIndex(maxIndex + 1);
    return store;
  }

  /**
   * Crash repair (restore path): if the previous process died mid-turn, the
   * history has no closing turn_end — append one with outcome
   * "server_restart" and no duration (the crash time is unknown; the UI
   * shows "interrupted" instead of a fabricated number). Runs BEFORE
   * rebuildStoreFromRows so the store is built from the repaired rows.
   * The other constructor of turn_end entries is endActiveTurn (live paths).
   *
   * Also records a turn_snapshots row at the repair index (mirrors
   * endActiveTurn's hook), capturing the worktree exactly as the crash left
   * it. Without this, review's getStartBoundary would skip the snapshot-less
   * repair boundary and scope the NEXT turn from the stale pre-crash
   * snapshot, folding the interrupted turn's changes into it. Best-effort —
   * this runs on server boot for every restored session and must never
   * throw into the restore path.
   */
  private async repairInterruptedTurn(
    dbSession: AgentSessionRow,
    rows: Array<{ entry_index: number; data: string }>,
  ): Promise<Array<{ entry_index: number; data: string }>> {
    const sessionId = dbSession.id;
    // Scan past trailing system entries (e.g. the hibernate note lands after
    // the turn's turn_end).
    let landingType: string | null = null; // null = no non-system row found
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(rows[i].data) as AgentMessage;
        if (msg.type === "system") continue;
        landingType = msg.type;
      } catch {
        landingType = "unparsable"; // corrupted tail write — treat as content, repair
      }
      break;
    }
    if (landingType === null || landingType === "turn_end") return rows;

    const maxIndex = rows.reduce((m, r) => Math.max(m, r.entry_index), -1);
    const repairIndex = maxIndex + 1;

    // The interrupted turn's disposition has to come off its persisted opening
    // user entry — process memory died with the crash. A crash mid-`result`
    // turn is a genuine attention milestone (the user asked for something that
    // never finished), so it becomes one durable session_failed; a workflow
    // helper or reviewer turn gets its boundary repaired silently.
    const entries: Array<AgentMessage | undefined> = [];
    for (const row of rows) {
      try {
        entries[row.entry_index] = JSON.parse(row.data) as AgentMessage;
      } catch { /* corrupted row: a hole, not a boundary */ }
    }
    const disposition = resolveNotificationDisposition(
      findTurnOpeningUserEntry(entries, repairIndex),
    );

    const repair: AgentMessage = {
      type: "turn_end",
      timestamp: Date.now(),
      outcome: "server_restart",
      notificationDisposition: disposition,
    };
    const data = JSON.stringify(repair);
    const activityReader = this.storage.agentSessions.getActivityById;
    const projected = typeof activityReader === "function"
      ? await activityReader(sessionId, "notification")
      : undefined;
    const notificationScope = projected
      ? { projectId: projected.projectId, branch: projected.branch }
      : dbSession.workspace_checkout_id
        ? null
        : { projectId: dbSession.project_id, branch: dbSession.branch || null };
    const outbox = notificationScope ? sessionMilestoneForTurnEnd({
      sessionId,
      projectId: notificationScope.projectId,
      branch: notificationScope.branch,
      entryIndex: repairIndex,
      outcome: "server_restart",
      disposition,
      createdAt: repair.timestamp,
    }) : undefined;
    await this.storage.agentSessions.upsertTurnEndWithOutbox({
      sessionId,
      entryIndex: repairIndex,
      entryData: data,
      outbox,
    });
    console.log(`[AgentSession] Repaired interrupted turn for ${sessionId} (server_restart turn_end at ${repairIndex}, disposition=${disposition})`);

    try {
      const project = await this.storage.projects.getById(dbSession.project_id);
      if (project?.path) {
        let snapshotPath = resolveWorktreePath(project.path, dbSession.branch);
        if (dbSession.workspace_checkout_id) {
          const checkout = await this.storage.workspaceRegistry.getCheckoutById(dbSession.workspace_checkout_id);
          if (checkout) snapshotPath = checkout.checkout.worktree_path;
        }
        await recordTurnSnapshot(this.storage, sessionId, repairIndex, snapshotPath);
      }
    } catch (error) {
      console.warn(`[AgentSession] Turn snapshot lookup failed for ${sessionId}@${repairIndex}:`, error);
    }

    return [...rows, { entry_index: repairIndex, data }];
  }

  /**
   * Restore sessions from database on startup.
   * Creates dormant RunningSession objects with process=null for sessions that have entries.
   */
  async restoreSessionsFromDb(): Promise<void> {
    const allSessions = await this.storage.agentSessions.getAll();
    let restoredCount = 0;
    let zeroEntryRows = 0;

    for (const dbSession of allSessions) {
      // Skip sessions already in memory
      if (this.sessions.has(dbSession.id)) continue;

      let entries = await this.storage.agentSessions.getEntries(dbSession.id);
      // Skip sessions with no entries (stale metadata)
      if (entries.length === 0) { zeroEntryRows++; continue; }

      // Only sessions the crash left as "running" can hold an interrupted
      // turn. The gate also keeps pre-feature (marker-less, cleanly stopped)
      // histories untouched and makes repair idempotent — this run resets
      // the row to "stopped" below.
      if (dbSession.status === "running") {
        entries = await this.repairInterruptedTurn(dbSession, entries);
      }

      const store = this.rebuildStoreFromRows(entries, dbSession.id);

      const permissionMode = (dbSession.permission_mode === "plan" ? "plan" : "edit") as "plan" | "edit";
      const restoredCheckout = dbSession.workspace_checkout_id
        ? await this.storage.workspaceRegistry.getCheckoutById(dbSession.workspace_checkout_id)
        : undefined;
      const activityReader = this.storage.agentSessions.getActivityById;
      const restoredProjection = typeof activityReader === "function"
        ? await activityReader(dbSession.id, "runtime")
        : restoredCheckout
          ? {
            projectId: restoredCheckout.workspace.project_id,
            branch: restoredCheckout.workspace.branch || null,
          }
          : dbSession.workspace_checkout_id
            ? undefined
            : { projectId: dbSession.project_id, branch: dbSession.branch || null };

      const runningSession: RunningSession = {
        id: dbSession.id,
        projectId: restoredProjection?.projectId ?? dbSession.project_id,
        branch: restoredProjection ? restoredProjection.branch : (dbSession.branch || null),
        workspaceCheckoutId: dbSession.workspace_checkout_id,
        checkoutPath: restoredCheckout?.checkout.worktree_path ?? null,
        process: null,
        dormant: true,
        processStartsInFlight: 0,
        historyEpoch: dbSession.history_epoch ?? 0,
        store,
        subscribers: new Set(),
        status: "stopped",
        buffer: "",
        skipDb: false,
        permissionMode,
        agentType: ((dbSession as unknown as Record<string, unknown>).agent_type as AgentType) || "claude-code",
        model: dbSession.model ?? null,
        branchedFromSessionId: dbSession.branched_from_session_id ?? null,
        branchedFromEntryIndex: dbSession.branched_from_entry_index ?? null,
        completion: new TurnCompletionLedger(this.parkTimeoutMs),
      graceTimer: null,
      parkTimer: null,
      eventChain: Promise.resolve(),
        bgSpawnHintsThisTurn: 0,
        taskStartedThisTurn: 0,
        lastActiveAt: Date.now(),
        turnOpenSince: null,
        turnDisposition: null,
      };

      this.sessions.set(dbSession.id, runningSession);

      // Update DB status to stopped (was likely "running" when server crashed).
      // Use the timestamp-preserving variant — this is a bulk bookkeeping reset,
      // not a real status event, and `updateStatus` would rewrite `updated_at`
      // for every restored row, corrupting the ordering used by
      // `getLatestByBranch`.
      await this.storage.agentSessions.updateStatusPreservingTimestamp(dbSession.id, "stopped");

      restoredCount++;
    }

    await this.repairOrphanedRunningRows(allSessions);
    // Boot baseline for the lifecycle design's Phase 0: every row here is a
    // session identity that never received an instruction (or lost its
    // entries). Logged unconditionally so a zero is also a data point.
    logSessionLifecycle({ event: "boot_zero_entry_rows", count: zeroEntryRows });

    if (restoredCount > 0) {
      console.log(`[AgentSession] Restored ${restoredCount} dormant session(s) from database`);
    }
  }

  /**
   * Reconcile rows the database still calls "running" against what this
   * process actually owns.
   *
   * `create` writes `status='running'` BEFORE the process is spawned, so any
   * path that dies between the INSERT and the first entry leaves a row
   * claiming to run forever. The restore loop above is supposed to be the
   * backstop, but it skips zero-entry rows before it resets crashed statuses
   * — so precisely the sessions that died earliest are the ones nothing ever
   * repairs. Measured on a real worker (2026-08-10): 63 such rows, the oldest
   * four months old, every one of them permanently exempt from session
   * retention (`status <> 'running'`) and inflating the project dashboard's
   * running count (46 reported, 1 real).
   *
   * Reconciliation rather than prevention, deliberately: a DB row and an OS
   * process are two resources with no atomic commit between them, so a kill
   * landing between the INSERT and the spawn leaves the same row no matter
   * how careful `create` becomes. Prevention narrows the window; only
   * reconciliation closes it. Same argument the retention plan's §3.1 makes
   * for snapshot reconciliation over delete events.
   *
   * The ownership test is "not in `this.sessions`", NOT `process === null`: a
   * session that is spawning or waking sits in the map with a null process,
   * and resetting it would be the same class of bug as the wake/retention
   * race in `deleteDormantSessionIfExpired`.
   *
   * STARTUP ONLY. `createNewSession` INSERTs the row before it puts the
   * session in the map, so a few milliseconds exist in which a perfectly
   * healthy session looks orphaned. That window is unreachable from here (no
   * requests are served yet); a periodic caller would first have to add an
   * age threshold.
   *
   * @param snapshot the row list read at the top of `restoreSessionsFromDb`.
   * Rows the loop already reset read as stale "running" here — the map check
   * is what excludes them, which is why it must come after the loop.
   */
  private async repairOrphanedRunningRows(snapshot: AgentSessionRow[]): Promise<void> {
    let repaired = 0;
    for (const row of snapshot) {
      if (row.status !== "running") continue;
      if (this.sessions.has(row.id)) continue;
      // Timestamp-preserving on purpose: this is bookkeeping, not activity.
      // `updateStatus` would push `activity_at` forward on every boot, and a
      // machine that restarts regularly would then never expire anything —
      // a silent failure, since retention would just keep finding nothing.
      await this.storage.agentSessions.updateStatusPreservingTimestamp(row.id, "stopped");
      repaired++;
    }
    if (repaired > 0) {
      console.log(`[AgentSession] Reset ${repaired} orphaned session row(s) left as "running"`);
    }
  }

  /**
   * Create a new dormant session that copies another session's conversation
   * history ("branch"). The new session gets its own DB row, copied entry
   * rows (indices preserved), a rebuilt in-memory store, and a
   * "Branch - <source title>" title. No process is spawned — the first user
   * message goes through wakeDormantSession, which replays the full copied
   * context to a fresh process, so a branch also works with a different
   * agent type than the source.
   *
   * `opts.upToEntryIndex`, when given, is an inclusive cutoff that must land
   * on a `turn_end` row — every branch then ends with its own tail divider.
   * With a cutoff the source's live process is never touched (no
   * finalizeStreamingEntry), so a historical branch is safe even while the
   * source is running. Without a cutoff (legacy full-copy callers) a running
   * source is refused outright — copying mid-turn would leave the branch
   * with a half-finished turn and no closing turn_end.
   */
  async branchSession(
    sourceSessionId: string,
    agentTypeOverride?: AgentType,
    opts: { sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; upToEntryIndex?: number; userId?: string } = {},
  ): Promise<BranchResult> {
    const source = this.sessions.get(sourceSessionId);
    const sourceRow = await this.storage.agentSessions.getById(sourceSessionId);
    if (!source && !sourceRow) return { ok: false, reason: "not-found" };
    // skipDb sessions have no persisted entries to copy
    if (source?.skipDb) return { ok: false, reason: "empty-history" };

    if (opts.upToEntryIndex === undefined) {
      // Legacy full-copy path (no-cutoff callers). Refused mid-turn so a
      // half-finished turn can never be copied; historical branches pass a
      // cutoff and are always allowed.
      if (source?.status === "running") return { ok: false, reason: "running-needs-cutoff" };
      // Flush any in-flight streaming assistant entry so the copy is complete
      if (source) await this.finalizeStreamingEntry(source);
    }

    let entryRows = await this.storage.agentSessions.getEntries(sourceSessionId);
    if (opts.upToEntryIndex !== undefined) {
      // The cutoff must be a stop point: every branched copy ends with a
      // turn_end so the new session has its own tail divider. With a cutoff
      // we read persisted rows only — never finalize the source's stream.
      const cut = entryRows.find((r) => r.entry_index === opts.upToEntryIndex);
      let cutType: string | null = null;
      if (cut) { try { cutType = (JSON.parse(cut.data) as AgentMessage).type; } catch { /* unparsable → invalid */ } }
      if (cutType !== "turn_end") return { ok: false, reason: "invalid-cutoff" };
      entryRows = entryRows.filter((r) => r.entry_index <= opts.upToEntryIndex!);
    }
    if (entryRows.length === 0) return { ok: false, reason: "empty-history" };

    const projectId = source?.projectId ?? sourceRow!.project_id;
    const branch = source?.branch ?? (sourceRow!.branch || null);
    const permissionMode = source?.permissionMode
      ?? ((sourceRow?.permission_mode === "plan" ? "plan" : "edit") as "plan" | "edit");
    const agentType = agentTypeOverride
      ?? source?.agentType
      ?? ((sourceRow?.agent_type as AgentType) || "claude-code");
    // A branch continues the same conversation, so it continues on the same
    // model. Inheriting is only the starting point: the branch arrives dormant,
    // so the picker is live on it and a different model is one click away —
    // that is how a user "changes model mid-session".
    //
    // Except when the branch switches agent: a model name is agent-specific,
    // so inheriting "opus" onto a Codex branch would spawn a session that
    // fails every turn. Fall back to the new CLI's own default instead.
    const sourceAgentType = source?.agentType ?? ((sourceRow?.agent_type as AgentType) || "claude-code");
    const model = agentType === sourceAgentType
      ? (source?.model ?? sourceRow?.model ?? null)
      : null;

    const newId = opts.sessionId ?? randomUUID();
    if (opts.sessionId) {
      const existingBranch = await this.storage.agentSessions.getById(newId);
      if (existingBranch) {
        const existingEntries = await this.storage.agentSessions.getEntries(newId);
        const sameEntries = existingEntries.length === entryRows.length
          && existingEntries.every((row, index) => row.entry_index === entryRows[index]?.entry_index
            && row.data === entryRows[index]?.data);
        if (existingBranch.project_id !== projectId
          || existingBranch.branch !== (branch ?? "")
          || existingBranch.permission_mode !== permissionMode
          || existingBranch.agent_type !== agentType
          || (existingBranch.model ?? null) !== model
          || !sameEntries) {
          throw new Error("Branched session identity is already in use");
        }
        const existingRuntime = this.sessions.get(newId);
        if (existingRuntime && opts.crossRemoteMcp) {
          // Tokens are intentionally not persisted. After a worker restart,
          // hub recovery mints a fresh one and the exact-ID replay must attach
          // it to the restored dormant session before its first wake-up.
          existingRuntime.crossRemoteMcp = opts.crossRemoteMcp;
        }
        // Hub recovery replays the exact preallocated ID after an uncertain
        // response. Returning the already-copied transcript makes the worker
        // operation idempotent without creating a second branch.
        if (!existingBranch.branched_from_session_id) {
          // The entries matched, so the earlier attempt finished the copy but
          // crashed before the pointer write (which runs last for exactly this
          // reason), or the branch predates the pointer feature. Either way
          // the replay carries the same source identity — backfill it, and
          // mirror it onto the restored runtime: session payloads read the
          // runtime, so a DB-only repair would keep the send-back button
          // hidden until the next process restart.
          const repairedEntryIndex = entryRows[entryRows.length - 1]!.entry_index;
          await this.storage.agentSessions.setBranchedFrom(newId, sourceSessionId, repairedEntryIndex);
          if (existingRuntime) {
            existingRuntime.branchedFromSessionId = sourceSessionId;
            existingRuntime.branchedFromEntryIndex = repairedEntryIndex;
          }
        }
        return { ok: true, sessionId: newId };
      }
    }
    let inheritedCheckoutId = source?.workspaceCheckoutId ?? sourceRow?.workspace_checkout_id ?? undefined;
    if (!inheritedCheckoutId) {
      const activeCheckout = await this.storage.workspaceRegistry.getByProjectBranch(
        projectId, branch ?? "", "local",
      );
      inheritedCheckoutId = activeCheckout?.checkout.id;
      if (!inheritedCheckoutId) {
        const project = await this.storage.projects.getById(projectId);
        if (!project?.path) {
          throw new WorkspaceCheckoutUnavailableError(`Project ${projectId} has no local workspace path`);
        }
        await getRegisteredWorktreeBranches(this.storage, projectId, project.path);
      }
    }
    const bound = await this.storage.agentSessions.createBound({
      id: newId,
      project_id: projectId,
      branch: branch ?? "",
      target_id: "local",
      checkout_id: inheritedCheckoutId,
      permission_mode: permissionMode,
      agent_type: agentType,
      model,
    });
    // create() writes status='running' (it exists for the spawn path); a
    // branched session is dormant until the first user message wakes it.
    await this.storage.agentSessions.updateStatusPreservingTimestamp(newId, "stopped");

    for (const row of entryRows) {
      await this.storage.agentSessions.upsertEntry(newId, row.entry_index, row.data);
    }

    // Send-back pointer: lets the branch offer "send this turn's answer back
    // to the session it came from". The entry index is the turn_end the copy
    // ends at (cutoff, or the source's tail for legacy full copies). Written
    // AFTER the entry copy on purpose: a crash before the copy completes makes
    // the exact-ID replay refuse on the entry mismatch above, so the only
    // partially-created state a replay can actually reach is "entries complete,
    // pointer missing" — which the replay's repair branch closes.
    const branchedFromEntryIndex = opts.upToEntryIndex
      ?? entryRows[entryRows.length - 1]!.entry_index;
    await this.storage.agentSessions.setBranchedFrom(newId, sourceSessionId, branchedFromEntryIndex);

    // "Branch - <source title>", falling back to a first-user-message snippet
    // when the source's AI title never resolved.
    let baseTitle = sourceRow?.title ?? null;
    if (!baseTitle) {
      for (const row of entryRows) {
        try {
          const msg = JSON.parse(row.data) as AgentMessage;
          if (msg.type === "user") {
            baseTitle = snippetTitle(extractUserText(msg.content));
            break;
          }
        } catch { /* skip unparsable rows */ }
      }
    }
    await this.storage.agentSessions.updateTitle(newId, `Branch - ${baseTitle || "Conversation"}`);
    // The title is final — claim the one-shot slot so the AI title generator
    // never fires for this session.
    this.markTitleResolved(newId);

    const store = this.rebuildStoreFromRows(entryRows, newId);

    const branched: RunningSession = {
      id: newId,
      projectId,
      branch,
      workspaceCheckoutId: bound.checkout.id,
      checkoutPath: bound.checkout.worktree_path,
      process: null,
      dormant: true,
      processStartsInFlight: 0,
      historyEpoch: 0,
      store,
      subscribers: new Set(),
      status: "stopped",
      buffer: "",
      skipDb: false,
      permissionMode,
      agentType,
      model,
      completion: new TurnCompletionLedger(this.parkTimeoutMs),
      graceTimer: null,
      parkTimer: null,
      eventChain: Promise.resolve(),
      bgSpawnHintsThisTurn: 0,
      taskStartedThisTurn: 0,
      lastActiveAt: Date.now(),
      turnOpenSince: null,
      turnDisposition: null,
      crossRemoteMcp: opts.crossRemoteMcp,
      userId: opts.userId && opts.userId !== "local" ? opts.userId : undefined,
      branchedFromSessionId: sourceSessionId,
      branchedFromEntryIndex,
    };
    this.sessions.set(newId, branched);

    // The branched session is now the branch's latest (fresh updated_at, no
    // completion timestamps) — re-derive the workspace dot like createNewSession.
    await this.emitDerivedBranchActivity(projectId, branch);

    console.log(`[AgentSession] branchSession: ${sourceSessionId} → ${newId} (entries=${entryRows.length}, agentType=${agentType})`);
    return { ok: true, sessionId: newId };
  }

  /**
   * Kill all active session processes and clear state for graceful shutdown
   */
  shutdown(): void {
    for (const [id, session] of this.sessions) {
      try {
        getProvider(session.agentType).onSessionDestroyed?.(id);
      } catch { /* ignore - provider cleanup is best-effort */ }
      this.clearGraceTimer(session);
      this.killProcess(session.process);
    }
    this.sessions.clear();
  }

  /**
   * Broadcast a JSON patch to all subscribers
   */
  /**
   * Generate a title for a freshly-started session from its first user message.
   * Tries the configured chat model first; on failure or when no model is
   * configured, falls back to a truncated snippet. Writes the title once and
   * notifies subscribers so the session list can refresh.
   */
  private async ensureSessionTitle(
    session: RunningSession,
    userText: string,
    userId: string,
  ): Promise<void> {
    const fallback = snippetTitle(userText);
    let title: string | null = null;
    try {
      title = await generateSessionTitle(this.storage, userText, userId);
    } catch (error) {
      console.warn(`[AgentSession] Title generation threw for ${session.id}:`, error);
    }
    const finalTitle = title && title.length > 0 ? title : fallback;
    if (!finalTitle) return;

    try {
      const dbRow = await this.storage.agentSessions.getById(session.id);
      // Respect any title the user (or another writer) has set in the meantime.
      if (!dbRow || (dbRow.title !== null && dbRow.title !== undefined)) return;
      await this.storage.agentSessions.updateTitle(session.id, finalTitle);
      this.broadcastRaw(session.id, { titleUpdated: { title: finalTitle } });
      // Also announce globally so the sidebar updates even when the user has
      // navigated away from this session's workspace (the WS broadcast above
      // only reaches the currently-focused AgentConversation).
      this.emitSessionTitle(session.projectId, session.branch, session.id, finalTitle);
    } catch (error) {
      console.error(`[AgentSession] Failed to persist generated title for ${session.id}:`, error);
    }
  }

  private broadcastPatch(sessionId: string, patch: Patch): void {
    // DEBUG: surface every /status transition — helps localize "dialog still fires"
    const statusOp = patch.find(p => p.path === "/status");
    if (statusOp) {
      const session = this.sessions.get(sessionId);
      console.log(
        `[Agent:broadcastPatch] ${sessionId} /status →`,
        (statusOp.value as { content?: string } | undefined)?.content,
        `subs=${session?.subscribers.size ?? 0}`,
      );
    }
    const msg: AgentWsMessage = { JsonPatch: patch };
    this.broadcastRaw(sessionId, msg);
  }

  /**
   * Broadcast a raw message to all subscribers
   */
  private broadcastRaw(sessionId: string, message: AgentWsMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const json = JSON.stringify(message);
    for (const ws of session.subscribers) {
      try {
        ws.send(json);
      } catch (error) {
        // WebSocket might be closed
        session.subscribers.delete(ws);
      }
    }
  }
}
