/**
 * AgentSessionLifecycleService — the deep module of
 * docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md.
 *
 * Splits "establish a session identity" from "spawn the agent and accept its
 * first instruction". A `pending_first_turn` row has an id, a workspace
 * binding and nothing else: no process, no resident slot, no presence in any
 * list projection. `activate` is the only path that turns it into a session,
 * and every step of that path is a single-statement CAS on the row, so a
 * network retry, a concurrent cancel or a crash can each land in exactly one
 * of four persisted outcomes: pending, active, activation_uncertain, expired.
 *
 * What this module does NOT promise (§3.2, §14.1): exactly-once delivery at
 * the CLI stdin. The provider has no activation-scoped ACK, so a crash in the
 * window between "user entry persisted" and "stdin written" is recorded as
 * `activation_uncertain` and is never re-sent automatically.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ContentPart } from "./agent-types.js";
import type { AgentType } from "./agent-types.js";
import type { NotificationDisposition } from "./agent-types.js";
import { ResidentProcessLimitError } from "./resident-agent-processes.js";
import { WorkspaceCheckoutUnavailableError, type FirstSendOptions } from "./agent-session-manager.js";
import type { SnapshotState } from "./utils/review-snapshot.js";
import type { CrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
import { logSessionLifecycle, type SessionPurpose } from "./session-lifecycle-log.js";
import type {
  AgentSessionLifecycleRow,
  AgentSessionLifecycleState,
  Storage,
} from "./storage/types.js";

// ---------------------------------------------------------------------------
// Public types (design §7, §9.1)
// ---------------------------------------------------------------------------

export type SessionOwner =
  | { kind: "workflow_run"; id: string }
  | { kind: "project_chat_operation"; id: string }
  | { kind: "commander_request"; id: string };

export type ExpiredReason = "cancelled" | "ttl" | "owner_failed";

/** What a caller learns about a row after any lifecycle call (§9.1: carried on every activate response). */
export interface SessionLifecycleView {
  sessionId: string;
  projectId: string;
  branch: string | null;
  state: AgentSessionLifecycleState;
  purpose: string;
  /** True while an activation lease is live; the "activating" pseudo-state (§5.1). */
  leaseHeld: boolean;
  activationKey: string | null;
  activationAttempt: number;
  activatedAt: number | null;
  /** Set on `activation_uncertain` / retryable failures. */
  activationErrorCode: string | null;
  /** Evidence line: the persisted first user entry, when there is one. */
  userEntryIndex: number | null;
  expiredReason: string | null;
  expiredAt: number | null;
  pendingExpiresAt: number | null;
  /** Hub-side view of a remote session: the worker's own id. */
  remoteSessionId?: string;
  /** Legacy-worker fallback (design §9.2): the session was created by `/new`, so it spawned at prepare. */
  legacy?: boolean;
}

/** HTTP status for every result kind this module (and the remote adapter) produces (design §9.1). */
export function lifecycleHttpStatus(kind: string): number {
  switch (kind) {
    case "activated":
    case "prepared":
      return 201;
    case "replayed":
    case "uncertain":
    case "cancelled":
      return 200;
    case "in_progress":
      return 202;
    case "not_found":
      return 404;
    case "idempotency_conflict":
    case "activation_conflict":
    case "resident_limit":
    case "activation_in_progress":
    case "not_pending":
      return 409;
    case "expired":
    case "already_expired":
      return 410;
    case "permanent_failure":
    case "workspace_unavailable":
      return 422;
    case "remote_unreachable":
      return 502;
    case "retryable_failure":
      return 503;
    default:
      return 500;
  }
}

/** Wire shape of every lifecycle route response; `lifecycle` is absent only for not_found / remote_unreachable. */
export interface LifecycleResponseBody {
  kind: string;
  lifecycle?: SessionLifecycleView;
  errorCode?: string;
  error?: string;
  detail?: unknown;
  maxResidentAgentProcesses?: number;
  runningSessions?: unknown;
}

export function toLifecycleResponse(result: { kind: string; view?: SessionLifecycleView; [key: string]: unknown }): { status: number; body: LifecycleResponseBody } {
  const body: LifecycleResponseBody = { kind: result.kind };
  if (result.view) body.lifecycle = result.view;
  if (typeof result.errorCode === "string") body.errorCode = result.errorCode;
  if (typeof result.detail === "string") body.error = result.detail;
  else if (result.detail !== undefined) body.detail = result.detail;
  if (result.kind === "resident_limit" && result.error instanceof ResidentProcessLimitError) {
    body.errorCode = result.error.errorCode;
    body.error = result.error.message;
    body.maxResidentAgentProcesses = result.error.maxResidentAgentProcesses;
    body.runningSessions = result.error.runningSessions;
  } else if (!body.error) {
    body.error = describeLifecycleKind(result.kind);
  }
  return { status: lifecycleHttpStatus(result.kind), body };
}

function describeLifecycleKind(kind: string): string | undefined {
  switch (kind) {
    case "idempotency_conflict": return "Operation key was already used with different content or configuration";
    case "activation_conflict": return "Session is owned by a different activation";
    case "activation_in_progress": return "An activation is in progress";
    case "in_progress": return "Activation in progress";
    case "not_pending": return "Session is not pending";
    case "expired": case "already_expired": return "Prepared session has expired or was cancelled";
    case "not_found": return "Session not found";
    case "permanent_failure": return "Workspace or configuration is unavailable";
    case "retryable_failure": return "Activation failed before any delivery; retry with the same key";
    case "remote_unreachable": return "Remote worker unreachable";
    case "uncertain": return "First instruction delivery could not be confirmed";
    default: return undefined;
  }
}

export interface PrepareAgentSessionInput {
  /** Caller-stable key; every network retry of this prepare carries the same one. */
  operationId: string;
  /** Pre-allocated by the caller (so a token can be minted before spawn) or omitted. */
  sessionId?: string;
  projectId: string;
  branch: string | null;
  permissionMode: "plan" | "edit";
  agentType: AgentType;
  model?: string | null;
  purpose: SessionPurpose;
  owner?: SessionOwner;
  startSnapshot?: SnapshotState | null;
}

export type PrepareResult =
  | { kind: "prepared"; view: SessionLifecycleView }
  | { kind: "replayed"; view: SessionLifecycleView }
  | { kind: "expired"; view: SessionLifecycleView }
  | { kind: "idempotency_conflict"; view: SessionLifecycleView | null; detail: string }
  | { kind: "workspace_unavailable"; detail: string };

export interface ActivateAgentSessionInput {
  sessionId: string;
  activationKey: string;
  instruction: string | ContentPart[];
  force?: boolean;
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  userId?: string;
  crossRemoteMcp?: CrossRemoteMcpConfig;
  /** Emit `session:status running` on activation (commander surfacing). */
  announceRunning?: boolean;
}

export type ActivationResult =
  /** 201 — this call spawned and delivered. */
  | { kind: "activated"; view: SessionLifecycleView }
  /** 200 — same key+hash, already active. */
  | { kind: "replayed"; view: SessionLifecycleView }
  /** 200 — same key+hash, outcome unprovable. Caller must warn, never re-send. */
  | { kind: "uncertain"; view: SessionLifecycleView }
  /** 202 — another holder's lease is live. */
  | { kind: "in_progress"; view: SessionLifecycleView }
  /** 409 — same key, different content. */
  | { kind: "idempotency_conflict"; view: SessionLifecycleView }
  /** 409 — a different key already owns this row (or it never was pending). */
  | { kind: "activation_conflict"; view: SessionLifecycleView }
  /** 409 — resident pool full; row stays pending, retry with the same key. */
  | { kind: "resident_limit"; view: SessionLifecycleView; error: ResidentProcessLimitError }
  /** 410 — tombstone. */
  | { kind: "expired"; view: SessionLifecycleView }
  /** 404 */
  | { kind: "not_found" }
  /** 503 — no side effect happened; row back to pending, same key retries. */
  | { kind: "retryable_failure"; view: SessionLifecycleView; errorCode: string }
  /** 422 — workspace/config permanently unusable; row stays pending until TTL. */
  | { kind: "permanent_failure"; view: SessionLifecycleView; errorCode: string };

export interface CancelPreparedSessionInput {
  sessionId: string;
  reason: ExpiredReason;
}

export type CancelResult =
  | { kind: "cancelled"; view: SessionLifecycleView }
  /** 410 — idempotent: already a tombstone. */
  | { kind: "already_expired"; view: SessionLifecycleView }
  /** 409 — a live activation lease; the CAS decides, cancel lost. */
  | { kind: "activation_in_progress"; view: SessionLifecycleView }
  /** 409 — active / uncertain rows are never cancelled here. */
  | { kind: "not_pending"; view: SessionLifecycleView }
  | { kind: "not_found" };

export interface StartAgentSessionInput extends Omit<PrepareAgentSessionInput, "purpose" | "owner"> {
  instruction: string | ContentPart[];
  purpose: "interactive" | "commander" | "project_chat";
  owner?: SessionOwner;
  force?: boolean;
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  userId?: string;
  crossRemoteMcp?: CrossRemoteMcpConfig;
  announceRunning?: boolean;
}

export type StartResult =
  | ActivationResult
  | Extract<PrepareResult, { kind: "idempotency_conflict" | "workspace_unavailable" }>;

export interface RecoverySummary {
  leaseCleared: number;
  promotedActive: number;
  markedUncertain: number;
  expiredByTtl: number;
}

export interface MaintenanceSummary {
  expiredByTtl: number;
  tombstonesDeleted: number;
  payloadsCleared: number;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The runtime half of activation — implemented by AgentSessionManager. */
export interface LifecycleRuntime {
  prepareSessionRow(input: {
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
  }): Promise<{ workspaceCheckoutId: string; worktreePath: string }>;
  hydratePendingSession(
    sessionId: string,
    row: { projectId: string; branch: string | null; permissionMode: "plan" | "edit"; agentType: AgentType; model: string | null; purpose: SessionPurpose; operationId: string },
    opts: { projectPath: string; force?: boolean; crossRemoteMcp?: CrossRemoteMcpConfig; userId?: string },
  ): Promise<void>;
  sendUserMessage(
    sessionId: string,
    content: string | ContentPart[],
    projectPath?: string,
    userId?: string,
    opts?: FirstSendOptions,
  ): Promise<boolean>;
  dropRuntime(sessionId: string): Promise<boolean>;
  /** Emit the commander-surfacing `session:status running` event. Called only after the first turn is committed. */
  announceSessionRunning?(sessionId: string): void;
  /** Runtime status after hydrate — `error` means spawn failed in place (missing cwd). */
  getSession(sessionId: string): { status: string } | null | undefined;
}

export interface LifecycleServiceDeps {
  storage: Storage;
  runtime: LifecycleRuntime;
  /** Project path lookup; defaults to `storage.projects.getById(...).path`. */
  resolveProjectPath?: (projectId: string) => Promise<string | undefined>;
  now?: () => number;
  /** Activation lease length; renewed at a third of this while spawning. */
  leaseMs?: number;
  /** Per-purpose pending TTL override (ms). */
  pendingTtlMs?: Partial<Record<SessionPurpose, number>>;
  /** How long a tombstone / activation payload outlives its outcome (§11.5). */
  replayWindowMs?: number;
  /** Rows touched per maintenance statement. */
  maintenanceBatch?: number;
}

// ---------------------------------------------------------------------------
// Policy (design §5.3): server-side registry, never client-controlled.
// ---------------------------------------------------------------------------

const DEFAULT_PENDING_TTL_MS: Record<SessionPurpose, number> = {
  interactive: 10 * 60_000,
  interactive_upload: 15 * 60_000,
  commander: 10 * 60_000,
  project_chat: 10 * 60_000,
  workflow_review: 15 * 60_000,
};
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_MAINTENANCE_BATCH = 200;

// ---------------------------------------------------------------------------

/**
 * Thrown from the evidence hook when the row is no longer this activation's
 * (lease lapsed and a cancel or another claim won). The runtime aborts the
 * send BEFORE stdin — the persisted entry is an orphan on a row that has
 * moved on, never a delivery.
 */
export class ActivationLeaseLostError extends Error {
  constructor(sessionId: string) {
    super(`activation lease lost for ${sessionId} before the first instruction was delivered`);
    this.name = "ActivationLeaseLostError";
  }
}

export function hashInstruction(instruction: string | ContentPart[]): string {
  const canonical = typeof instruction === "string"
    ? JSON.stringify({ text: instruction })
    : JSON.stringify(instruction);
  return createHash("sha256").update(canonical).digest("hex");
}

const branchOf = (row: AgentSessionLifecycleRow): string | null => (row.branch === "" ? null : row.branch);

function viewOf(row: AgentSessionLifecycleRow, now: number): SessionLifecycleView {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    branch: branchOf(row),
    state: row.lifecycle_state,
    purpose: row.purpose,
    leaseHeld: row.lifecycle_state === "pending_first_turn"
      && row.activation_lease_expires_at !== null && row.activation_lease_expires_at > now,
    activationKey: row.activation_key,
    activationAttempt: row.activation_attempt,
    activatedAt: row.activated_at,
    activationErrorCode: row.activation_error_code,
    userEntryIndex: row.activation_user_entry_index,
    expiredReason: row.expired_reason,
    expiredAt: row.expired_at,
    pendingExpiresAt: row.pending_expires_at,
  };
}

/** Entry types that prove the agent process already consumed the first turn. */
function provesAgentActivity(type: string | undefined): boolean {
  return type !== undefined && type !== "user" && type !== "system" && type !== "error";
}

export class AgentSessionLifecycleService {
  private readonly storage: Storage;
  private readonly runtime: LifecycleRuntime;
  private readonly resolveProjectPath: (projectId: string) => Promise<string | undefined>;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly pendingTtlMs: Record<SessionPurpose, number>;
  private readonly replayWindowMs: number;
  private readonly maintenanceBatch: number;

  constructor(deps: LifecycleServiceDeps) {
    this.storage = deps.storage;
    this.runtime = deps.runtime;
    this.resolveProjectPath = deps.resolveProjectPath
      ?? (async (projectId) => (await deps.storage.projects.getById(projectId))?.path ?? undefined);
    this.now = deps.now ?? (() => Date.now());
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.pendingTtlMs = { ...DEFAULT_PENDING_TTL_MS, ...(deps.pendingTtlMs ?? {}) };
    this.replayWindowMs = deps.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.maintenanceBatch = deps.maintenanceBatch ?? DEFAULT_MAINTENANCE_BATCH;
  }

  // -------------------------------------------------------------------------
  // start = prepare + activate (§4.3, §10.1–10.3)
  // -------------------------------------------------------------------------

  async start(input: StartAgentSessionInput): Promise<StartResult> {
    const prepared = await this.prepare({
      operationId: input.operationId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      branch: input.branch,
      permissionMode: input.permissionMode,
      agentType: input.agentType,
      model: input.model,
      purpose: input.purpose,
      owner: input.owner,
      startSnapshot: input.startSnapshot,
    });
    if (prepared.kind === "idempotency_conflict" || prepared.kind === "workspace_unavailable") return prepared;
    if (prepared.kind === "expired") return { kind: "expired", view: prepared.view };
    return this.activate({
      sessionId: prepared.view.sessionId,
      // One operation, one activation: the prepare key doubles as the
      // activation key, so a retried start replays instead of re-sending.
      activationKey: input.operationId,
      instruction: input.instruction,
      force: input.force,
      origin: input.origin,
      notificationDisposition: input.notificationDisposition,
      userId: input.userId,
      crossRemoteMcp: input.crossRemoteMcp,
      announceRunning: input.announceRunning,
    });
  }

  // -------------------------------------------------------------------------
  // prepare (§8.1 item 6: idempotent on prepare_operation_id)
  // -------------------------------------------------------------------------

  async prepare(input: PrepareAgentSessionInput): Promise<PrepareResult> {
    const now = this.now();
    const existing = await this.storage.agentSessions.getLifecycleByPrepareOperationId(input.operationId);
    if (existing) return this.replayPrepare(existing, input, now);

    if (input.sessionId) {
      const taken = await this.storage.agentSessions.getLifecycleById(input.sessionId);
      if (taken) {
        return {
          kind: "idempotency_conflict",
          view: viewOf(taken, now),
          detail: taken.prepare_operation_id
            ? "session id belongs to a different prepare operation"
            : "session id already exists",
        };
      }
    }

    const projectPath = await this.resolveProjectPath(input.projectId);
    if (!projectPath) return { kind: "workspace_unavailable", detail: "project not found" };

    const sessionId = input.sessionId ?? randomUUID();
    const model = input.model?.trim() ? input.model.trim() : null;
    try {
      await this.runtime.prepareSessionRow({
        sessionId,
        projectId: input.projectId,
        branch: input.branch,
        projectPath,
        permissionMode: input.permissionMode,
        agentType: input.agentType,
        model,
        purpose: input.purpose,
        owner: input.owner ?? null,
        prepareOperationId: input.operationId,
        pendingExpiresAt: now + this.pendingTtlMs[input.purpose],
        startSnapshot: input.startSnapshot,
      });
    } catch (error) {
      // Lost a concurrent duplicate on the unique prepare_operation_id index:
      // the winner's row is the answer.
      const raced = await this.storage.agentSessions.getLifecycleByPrepareOperationId(input.operationId);
      if (raced) return this.replayPrepare(raced, input, now);
      if (error instanceof WorkspaceCheckoutUnavailableError || /workspace checkout/i.test(String((error as Error)?.message))) {
        return { kind: "workspace_unavailable", detail: (error as Error).message };
      }
      throw error;
    }
    const row = await this.storage.agentSessions.getLifecycleById(sessionId);
    if (!row) throw new Error(`prepare: row ${sessionId} vanished after insert`);
    logSessionLifecycle({
      event: "prepared", sessionId, projectId: input.projectId, branch: input.branch,
      purpose: input.purpose, operationId: input.operationId,
    });
    return { kind: "prepared", view: viewOf(row, now) };
  }

  private replayPrepare(row: AgentSessionLifecycleRow, input: PrepareAgentSessionInput, now: number): PrepareResult {
    const model = input.model?.trim() ? input.model.trim() : null;
    const sameIdentity = row.project_id === input.projectId
      && row.branch === (input.branch ?? "")
      && row.permission_mode === input.permissionMode
      && row.agent_type === input.agentType
      && (row.model ?? null) === model
      && row.purpose === input.purpose
      && (input.sessionId === undefined || input.sessionId === row.id);
    if (!sameIdentity) {
      return { kind: "idempotency_conflict", view: viewOf(row, now), detail: "same prepare operation with different configuration" };
    }
    // Tombstone: the late replay must NOT recreate the session (§8.1 item 6).
    if (row.lifecycle_state === "expired") return { kind: "expired", view: viewOf(row, now) };
    return { kind: "replayed", view: viewOf(row, now) };
  }

  // -------------------------------------------------------------------------
  // activate (§8.1 claim, §8.2 side-effect order)
  // -------------------------------------------------------------------------

  async activate(input: ActivateAgentSessionInput): Promise<ActivationResult> {
    const contentHash = hashInstruction(input.instruction);
    const leaseOwner = randomUUID();

    // Bounded passes: a read decides, a CAS confirms; losing the CAS (or
    // expiring a stale row's TTL) means the row moved, and the next read
    // reports what it became.
    for (let pass = 0; pass < 3; pass++) {
      const now = this.now();
      const row = await this.storage.agentSessions.getLifecycleById(input.sessionId);
      if (!row) return { kind: "not_found" };
      const view = viewOf(row, now);

      switch (row.lifecycle_state) {
        case "expired":
          return { kind: "expired", view };
        case "active":
        case "activation_uncertain": {
          if (row.activation_key !== input.activationKey) return { kind: "activation_conflict", view };
          if (row.activation_content_hash !== contentHash) return { kind: "idempotency_conflict", view };
          return row.lifecycle_state === "active" ? { kind: "replayed", view } : { kind: "uncertain", view };
        }
        case "pending_first_turn": {
          if (row.activation_key !== null && row.activation_key !== input.activationKey) {
            return { kind: "activation_conflict", view };
          }
          if (row.activation_key === input.activationKey && row.activation_content_hash !== contentHash) {
            return { kind: "idempotency_conflict", view };
          }
          if (view.leaseHeld) return { kind: "in_progress", view };
          if (row.pending_expires_at !== null && row.pending_expires_at <= now) {
            // TTL is enforced here, not only in maintenance (which runs every
            // few hours): a stale submission — a suspended tab reconnecting
            // long past its window — must get the tombstone, never execute.
            // expirePending only applies to unleased pending rows; whatever
            // it did or lost to, the re-read reports the terminal state.
            await this.storage.agentSessions.expirePending({ id: row.id, reason: "ttl", now });
            continue;
          }
          const claimed = await this.storage.agentSessions.claimActivation({
            id: row.id,
            activationKey: input.activationKey,
            contentHash,
            contentJson: JSON.stringify(input.instruction),
            leaseOwner,
            leaseExpiresAt: now + this.leaseMs,
            now,
          });
          if (!claimed) continue;
          return this.runActivation(row, input, leaseOwner);
        }
      }
    }
    // Both passes lost the CAS: report the row as it stands now.
    const row = await this.storage.agentSessions.getLifecycleById(input.sessionId);
    if (!row) return { kind: "not_found" };
    return { kind: "in_progress", view: viewOf(row, this.now()) };
  }

  private async runActivation(
    row: AgentSessionLifecycleRow,
    input: ActivateAgentSessionInput,
    leaseOwner: string,
  ): Promise<ActivationResult> {
    const sessionId = row.id;
    const purpose = row.purpose as SessionPurpose;
    const operationId = row.prepare_operation_id ?? input.activationKey;
    const renewEvery = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const renewer = setInterval(() => {
      void this.storage.agentSessions.renewActivationLease({
        id: sessionId, leaseOwner, leaseExpiresAt: this.now() + this.leaseMs,
      }).catch(() => { /* a lost lease surfaces at the commit CAS */ });
    }, renewEvery);
    renewer.unref?.();

    const currentView = async (): Promise<SessionLifecycleView> => {
      const fresh = await this.storage.agentSessions.getLifecycleById(sessionId);
      return fresh ? viewOf(fresh, this.now()) : viewOf(row, this.now());
    };
    const giveBack = async (errorCode: string): Promise<void> => {
      await this.runtime.dropRuntime(sessionId);
      await this.storage.agentSessions.releaseActivationLease({ id: sessionId, expectLeaseOwner: leaseOwner, errorCode });
    };

    try {
      const projectPath = await this.resolveProjectPath(row.project_id);
      if (!projectPath) {
        await giveBack("project_missing");
        return { kind: "permanent_failure", view: await currentView(), errorCode: "project_missing" };
      }

      // hydrate + capacity + spawn (§8.2). The row is not in the manager —
      // startup restore skips zero-entry rows — so this rebuilds it by id.
      try {
        await this.runtime.hydratePendingSession(sessionId, {
          projectId: row.project_id,
          branch: branchOf(row),
          permissionMode: row.permission_mode === "plan" ? "plan" : "edit",
          agentType: (row.agent_type ?? "claude-code") as AgentType,
          model: row.model,
          purpose,
          operationId,
        }, {
          projectPath,
          force: input.force,
          crossRemoteMcp: input.crossRemoteMcp,
          userId: input.userId,
        });
      } catch (error) {
        if (error instanceof ResidentProcessLimitError) {
          await giveBack("resident_limit_reached");
          return { kind: "resident_limit", view: await currentView(), error };
        }
        if (error instanceof WorkspaceCheckoutUnavailableError) {
          await giveBack("workspace_unavailable");
          return { kind: "permanent_failure", view: await currentView(), errorCode: "workspace_unavailable" };
        }
        console.error(`[SessionLifecycle] hydrate failed for ${sessionId}:`, error);
        await giveBack("spawn_failed");
        return { kind: "retryable_failure", view: await currentView(), errorCode: "spawn_failed" };
      }
      if (this.runtime.getSession(sessionId)?.status === "error") {
        // spawnAgent refused in place (cwd missing). Nothing was delivered.
        await giveBack("workspace_unavailable");
        return { kind: "permanent_failure", view: await currentView(), errorCode: "workspace_unavailable" };
      }

      // cancel/activate race (§8.1): the lease we hold blocks cancel's CAS,
      // but a lease that lapsed during a long spawn could have been taken.
      const beforeSend = await this.storage.agentSessions.getLifecycleById(sessionId);
      if (!beforeSend || beforeSend.lifecycle_state !== "pending_first_turn" || beforeSend.activation_lease_owner !== leaseOwner
        || (beforeSend.activation_lease_expires_at ?? 0) <= this.now()) {
        await this.runtime.dropRuntime(sessionId);
        if (!beforeSend) return { kind: "not_found" };
        const view = viewOf(beforeSend, this.now());
        return beforeSend.lifecycle_state === "expired" ? { kind: "expired", view } : { kind: "activation_conflict", view };
      }

      // First instruction: entry persisted (evidence recorded) → stdin.
      let userEntryIndex: number | null = null;
      let accepted = false;
      let sendError: unknown;
      try {
        accepted = await this.runtime.sendUserMessage(sessionId, input.instruction, projectPath, input.userId ?? "local", {
          origin: input.origin,
          notificationDisposition: input.notificationDisposition,
          onUserEntryPersisted: async (entryIndex) => {
            // The evidence CAS is the last gate before stdin: it only lands
            // while this activation still holds the lease. Losing it means a
            // cancel or another claim won after the pre-send check — abort
            // the send so a tombstone / the other holder never gets a
            // delivery from us.
            const recorded = await this.storage.agentSessions.setActivationUserEntryIndex({ id: sessionId, leaseOwner, entryIndex, now: this.now() });
            if (!recorded) throw new ActivationLeaseLostError(sessionId);
            userEntryIndex = entryIndex;
          },
        });
      } catch (error) {
        sendError = error;
      }

      if (sendError instanceof ActivationLeaseLostError) {
        // The user entry is durable in the transcript even though the
        // evidence line was refused. That entry cannot be taken back cheaply,
        // and a clean re-claim would hydrate it and append the same first
        // instruction again. So this is the uncertain outcome (§5.2): no
        // re-send, runtime kept for inspection — unless a cancel already
        // won, in which case the tombstone (and its orphan entry) stands.
        const lost = await this.storage.agentSessions.getLifecycleById(sessionId);
        if (!lost) return { kind: "not_found" };
        if (lost.lifecycle_state === "expired") {
          await this.runtime.dropRuntime(sessionId);
          logSessionLifecycle({ event: "activation_retryable", sessionId, purpose, operationId, reason: "lease_lost" });
          return { kind: "expired", view: viewOf(lost, this.now()) };
        }
        const marked = await this.storage.agentSessions.markActivationUncertain({ id: sessionId, errorCode: "lease_lost_after_entry" });
        if (!marked) {
          // A cancel or the TTL sweep moved the row between the read and this
          // CAS (evidence was never recorded, so nothing stopped them). The
          // row's real terminal state wins; a tombstone gets no runtime.
          const moved = await this.storage.agentSessions.getLifecycleById(sessionId);
          if (!moved) { await this.runtime.dropRuntime(sessionId); return { kind: "not_found" }; }
          const view = viewOf(moved, this.now());
          if (moved.lifecycle_state === "expired") {
            await this.runtime.dropRuntime(sessionId);
            logSessionLifecycle({ event: "activation_retryable", sessionId, purpose, operationId, reason: "lease_lost" });
            return { kind: "expired", view };
          }
          if (moved.lifecycle_state === "active" || moved.lifecycle_state === "activation_uncertain") {
            // A competing activation finished first. Same idempotency
            // contract as the read in activate(): the caller's own key and
            // content mean its operation succeeded (replayed / uncertain),
            // not that someone else owns the row.
            if (moved.activation_key !== input.activationKey) return { kind: "activation_conflict", view };
            if (moved.activation_content_hash !== hashInstruction(input.instruction)) return { kind: "idempotency_conflict", view };
            return moved.lifecycle_state === "active" ? { kind: "replayed", view } : { kind: "uncertain", view };
          }
          // Still pending under someone else's live lease: report it as theirs.
          await this.runtime.dropRuntime(sessionId);
          return { kind: "activation_conflict", view };
        }
        logSessionLifecycle({ event: "activation_uncertain", sessionId, purpose, operationId, reason: "lease_lost_after_entry" });
        return { kind: "uncertain", view: await currentView() };
      }

      if (accepted) {
        const committed = await this.storage.agentSessions.completeActivation({
          id: sessionId, expectLeaseOwner: leaseOwner, activatedAt: this.now(), status: "running",
        });
        if (!committed) {
          // Unreachable while the lease is held; recorded honestly if it is.
          await this.storage.agentSessions.markActivationUncertain({ id: sessionId, errorCode: "commit_lost" });
          logSessionLifecycle({ event: "activation_uncertain", sessionId, purpose, operationId, reason: "commit_lost" });
          return { kind: "uncertain", view: await currentView() };
        }
        logSessionLifecycle({ event: "activated", sessionId, purpose, operationId, attempt: row.activation_attempt + 1 });
        // Surface the session only now that it HAS its first turn: announcing
        // at spawn could push an empty pending session into an open window if
        // the send then failed (§10.2).
        if (input.announceRunning) this.runtime.announceSessionRunning?.(sessionId);
        return { kind: "activated", view: await currentView() };
      }

      if (userEntryIndex !== null) {
        // The user turn is durable but the stdin write failed or threw: the
        // honest outcome. The runtime stays for inspection (§5.2).
        const code = sendError ? "send_threw" : "stdin_write_failed";
        await this.storage.agentSessions.markActivationUncertain({ id: sessionId, expectLeaseOwner: leaseOwner, errorCode: code });
        logSessionLifecycle({ event: "activation_uncertain", sessionId, purpose, operationId, reason: code });
        return { kind: "uncertain", view: await currentView() };
      }

      // Rejected before any entry existed: provably no side effect.
      const code = sendError ? "send_threw" : "provider_rejected";
      if (sendError) console.error(`[SessionLifecycle] first send threw for ${sessionId}:`, sendError);
      await giveBack(code);
      logSessionLifecycle({ event: "activation_retryable", sessionId, purpose, operationId, reason: code });
      return { kind: "retryable_failure", view: await currentView(), errorCode: code };
    } finally {
      clearInterval(renewer);
    }
  }

  // -------------------------------------------------------------------------
  // cancel (§8.1 CAS against a live lease; §11.1 tombstone, never delete)
  // -------------------------------------------------------------------------

  async cancel(input: CancelPreparedSessionInput): Promise<CancelResult> {
    const now = this.now();
    const outcome = await this.storage.agentSessions.expirePending({ id: input.sessionId, reason: input.reason, now });
    const row = await this.storage.agentSessions.getLifecycleById(input.sessionId);
    if (!row) return { kind: "not_found" };
    const view = viewOf(row, now);
    switch (outcome) {
      case "expired":
        // A runtime cannot exist for an unleased pending row; drop defensively.
        await this.runtime.dropRuntime(input.sessionId);
        logSessionLifecycle({
          event: "expired", sessionId: row.id, purpose: row.purpose as SessionPurpose,
          operationId: row.prepare_operation_id ?? undefined, reason: input.reason,
        });
        return { kind: "cancelled", view };
      case "already_expired":
        return { kind: "already_expired", view };
      case "lease_held":
        return { kind: "activation_in_progress", view };
      case "uncertain":
        // Evidence without a live holder: the row just became
        // activation_uncertain (§8.3). The runtime, if any, stays for inspection.
        logSessionLifecycle({
          event: "activation_uncertain", sessionId: row.id, purpose: row.purpose as SessionPurpose,
          operationId: row.prepare_operation_id ?? undefined, reason: "lease_lost_after_entry",
        });
        return { kind: "not_pending", view };
      case "not_pending":
        return { kind: "not_pending", view };
      case "not_found":
        return { kind: "not_found" };
    }
  }

  async getState(sessionId: string): Promise<SessionLifecycleView | undefined> {
    const row = await this.storage.agentSessions.getLifecycleById(sessionId);
    return row ? viewOf(row, this.now()) : undefined;
  }

  // -------------------------------------------------------------------------
  // recover (§8.3): startup, before restoreSessionsFromDb.
  // -------------------------------------------------------------------------

  async recover(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { leaseCleared: 0, promotedActive: 0, markedUncertain: 0, expiredByTtl: 0 };
    const now = this.now();
    for (const row of await this.storage.agentSessions.listPendingWithLease()) {
      const entries = await this.storage.agentSessions.getEntries(row.id);
      const types = entries.map((entry) => {
        try { return (JSON.parse(entry.data) as { type?: string }).type; } catch { return undefined; }
      });
      const hasUserEntry = row.activation_user_entry_index !== null || types.includes("user");
      const hasAgentActivity = types.some(provesAgentActivity);
      const purpose = row.purpose as SessionPurpose;
      const operationId = row.prepare_operation_id ?? undefined;
      // Whatever process the crashed activation started is gone with it;
      // a hot recover (tests) may still find one.
      await this.runtime.dropRuntime(row.id);
      if (hasAgentActivity) {
        if (await this.storage.agentSessions.completeActivation({ id: row.id, activatedAt: now, status: "stopped" })) {
          summary.promotedActive++;
          logSessionLifecycle({ event: "activated", sessionId: row.id, purpose, operationId, attempt: row.activation_attempt, recovered: true });
        }
      } else if (hasUserEntry) {
        if (await this.storage.agentSessions.markActivationUncertain({ id: row.id, errorCode: "crash_during_activation" })) {
          summary.markedUncertain++;
          logSessionLifecycle({ event: "activation_uncertain", sessionId: row.id, purpose, operationId, reason: "crash_during_activation" });
        }
      } else if (await this.storage.agentSessions.releaseActivationLease({ id: row.id, errorCode: "crash_before_entry" })) {
        summary.leaseCleared++;
      }
    }
    summary.expiredByTtl = await this.expireStale(now);
    if (summary.leaseCleared + summary.promotedActive + summary.markedUncertain + summary.expiredByTtl > 0) {
      console.log(
        `[SessionLifecycle] recover: lease cleared ${summary.leaseCleared}, promoted ${summary.promotedActive}, `
        + `uncertain ${summary.markedUncertain}, ttl-expired ${summary.expiredByTtl}`,
      );
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // maintenance (§11): rides the retention sweeper's tick, not gated by it.
  // -------------------------------------------------------------------------

  async maintain(): Promise<MaintenanceSummary> {
    const now = this.now();
    const expiredByTtl = await this.expireStale(now);
    const cutoff = now - this.replayWindowMs;
    const tombstonesDeleted = await this.storage.agentSessions.deleteExpiredTombstones({ cutoff, limit: this.maintenanceBatch });
    const payloadsCleared = await this.storage.agentSessions.clearActivationPayloads({ cutoff, limit: this.maintenanceBatch });
    if (expiredByTtl + tombstonesDeleted + payloadsCleared > 0) {
      console.log(
        `[SessionLifecycle] maintenance: ttl-expired ${expiredByTtl}, tombstones deleted ${tombstonesDeleted}, `
        + `payloads cleared ${payloadsCleared}`,
      );
    }
    return { expiredByTtl, tombstonesDeleted, payloadsCleared };
  }

  private async expireStale(now: number): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.storage.agentSessions.expirePendingOlderThan({ now, limit: this.maintenanceBatch });
      total += n;
      if (n < this.maintenanceBatch) return total;
    }
  }
}
