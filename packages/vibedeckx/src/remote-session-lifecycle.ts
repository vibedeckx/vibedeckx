/**
 * Hub-side adapter for the prepared-session lifecycle on a remote worker
 * (docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md §9.2).
 *
 * The worker is the authority for the runtime lifecycle; the hub keeps a
 * durable intent (stable local id, remote id, operation key) that lands
 * BEFORE any worker call, so a lost response is replayed with the same ids
 * and the same activation key — never a second session. The ordinary remote
 * projection (mapping row, search cache, notification watch, stream) is
 * published only once the worker reports active/uncertain (§9.2 step 5).
 *
 * Old workers (no `prepare` capability) get the legacy `/new` → `/message` →
 * `discard-if-empty` sequence behind the same interface; their views carry
 * `legacy: true` because the session spawned at prepare (§9.2 last paragraph).
 */
import { randomUUID } from "node:crypto";
import type { ContentPart, NotificationDisposition } from "./agent-types.js";
import type { EventBus } from "./event-bus.js";
import { mintCrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { extractUserText } from "./utils/session-title.js";
import { WATCH_WINDOW_MS as NOTIFICATION_WATCH_WINDOW_MS } from "./remote-notification-sync.js";
import {
  bindRemoteSessionMapping,
  createRemoteAgentSession,
  ensureRemoteAgentStream,
  generateAndPushRemoteSessionTitle,
  type RemoteAgentSessionDeps,
} from "./remote-agent-sessions.js";
import type { SessionPurpose } from "./session-lifecycle-log.js";
import type { RemoteSessionCreationIntent, RemoteSessionMapping } from "./storage/types.js";
import type {
  ActivationResult,
  CancelResult,
  ExpiredReason,
  PrepareResult,
  SessionLifecycleView,
  SessionOwner,
} from "./agent-session-lifecycle.js";

export const LIFECYCLE_PREPARE_CAPABILITY = "http:POST /api/path/agent-sessions/prepare";

export interface RemoteLifecycleDeps extends RemoteAgentSessionDeps {
  eventBus: EventBus | null;
  now?: () => number;
}

export interface RemotePrepareParams {
  projectId: string;
  remoteServerId: string;
  remotePath: string;
  branch: string | null;
  permissionMode: "plan" | "edit";
  agentType: string;
  model: string | null;
  purpose: SessionPurpose;
  owner?: SessionOwner;
  operationId: string;
  /** Caller-preallocated local id (e.g. project chat); derived from the remote id otherwise. */
  localSessionId?: string;
  /** Caller-preallocated worker-side id (project chat pins both halves of the identity); minted otherwise. */
  remoteSessionId?: string;
  userId: string | undefined;
}

export interface RemoteActivateParams {
  localSessionId: string;
  activationKey: string;
  instruction: string | ContentPart[];
  force?: boolean;
  origin?: "workflow";
  notificationDisposition?: NotificationDisposition;
  userId: string | undefined;
}

export type RemoteUnreachable = { kind: "remote_unreachable"; status: number; detail: unknown; view?: SessionLifecycleView };
export type RemotePrepareResult = PrepareResult | RemoteUnreachable;
export type RemoteActivationResult = ActivationResult | RemoteUnreachable;
export type RemoteCancelResult = CancelResult | RemoteUnreachable;

interface WorkerLifecycleBody {
  kind: string;
  lifecycle?: SessionLifecycleView;
  errorCode?: string;
  error?: string;
  maxResidentAgentProcesses?: number;
  runningSessions?: unknown;
}

function parseWorkerBody(data: unknown): WorkerLifecycleBody | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (typeof body.kind !== "string") return null;
  const lifecycle = body.lifecycle && typeof body.lifecycle === "object" ? body.lifecycle as SessionLifecycleView : undefined;
  return { kind: body.kind, lifecycle, errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
    maxResidentAgentProcesses: typeof body.maxResidentAgentProcesses === "number" ? body.maxResidentAgentProcesses : undefined,
    runningSessions: body.runningSessions };
}

const isTransport = (errorCode: string | undefined) => errorCode === "network_error" || errorCode === "timeout";

export class RemoteSessionLifecycleAdapter {
  private readonly deps: RemoteLifecycleDeps;
  private readonly now: () => number;

  constructor(deps: RemoteLifecycleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Capability gate (§9.2): never probe with a 404. */
  async supports(remoteServerId: string): Promise<boolean> {
    const server = await this.deps.storage.remoteServers.getById(remoteServerId);
    return server?.worker_capabilities?.includes(LIFECYCLE_PREPARE_CAPABILITY) === true;
  }

  // -------------------------------------------------------------------------

  /**
   * One operation, one worker round trip: the hub records the intent, then
   * calls the worker's `start` (prepare + activate under the same key). A
   * legacy worker gets prepare (= `/new`) followed by activate (= `/message`).
   */
  async start(params: RemotePrepareParams & Omit<RemoteActivateParams, "localSessionId" | "activationKey">): Promise<RemoteActivationResult | Extract<RemotePrepareResult, { kind: "idempotency_conflict" | "workspace_unavailable" | "remote_unreachable" }>> {
    const ids = await this.ensureIntent(params);
    if (ids.kind === "idempotency_conflict") return ids;
    const { localSessionId, remoteSessionId } = ids;
    const activation = {
      localSessionId, activationKey: params.operationId, instruction: params.instruction, force: params.force,
      origin: params.origin, notificationDisposition: params.notificationDisposition, userId: params.userId,
    };

    if (!(await this.supports(params.remoteServerId))) {
      const prepared = await this.legacyPrepare(params, localSessionId, remoteSessionId, ids.existing);
      if (prepared.kind !== "prepared" && prepared.kind !== "replayed") return prepared;
      return this.activate(activation);
    }

    const preRegistered = !this.deps.remoteSessionMap.has(localSessionId);
    if (preRegistered) {
      this.deps.remoteSessionMap.set(localSessionId, { remoteServerId: params.remoteServerId, remoteSessionId, branch: params.branch });
    }
    const crossRemoteMcp = await this.mintFor(localSessionId, params.userId, params.remoteServerId);
    const activityAt = this.now();
    const result = await proxyToRemoteAuto(
      params.remoteServerId, "POST", "/api/path/agent-sessions/start",
      {
        path: params.remotePath, branch: params.branch, permissionMode: params.permissionMode,
        agentType: params.agentType, model: params.model, sessionId: remoteSessionId,
        operationId: params.operationId, purpose: params.purpose, owner: params.owner ?? null,
        instruction: params.instruction, force: params.force === true, origin: params.origin,
        notificationDisposition: params.notificationDisposition,
        ...(crossRemoteMcp ? { crossRemoteMcp } : {}),
      },
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    const body = parseWorkerBody(result.data);
    if (!result.ok && (isTransport(result.errorCode) || !body)) {
      if (preRegistered) this.deps.remoteSessionMap.delete(localSessionId);
      await this.deps.storage.remoteSessionCreationIntents.recordError(localSessionId, `start: worker result unknown (${result.errorCode ?? result.status})`).catch(() => {});
      return { kind: "remote_unreachable", status: result.status, detail: result.data };
    }
    if (body!.kind === "workspace_unavailable") {
      if (preRegistered) this.deps.remoteSessionMap.delete(localSessionId);
      return { kind: "workspace_unavailable", detail: body!.error ?? "workspace unavailable" };
    }
    await this.deps.storage.remoteSessionCreationIntents.markPrepared(localSessionId, this.now()).catch(() => {});
    return this.handleActivationOutcome(body!, {
      localSessionId, remoteServerId: params.remoteServerId, remoteSessionId, projectId: params.projectId,
      branch: params.branch, remotePath: params.remotePath, mapping: undefined, preRegistered, activityAt,
      instruction: params.instruction, userId: params.userId, agentType: params.agentType, model: params.model,
    });
  }

  /** Durable saga boundary (§9.2 step 1): the intent, keyed by the operation, lands before any worker call. */
  private async ensureIntent(params: RemotePrepareParams): Promise<
    | { kind: "ids"; localSessionId: string; remoteSessionId: string; existing: RemoteSessionCreationIntent | undefined }
    | { kind: "idempotency_conflict"; view: null; detail: string }
  > {
    const intents = this.deps.storage.remoteSessionCreationIntents;
    const existing = await intents.getByPrepareOperationId(params.operationId);
    if (existing) {
      const same = existing.project_id === params.projectId
        && existing.remote_server_id === params.remoteServerId
        && (existing.branch ?? null) === params.branch
        && existing.permission_mode === params.permissionMode
        && (existing.agent_type ?? null) === params.agentType
        && (existing.model ?? null) === params.model
        && (params.localSessionId === undefined || params.localSessionId === existing.local_session_id)
        && (params.remoteSessionId === undefined || params.remoteSessionId === existing.remote_session_id);
      if (!same) return { kind: "idempotency_conflict", view: null, detail: "same prepare operation with different configuration" };
      return { kind: "ids", localSessionId: existing.local_session_id, remoteSessionId: existing.remote_session_id, existing };
    }
    const remoteSessionId = params.remoteSessionId ?? randomUUID();
    const localSessionId = params.localSessionId ?? `remote-${params.remoteServerId}-${params.projectId}-${remoteSessionId}`;
    await intents.begin({
      localSessionId,
      remoteSessionId,
      projectId: params.projectId,
      remoteServerId: params.remoteServerId,
      branch: params.branch,
      remotePath: params.remotePath,
      permissionMode: params.permissionMode,
      agentType: params.agentType,
      model: params.model,
      force: false,
      userId: params.userId ?? null,
      prepareOperationId: params.operationId,
    });
    return { kind: "ids", localSessionId, remoteSessionId, existing: undefined };
  }

  private mintFor(localSessionId: string, userId: string | undefined, remoteServerId: string) {
    return mintCrossRemoteMcpConfig(
      { storage: this.deps.storage },
      { userId, sessionId: localSessionId, sourceRemoteServerId: remoteServerId },
    ).catch((err) => {
      console.error(`[RemoteLifecycle] cross-remote mint failed for ${localSessionId}:`, err);
      return undefined;
    });
  }

  async prepare(params: RemotePrepareParams): Promise<RemotePrepareResult> {
    const intents = this.deps.storage.remoteSessionCreationIntents;
    const ids = await this.ensureIntent(params);
    if (ids.kind === "idempotency_conflict") return ids;
    const { localSessionId, remoteSessionId, existing } = ids;

    if (!(await this.supports(params.remoteServerId))) {
      return this.legacyPrepare(params, localSessionId, remoteSessionId, existing);
    }

    const result = await proxyToRemoteAuto(
      params.remoteServerId, "POST", "/api/path/agent-sessions/prepare",
      {
        path: params.remotePath, branch: params.branch, permissionMode: params.permissionMode,
        agentType: params.agentType, model: params.model, sessionId: remoteSessionId,
        operationId: params.operationId, purpose: params.purpose, owner: params.owner ?? null,
      },
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    const body = parseWorkerBody(result.data);
    if (!result.ok && (isTransport(result.errorCode) || !body)) {
      await intents.recordError(localSessionId, `prepare: worker result unknown (${result.errorCode ?? result.status})`).catch(() => {});
      return { kind: "remote_unreachable", status: result.status, detail: result.data };
    }
    const view = body!.lifecycle ? this.localize(body!.lifecycle, localSessionId, params.projectId, remoteSessionId) : undefined;
    if (body!.kind === "prepared" || body!.kind === "replayed") {
      await intents.markPrepared(localSessionId, this.now());
      return { kind: body!.kind, view: view! };
    }
    if (body!.kind === "expired") return { kind: "expired", view: view! };
    if (body!.kind === "workspace_unavailable") return { kind: "workspace_unavailable", detail: body!.error ?? "workspace unavailable" };
    return { kind: "idempotency_conflict", view: view ?? null, detail: body!.error ?? body!.kind };
  }

  async activate(params: RemoteActivateParams): Promise<RemoteActivationResult> {
    const target = await this.resolve(params.localSessionId);
    if (!target) return { kind: "not_found" };
    const { remoteServerId, remoteSessionId, projectId, branch, remotePath, mapping, intent } = target;

    if (!(await this.supports(remoteServerId))) {
      return this.legacyActivate(params, target);
    }

    // Pre-register (as `createRemoteAgentSession` does): the worker spawns the
    // agent during activate, and its first cross-remote tool call must find
    // the local id usable. Undone below if the worker did not activate.
    const preRegistered = !this.deps.remoteSessionMap.has(params.localSessionId);
    if (preRegistered) {
      this.deps.remoteSessionMap.set(params.localSessionId, { remoteServerId, remoteSessionId, branch });
    }
    const crossRemoteMcp = await this.mintFor(params.localSessionId, params.userId, remoteServerId);

    const activityAt = this.now();
    const result = await proxyToRemoteAuto(
      remoteServerId, "POST", `/api/agent-sessions/${encodeURIComponent(remoteSessionId)}/activate`,
      {
        activationKey: params.activationKey, instruction: params.instruction, force: params.force === true,
        origin: params.origin, notificationDisposition: params.notificationDisposition,
        ...(crossRemoteMcp ? { crossRemoteMcp } : {}),
      },
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    const body = parseWorkerBody(result.data);
    if (!result.ok && (isTransport(result.errorCode) || !body)) {
      if (preRegistered && !mapping) this.deps.remoteSessionMap.delete(params.localSessionId);
      if (intent) await this.deps.storage.remoteSessionCreationIntents.recordError(params.localSessionId, `activate: worker result unknown (${result.errorCode ?? result.status})`).catch(() => {});
      return { kind: "remote_unreachable", status: result.status, detail: result.data };
    }
    return this.handleActivationOutcome(body!, {
      localSessionId: params.localSessionId, remoteServerId, remoteSessionId, projectId, branch, remotePath,
      mapping, preRegistered, activityAt, instruction: params.instruction, userId: params.userId,
      agentType: intent?.agent_type ?? null, model: intent?.model ?? null,
    });
  }

  /** Shared tail of `start` and `activate`: publish on success, undo the pre-registration otherwise. */
  private async handleActivationOutcome(body: WorkerLifecycleBody, ctx: {
    localSessionId: string; remoteServerId: string; remoteSessionId: string; projectId: string; branch: string | null;
    remotePath: string; mapping: RemoteSessionMapping | undefined; preRegistered: boolean; activityAt: number;
    instruction: string | ContentPart[]; userId: string | undefined; agentType: string | null; model: string | null;
  }): Promise<RemoteActivationResult> {
    const view = body.lifecycle ? this.localize(body.lifecycle, ctx.localSessionId, ctx.projectId, ctx.remoteSessionId) : undefined;
    const undo = () => { if (ctx.preRegistered && !ctx.mapping) this.deps.remoteSessionMap.delete(ctx.localSessionId); };
    switch (body.kind) {
      case "activated":
      case "replayed":
      case "uncertain": {
        await this.publishActivated({
          localSessionId: ctx.localSessionId, projectId: ctx.projectId, remoteServerId: ctx.remoteServerId,
          remoteSessionId: ctx.remoteSessionId, branch: ctx.branch, remotePath: ctx.remotePath,
          mapping: ctx.mapping, view, activityAt: ctx.activityAt, firstDelivery: body.kind === "activated",
          instruction: ctx.instruction, userId: ctx.userId, agentType: ctx.agentType, model: ctx.model,
        });
        return { kind: body.kind, view: view! } as RemoteActivationResult;
      }
      case "in_progress":
        return { kind: "in_progress", view: view! };
      case "not_found":
        undo();
        return { kind: "not_found" };
      default: {
        undo();
        const kind = body.kind as Exclude<ActivationResult["kind"], "activated" | "replayed" | "uncertain" | "in_progress" | "not_found">;
        if (kind === "resident_limit") {
          return { kind, view: view!, error: Object.assign(new Error(body.error ?? "Resident agent process limit reached"), {
            errorCode: "resident_limit_reached", maxResidentAgentProcesses: body.maxResidentAgentProcesses ?? 0, runningSessions: body.runningSessions ?? [],
          }) as unknown as Extract<ActivationResult, { kind: "resident_limit" }>["error"] };
        }
        if (kind === "retryable_failure" || kind === "permanent_failure") {
          return { kind, view: view!, errorCode: body.errorCode ?? kind };
        }
        return { kind, view: view! } as RemoteActivationResult;
      }
    }
  }

  async cancel(params: { localSessionId: string; reason: ExpiredReason }): Promise<RemoteCancelResult> {
    const target = await this.resolve(params.localSessionId);
    if (!target) return { kind: "not_found" };
    if (!(await this.supports(target.remoteServerId))) return this.legacyCancel(params, target);

    const result = await proxyToRemoteAuto(
      target.remoteServerId, "DELETE", `/api/agent-sessions/${encodeURIComponent(target.remoteSessionId)}/preparation`,
      { reason: params.reason },
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    const body = parseWorkerBody(result.data);
    if (!result.ok && (isTransport(result.errorCode) || !body)) {
      return { kind: "remote_unreachable", status: result.status, detail: result.data };
    }
    const view = body!.lifecycle ? this.localize(body!.lifecycle, params.localSessionId, target.projectId, target.remoteSessionId) : undefined;
    if ((body!.kind === "cancelled" || body!.kind === "already_expired") && !target.mapping) {
      this.deps.remoteSessionMap.delete(params.localSessionId);
    }
    if (body!.kind === "not_found") return { kind: "not_found" };
    return { kind: body!.kind, view: view! } as RemoteCancelResult;
  }

  // -------------------------------------------------------------------------

  private async resolve(localSessionId: string): Promise<{
    remoteServerId: string; remoteSessionId: string; projectId: string; branch: string | null; remotePath: string;
    mapping: RemoteSessionMapping | undefined; intent: RemoteSessionCreationIntent | undefined;
  } | null> {
    const [intent, mapping] = await Promise.all([
      this.deps.storage.remoteSessionCreationIntents.getByLocal(localSessionId),
      this.deps.remoteSessionMappings.getByLocal(localSessionId),
    ]);
    if (!intent && !mapping) return null;
    const remoteServerId = mapping?.remote_server_id ?? intent!.remote_server_id;
    const projectId = mapping?.project_id ?? intent!.project_id;
    let remotePath = intent?.remote_path;
    if (!remotePath) {
      const association = await this.deps.storage.projectRemotes.getByProjectAndServer(projectId, remoteServerId);
      remotePath = association?.remote_path ?? "";
    }
    return {
      remoteServerId,
      remoteSessionId: mapping?.remote_session_id ?? intent!.remote_session_id,
      projectId,
      branch: (mapping?.branch ?? intent?.branch) ?? null,
      remotePath,
      mapping,
      intent,
    };
  }

  private localize(view: SessionLifecycleView, localSessionId: string, projectId: string, remoteSessionId: string): SessionLifecycleView {
    return { ...view, sessionId: localSessionId, projectId, remoteSessionId };
  }

  /** §9.2 step 5: the ordinary remote projection, published only for an activated (or uncertain) session. */
  private async publishActivated(opts: {
    localSessionId: string; projectId: string; remoteServerId: string; remoteSessionId: string; branch: string | null;
    remotePath: string; mapping: RemoteSessionMapping | undefined; view: SessionLifecycleView | undefined; activityAt: number;
    firstDelivery: boolean; instruction: string | ContentPart[]; userId: string | undefined;
    agentType: string | null; model: string | null;
  }): Promise<void> {
    const { deps } = this;
    let activityReady: boolean;
    if (!opts.mapping) {
      // from_start: this hub drove the activation, so sequence zero is the
      // right baseline and there is no unrelated history to suppress.
      await bindRemoteSessionMapping(deps.storage, {
        localSessionId: opts.localSessionId, projectId: opts.projectId, remoteServerId: opts.remoteServerId,
        remoteSessionId: opts.remoteSessionId, branch: opts.branch, remotePath: opts.remotePath,
        notificationSyncStart: "from_start", mappingRepo: deps.remoteSessionMappings,
      });
      await deps.storage.remoteSessionCreationIntents.confirm(opts.localSessionId);
      await deps.remoteSessionMappings
        .extendNotificationWatch(opts.localSessionId, this.now() + NOTIFICATION_WATCH_WINDOW_MS)
        .catch((err) => console.warn("[RemoteLifecycle] notification watch extend failed:", err));
      // One write carries creation AND the first turn: the session is born
      // running with its first user message, which is what the sidebar dot
      // and Cmd+K should see. (A separate activity update right after would
      // be rejected as stale — the cache stamps creation with its own clock.)
      activityReady = await deps.storage.searchCache.noteSessionCreated({
        localSessionId: opts.localSessionId, projectId: opts.projectId, targetId: opts.remoteServerId,
        branch: opts.branch, title: null, status: "running", agentType: opts.agentType, model: opts.model,
        lastUserMessageAt: opts.activityAt,
      }).then(() => true).catch((err) => {
        console.error("[RemoteLifecycle] search-cache create write-through failed:", err);
        return false;
      });
    } else {
      // Replay against an already-published session: only the activity moves.
      activityReady = (await deps.storage.searchCache.updateRemoteSessionActivity({
        localSessionId: opts.localSessionId, projectId: opts.projectId, targetId: opts.remoteServerId,
        remoteSessionId: opts.remoteSessionId, status: "running", activityAt: opts.activityAt, lastUserMessageAt: opts.activityAt,
      }).catch((err) => { console.error("[RemoteLifecycle] activity write-through failed:", err); return false; })) === true;
    }
    ensureRemoteAgentStream(opts.localSessionId, {
      remoteSessionMap: deps.remoteSessionMap, remotePatchCache: deps.remotePatchCache,
      reverseConnectManager: deps.reverseConnectManager, eventBus: deps.eventBus,
      agentSessionManager: deps.agentSessionManager, storage: deps.storage,
    });
    if (activityReady) {
      deps.agentSessionManager.emitBranchActivityIfChanged(
        opts.projectId, opts.branch, { activity: "working", since: opts.activityAt, sessionId: opts.localSessionId },
      );
    }
    if (opts.firstDelivery && opts.userId) {
      const remoteInfo = deps.remoteSessionMap.get(opts.localSessionId);
      if (remoteInfo) {
        void generateAndPushRemoteSessionTitle(
          { storage: deps.storage, agentSessionManager: deps.agentSessionManager, remotePatchCache: deps.remotePatchCache, reverseConnectManager: deps.reverseConnectManager },
          opts.localSessionId, extractUserText(opts.instruction), remoteInfo, opts.userId,
        ).catch((err) => console.error("[RemoteLifecycle] title generation failed:", err));
      }
    }
  }

  // ---- Legacy worker fallback (§9.2): `/new` → `/message` → `discard-if-empty` ----

  private legacyView(localSessionId: string, projectId: string, remoteSessionId: string, branch: string | null, state: SessionLifecycleView["state"], purpose: string): SessionLifecycleView {
    return {
      sessionId: localSessionId, projectId, branch, state, purpose, leaseHeld: false, activationKey: null,
      activationAttempt: 0, activatedAt: null, activationErrorCode: null, userEntryIndex: null,
      expiredReason: null, expiredAt: null, pendingExpiresAt: null, remoteSessionId, legacy: true,
    };
  }

  private async legacyPrepare(params: RemotePrepareParams, localSessionId: string, remoteSessionId: string, existing: RemoteSessionCreationIntent | undefined): Promise<RemotePrepareResult> {
    const mapped = await this.deps.remoteSessionMappings.getByLocal(localSessionId);
    if (!mapped) {
      const created = await createRemoteAgentSession(this.deps, {
        projectId: params.projectId, agentMode: params.remoteServerId, remoteConfig: { remote_path: params.remotePath },
        branch: params.branch, permissionMode: params.permissionMode, agentType: params.agentType, model: params.model,
        userId: params.userId, remoteSessionId, localSessionId, purpose: params.purpose, operationId: params.operationId,
      });
      if (!created.ok) {
        if (created.status === 0) return { kind: "remote_unreachable", status: created.status, detail: created.data };
        return { kind: "workspace_unavailable", detail: `legacy create failed: ${JSON.stringify(created.data)}` };
      }
    }
    await this.deps.storage.remoteSessionCreationIntents.markPrepared(localSessionId, this.now());
    return {
      kind: existing ? "replayed" : "prepared",
      view: this.legacyView(localSessionId, params.projectId, remoteSessionId, params.branch, "active", params.purpose),
    };
  }

  private async legacyActivate(params: RemoteActivateParams, target: NonNullable<Awaited<ReturnType<RemoteSessionLifecycleAdapter["resolve"]>>>): Promise<RemoteActivationResult> {
    const activityAt = this.now();
    const sent = await proxyToRemoteAuto(
      target.remoteServerId, "POST", `/api/agent-sessions/${encodeURIComponent(target.remoteSessionId)}/message`,
      { content: params.instruction, idempotencyKey: params.activationKey },
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    if (!sent.ok) {
      if (isTransport(sent.errorCode)) return { kind: "remote_unreachable", status: sent.status, detail: sent.data };
      const view = this.legacyView(params.localSessionId, target.projectId, target.remoteSessionId, target.branch, "active", "interactive");
      if (sent.status === 409) return { kind: "idempotency_conflict", view };
      // A definite rejection on a legacy worker: `/new` already spawned the
      // session, so this is exactly the create-then-send orphan the
      // compensation exists for. `discard-if-empty` is safe here (the worker
      // proved no user turn landed); a transport-unknown outcome above keeps
      // the identity for replay instead.
      const discarded = await this.legacyCancel({ localSessionId: params.localSessionId }, target);
      const errorCode = `legacy_message_${sent.status}`;
      return discarded.kind === "cancelled"
        ? { kind: "retryable_failure", view: { ...view, state: "expired" }, errorCode }
        : { kind: "retryable_failure", view, errorCode };
    }
    await this.deps.storage.searchCache.updateRemoteSessionActivity({
      localSessionId: params.localSessionId, projectId: target.projectId, targetId: target.remoteServerId,
      remoteSessionId: target.remoteSessionId, status: "running", activityAt, lastUserMessageAt: activityAt,
    }).catch(() => false);
    ensureRemoteAgentStream(params.localSessionId, {
      remoteSessionMap: this.deps.remoteSessionMap, remotePatchCache: this.deps.remotePatchCache,
      reverseConnectManager: this.deps.reverseConnectManager, eventBus: this.deps.eventBus,
      agentSessionManager: this.deps.agentSessionManager, storage: this.deps.storage,
    });
    const replayed = (sent.data as { replayed?: boolean } | null)?.replayed === true;
    return {
      kind: replayed ? "replayed" : "activated",
      view: this.legacyView(params.localSessionId, target.projectId, target.remoteSessionId, target.branch, "active", "interactive"),
    };
  }

  private async legacyCancel(params: { localSessionId: string }, target: NonNullable<Awaited<ReturnType<RemoteSessionLifecycleAdapter["resolve"]>>>): Promise<RemoteCancelResult> {
    const result = await proxyToRemoteAuto(
      target.remoteServerId, "POST", `/api/agent-sessions/${encodeURIComponent(target.remoteSessionId)}/discard-if-empty`,
      undefined,
      { reverseConnectManager: this.deps.reverseConnectManager ?? undefined },
    );
    if (!result.ok) {
      if (isTransport(result.errorCode)) return { kind: "remote_unreachable", status: result.status, detail: result.data };
      // Not empty (or a worker too old even for discard-if-empty): the legacy
      // session stays; report it as not pending, which is what it is.
      return { kind: "not_pending", view: this.legacyView(params.localSessionId, target.projectId, target.remoteSessionId, target.branch, "active", "interactive") };
    }
    await this.deps.remoteSessionMappings.delete(params.localSessionId).catch(() => false);
    await this.deps.storage.remoteSessionCreationIntents.discard(params.localSessionId).catch(() => {});
    this.deps.remoteSessionMap.delete(params.localSessionId);
    return { kind: "cancelled", view: this.legacyView(params.localSessionId, target.projectId, target.remoteSessionId, target.branch, "expired", "interactive") };
  }
}
