import { produce } from "immer";
import { toast } from "sonner";
import { getWebSocketUrl, getFreshToken, authFetch, api, type WorkflowRun } from "@/lib/api";
import { sendCommandToIframe, openPreviewFrame } from "@/components/preview/browser-frames-provider";

/**
 * Main Chat stream for ONE workspace (project + branch), framework-free.
 *
 * This is the "external store" half of the Main Chat hook (react.dev, "You
 * Might Not Need an Effect" → Subscribing to an external store): it owns the
 * chat session lookup, the WebSocket, reconnect/backoff, the silence watchdog
 * and tab-visibility recovery, and exposes one immutable snapshot that React
 * reads through `useSyncExternalStore`. The hook's only Effect is
 * start()/stop() on mount/unmount — there is no reset-on-prop-change Effect,
 * no auto-start Effect, no reconnect Effect chained off state.
 *
 * Identity is fixed for the object's lifetime: a different workspace is a
 * different ChatStream (the hook makes a new one, and the component is keyed
 * on the workspace so its own UI state resets as well).
 */

// ============ Types ============

export type AgentMessage =
  | { type: "user"; content: string; timestamp: number; event?: { kind: string; sessionId: string; turnEndEntryIndex: number } }
  | { type: "assistant"; content: string; partial?: boolean; timestamp: number }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: "tool_result"; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "system"; content: string; timestamp: number }
  | { type: "turn_end"; timestamp: number }
  | { type: "tool_approval_request"; tool: string; input: unknown; approvalId: string; resolved?: "approved" | "denied"; timestamp: number };

export type AgentSessionStatus = "running" | "stopped" | "error";

export interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
  eventListeningEnabled?: boolean;
}

export interface ChatStreamState {
  session: ChatSession | null;
  messages: AgentMessage[];
  status: AgentSessionStatus;
  isConnected: boolean;
  /** True once the server's replay has been applied (`Ready`). */
  isInitialized: boolean;
  /** True while the create-or-get session request is in flight. */
  isLoading: boolean;
  error: string | null;
  workflowRunUpdate: WorkflowRun | null;
  /** Bumped on every `Ready` — the reconciliation point for non-replayed pushes. */
  streamEpoch: number;
  /** Unsent composer text. Per workspace; survives switching away and back. */
  draft: string;
}

export const EMPTY_CHAT_STREAM_STATE: ChatStreamState = Object.freeze({
  session: null,
  messages: [],
  status: "stopped",
  isConnected: false,
  isInitialized: false,
  isLoading: false,
  error: null,
  workflowRunUpdate: null,
  streamEpoch: 0,
  draft: "",
}) as ChatStreamState;

// ============ JSON Patch (RFC 6902) ============

type PatchOperation = "add" | "replace" | "remove";

interface PatchEntry {
  op: PatchOperation;
  path: string;
  value?: PatchValue;
}

type Patch = PatchEntry[];

type PatchValue =
  | { type: "ENTRY"; content: AgentMessage }
  | { type: "STATUS"; content: AgentSessionStatus }
  | { type: "READY"; content: true }
  | { type: "FINISHED"; content: true };

interface BrowserCommand {
  id: string;
  action: string;
  selector?: string;
  value?: string;
  key?: string;
}

type AgentWsMessage =
  | { JsonPatch: Patch }
  | { Ready: true }
  | { finished: true }
  | { error: string }
  | { browserCommand: BrowserCommand }
  | { openPreviewFrame: { projectId: string; url: string } }
  | { WorkflowRunUpdated: WorkflowRun }
  // Liveness-only frame from the server heartbeat — carries no state, exists to
  // give the silence watchdog something to observe on an idle session.
  | { keepalive: number };

interface PatchContainer {
  entries: AgentMessage[];
  status: AgentSessionStatus;
}

function applyPatch(container: PatchContainer, patch: Patch): PatchContainer {
  return produce(container, (draft) => {
    for (const entry of patch) {
      const { op, path, value } = entry;

      // Handle special clearAll patch
      if (path === "/entries" && op === "replace") {
        if (value?.type === "ENTRY" && value.content?.type === "system" && value.content?.content === "__CLEAR_ALL__") {
          draft.entries = [];
          continue;
        }
      }

      if (path.startsWith("/entries/")) {
        const index = parseInt(path.replace("/entries/", ""), 10);
        if (isNaN(index) || value?.type !== "ENTRY") continue;

        switch (op) {
          case "add":
            while (draft.entries.length <= index) {
              draft.entries.push(null as unknown as AgentMessage);
            }
            draft.entries[index] = value.content;
            break;
          case "replace":
            if (index < draft.entries.length) draft.entries[index] = value.content;
            break;
          case "remove":
            if (index < draft.entries.length) draft.entries.splice(index, 1);
            break;
        }
      } else if (path === "/status" && value?.type === "STATUS") {
        draft.status = value.content;
      }
    }
  });
}

// ============ API ============

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

async function createOrGetChatSession(
  projectId: string,
  branch: string | null,
): Promise<{ session: ChatSession; messages: AgentMessage[] }> {
  const response = await authFetch(`${getApiBase()}/api/projects/${projectId}/chat-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch }),
  });
  if (!response.ok) throw new Error("Failed to create chat session");
  return response.json();
}

async function sendMessageToChat(sessionId: string, content: string): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error("Failed to send message");
}

async function stopGenerationApi(sessionId: string): Promise<void> {
  const response = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/stop`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to stop generation");
}

// ============ Module-level caches ============

export function chatWorkspaceKey(projectId: string, branch: string | null): string {
  return `chat:${projectId}:${branch ?? ""}`;
}

/** Session identity per workspace — avoids the create-or-get round trip on revisit. */
const sessionCache = new Map<string, ChatSession>();

interface ChatSnapshot {
  session: ChatSession;
  messages: AgentMessage[];
  status: AgentSessionStatus;
}

/**
 * Last flushed conversation per workspace. A ChatStream is BORN with this as
 * its state, so switching back to a workspace paints the previous transcript
 * on the first render instead of a spinner; the server replay then overwrites
 * it. Bounded LRU; entries are references to already-immutable arrays.
 */
const snapshotCache = new Map<string, ChatSnapshot>();
const MAX_SNAPSHOTS = 20;

function writeSnapshot(key: string, snapshot: ChatSnapshot): void {
  snapshotCache.delete(key);
  snapshotCache.set(key, snapshot);
  while (snapshotCache.size > MAX_SNAPSHOTS) {
    const oldest = snapshotCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
}

/**
 * Unsent composer text per workspace. The component is keyed on the workspace
 * (so its own state resets on switch); the draft lives here so it is not lost.
 * Never evicted — a draft is the one thing the user typed and did not send.
 */
const draftCache = new Map<string, string>();

/** Test seam: forget everything cached for every workspace. */
export function clearChatStreamCaches(): void {
  sessionCache.clear();
  snapshotCache.clear();
  draftCache.clear();
}

// ============ Constants ============

const MIN_STABLE_CONNECTION_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_SHORT_LIVED_CONNECTIONS = 3;

// Zombie-socket watchdog, mirroring use-agent-session. When the device sleeps
// or the network switches, the TCP connection dies with no close handshake:
// readyState stays OPEN, `onclose` never fires, and nothing schedules a
// reconnect — every frame the server broadcasts from then on is lost. That is
// exactly what happened on 2026-08-18 (docs/troubleshooting/
// review-panel-missing-in-main-chat.md): this socket stayed dead for 641s,
// swallowing both of a review run's WorkflowRunUpdated pushes, while the agent
// stream recovered in 38s because it had this timer. `visibilitychange` alone
// is not a substitute — it only fires when the tab comes back to the front.
// The server sends `keepalive` every 30s, so three missed intervals means gone.
const SILENCE_TIMEOUT_MS = 95000;

function getReconnectDelay(attempt: number): number {
  const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, attempt));
  return baseDelay + baseDelay * Math.random() * 0.25;
}

// ============ ChatStream ============

export class ChatStream {
  readonly key: string;

  private state: ChatStreamState;
  private readonly listeners = new Set<() => void>();

  /** Between start() and stop(). Everything asynchronous re-checks this. */
  private active = false;
  /** Bumped by stop(); an in-flight start() that resumes under a stale epoch drops out. */
  private epoch = 0;

  private ws: WebSocket | null = null;
  private container: PatchContainer = { entries: [], status: "stopped" };
  private replaying = false;
  private finished = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shortLivedConnections = 0;
  private connectionStartedAt: number | null = null;
  private lastStartFailed = false;
  /**
   * Count of local session-metadata writes. A background metadata read that
   * started before a write completed is stale by construction (it may have
   * been served before the write) and must not be adopted over it.
   */
  private metadataWrites = 0;

  constructor(readonly projectId: string, readonly branch: string | null) {
    this.key = chatWorkspaceKey(projectId, branch);
    const warm = snapshotCache.get(this.key);
    const draft = draftCache.get(this.key) ?? "";
    // The session row is known from the first paint too (header controls and
    // the listening flag need it), whether or not a transcript was snapshotted.
    const session = warm?.session ?? sessionCache.get(this.key) ?? null;
    this.state = warm
      ? { ...EMPTY_CHAT_STREAM_STATE, session, messages: warm.messages, status: warm.status, draft }
      : { ...EMPTY_CHAT_STREAM_STATE, session, draft };
  }

  // ---- external-store surface (stable identities for useSyncExternalStore) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ChatStreamState => this.state;

  private set(patch: Partial<ChatStreamState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ---- lifecycle ----

  start(): void {
    if (this.active) return;
    this.active = true;
    this.finished = false;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    void this.startSession();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch += 1;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    // Detach before close so this socket's late onclose is ignored (it would
    // otherwise schedule a reconnect into a workspace nobody is looking at).
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, "branch-switch"); } catch { /* already gone */ }
    }
    this.clearTimers();
    this.connectionStartedAt = null;
    if (this.state.isConnected) this.set({ isConnected: false });
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    this.clearSilenceTimer();
  }

  // ---- session ----

  private async startSession(): Promise<void> {
    if (!this.active) return;
    const epoch = this.epoch;
    this.lastStartFailed = false;
    this.set({ error: null, isInitialized: false });

    const cached = sessionCache.get(this.key);
    if (cached) {
      // Status is left alone: a warm snapshot's is fresher than the cached
      // session row's, and the replay's status patch settles it either way.
      this.set({ session: cached });
      this.connect();
      // The socket replays entries and status but NOT session metadata
      // (`eventListeningEnabled` can be flipped server-side by the runExecutor
      // tool, or from another tab). Re-read it without blocking the connect;
      // create-or-get is idempotent and an in-memory lookup on the hub.
      void this.refreshSessionMetadata(epoch);
      return;
    }

    this.set({ isLoading: true });
    try {
      const { session, messages } = await createOrGetChatSession(this.projectId, this.branch);
      if (epoch !== this.epoch) return;
      sessionCache.set(this.key, session);
      this.set({
        session,
        status: session.status,
        ...(messages && messages.length > 0 ? { messages } : {}),
      });
      this.connect();
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.lastStartFailed = true;
      this.set({ error: e instanceof Error ? e.message : "Failed to start session" });
    } finally {
      if (epoch === this.epoch) this.set({ isLoading: false });
    }
  }

  private async refreshSessionMetadata(epoch: number): Promise<void> {
    const writes = this.metadataWrites;
    try {
      const { session } = await createOrGetChatSession(this.projectId, this.branch);
      if (epoch !== this.epoch) return;
      // The user changed metadata while this read was in flight: the read is
      // older than what the server now holds. Drop it.
      if (writes !== this.metadataWrites) return;
      // Same session: adopt its current metadata. A different id means the
      // hub restarted; the short-lived-connection path already handles that.
      if (session.id === this.state.session?.id) this.adoptSession(session);
    } catch {
      // Metadata refresh is best-effort; the cached row stays in effect.
    }
  }

  /** Make `session` the current row everywhere it is remembered. */
  private adoptSession(session: ChatSession): void {
    sessionCache.set(this.key, session);
    const snap = snapshotCache.get(this.key);
    if (snap && snap.session.id === session.id) writeSnapshot(this.key, { ...snap, session });
    this.set({ session });
  }

  // ---- socket ----

  /**
   * Token-refreshing entry point. Every (re)connect first fetches a
   * guaranteed-valid token (cache-hit = no network) so the WS upgrade never
   * carries an expired JWT. `forceRefresh` forces a network mint — used when
   * reconnecting after the server closed the socket, which may be an
   * expired/rejected token.
   */
  private connect(forceRefresh = false): void {
    if (!this.active) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const epoch = this.epoch;
    void getFreshToken(forceRefresh ? { skipCache: true } : undefined).then(() => {
      if (epoch !== this.epoch || !this.active) return;
      this.openSocket();
    });
  }

  private openSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const sessionId = this.state.session?.id;
    if (!sessionId) return;

    this.container = { entries: [], status: "stopped" };
    this.finished = false;
    this.replaying = true;

    const ws = new WebSocket(getWebSocketUrl(`/api/chat-sessions/${sessionId}/stream`));
    this.ws = ws;
    // Socket identity, not a generation counter: the silence watchdog retires
    // a socket and opens its replacement without waiting for the old one's
    // close handshake, so two sockets can overlap. Without this guard the
    // retired socket's late `close` would null out the replacement and clear
    // its silence timer, and its late frames would land in the live transcript.
    const isCurrent = () => this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.set({ isConnected: true, error: null });
      this.connectionStartedAt = Date.now();
      this.armSilenceTimer(ws);
      if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
      this.stabilityTimer = setTimeout(() => {
        this.reconnectAttempt = 0;
        this.shortLivedConnections = 0;
      }, MIN_STABLE_CONNECTION_MS);
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      // Any frame proves the socket is alive, whatever it turns out to be.
      this.armSilenceTimer(ws);
      try {
        this.handleFrame(ws, JSON.parse(event.data) as AgentWsMessage);
      } catch (e) {
        console.error("[ChatSession] Failed to parse message:", e);
      }
    };

    ws.onclose = (event) => {
      if (!isCurrent()) return;
      this.ws = null;
      this.set({ isConnected: false });
      this.clearSilenceTimer();
      if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }

      // Visibility-recovery close — skip short-lived detection, go straight to reconnect
      const isVisibilityRecovery = event.code === 4000;
      const connectionDuration = this.connectionStartedAt ? Date.now() - this.connectionStartedAt : 0;
      this.connectionStartedAt = null;

      if (!isVisibilityRecovery && connectionDuration > 0 && connectionDuration < MIN_STABLE_CONNECTION_MS) {
        this.shortLivedConnections++;
        if (this.shortLivedConnections >= MAX_SHORT_LIVED_CONNECTIONS) {
          if (this.lastStartFailed) {
            this.set({ error: "Unable to connect to remote server. Please check the server configuration." });
            return;
          }
          // The session id we hold keeps producing sockets the server drops:
          // forget it and create-or-get afresh.
          sessionCache.delete(this.key);
          this.reconnectAttempt = 0;
          this.shortLivedConnections = 0;
          this.set({ session: null, error: null });
          void this.startSession();
          return;
        }
      } else if (connectionDuration >= MIN_STABLE_CONNECTION_MS) {
        this.shortLivedConnections = 0;
      }

      if (this.finished || event.code === 1000) return;

      if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        this.set({ error: "Unable to connect to server." });
        return;
      }

      const delay = getReconnectDelay(this.reconnectAttempt);
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        // Server-initiated close — mint a fresh token so a reconnect storm after
        // a server restart never re-sends the expired JWT that triggered it.
        if (this.state.session?.id && !this.finished) this.connect(true);
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire next
    };
  }

  private handleFrame(ws: WebSocket, msg: AgentWsMessage): void {
    // Liveness-only frame — already accounted for by the watchdog re-arm.
    if ("keepalive" in msg) return;

    if ("JsonPatch" in msg) {
      this.container = applyPatch(this.container, msg.JsonPatch);
      // During replay the server streams history; state is flushed once on
      // Ready instead of re-rendering per frame.
      if (!this.replaying) this.flush();
      return;
    }

    if ("Ready" in msg) {
      this.replaying = false;
      this.flush();
      // The stream is caught up on everything that replays. Signal the
      // reconciliation point for the state that does NOT replay — pushes like
      // WorkflowRunUpdated are fire-and-forget, so whatever consumes them has
      // to re-read on every (re)connect or stay stale forever.
      this.set({ isInitialized: true, streamEpoch: this.state.streamEpoch + 1 });
      return;
    }

    if ("finished" in msg) {
      this.finished = true;
      ws.close(1000, "finished");
      return;
    }

    if ("openPreviewFrame" in msg) {
      openPreviewFrame(msg.openPreviewFrame.projectId, msg.openPreviewFrame.url);
      return;
    }

    if ("WorkflowRunUpdated" in msg) {
      this.set({ workflowRunUpdate: msg.WorkflowRunUpdated });
      return;
    }

    if ("browserCommand" in msg) {
      // Forward command to iframe, send result back via WS
      const cmd = msg.browserCommand;
      void sendCommandToIframe(this.projectId, { type: "vibedeckx-command", ...cmd }).then((result) => {
        if (result && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "browser_result",
            result: {
              id: cmd.id,
              success: result.success ?? false,
              error: result.error,
              content: result.content,
              found: result.found,
              tag: result.tag,
              text: result.text,
            },
          }));
        }
      });
      return;
    }

    if ("error" in msg) {
      this.set({ error: msg.error });
      if (msg.error === "Session not found") {
        sessionCache.delete(this.key);
        snapshotCache.delete(this.key);
        this.finished = true;
      }
    }
  }

  /** Publish the container and remember it for the next visit to this workspace. */
  private flush(): void {
    const messages = this.container.entries.filter(Boolean);
    const status = this.container.status;
    this.set({ messages, status });
    if (this.state.session) writeSnapshot(this.key, { session: this.state.session, messages, status });
  }

  // ---- watchdogs ----

  private clearSilenceTimer(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  /** Restart the silence countdown for `ws`; called on every inbound frame. */
  private armSilenceTimer(ws: WebSocket): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (ws.readyState !== WebSocket.OPEN) return;
      console.warn(`[ChatSession] No frames for ${SILENCE_TIMEOUT_MS}ms — assuming dead socket, forcing reconnect`);
      this.replaceSilentSocket(ws);
    }, SILENCE_TIMEOUT_MS);
  }

  /**
   * A silence timeout proves the old socket can no longer be trusted. Detach
   * it before close() — connect() bails out while an OPEN socket is held —
   * then reconnect immediately rather than waiting for a close handshake a
   * half-open connection may never complete.
   */
  private replaceSilentSocket(silentSocket: WebSocket): void {
    if (this.ws !== silentSocket) return;
    this.ws = null;
    this.set({ isConnected: false });
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    this.connectionStartedAt = null;
    // Code 4000 keeps this out of the short-lived-connection detector if the
    // close event does eventually arrive; the identity guard makes that
    // handler harmless for the replacement socket either way.
    try { silentSocket.close(4000, "silence watchdog"); } catch { /* already gone */ }
    if (!this.finished) this.connect(true);
  }

  /**
   * Browsers may silently drop WebSocket connections for backgrounded tabs,
   * causing messages to be missed. On tab return, force a reconnect so
   * historical patches (including executor events) are replayed.
   */
  private onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") return;
    if (!this.state.session?.id || this.finished) return;
    const ws = this.ws;
    // Already closed — the onclose reconnect logic will handle it.
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.close(4000, "visibility-recovery");
  };

  // ---- actions (stable identities; safe to hand to event handlers) ----

  setDraft = (draft: string): void => {
    if (draft === this.state.draft) return;
    draftCache.set(this.key, draft);
    this.set({ draft });
  };

  /**
   * Toggle executor-event listening. `session.eventListeningEnabled` is the
   * single source of truth for the button; the server does not push this flag,
   * so the store (and its caches) are updated here on success. Throws on
   * failure so the caller can surface it.
   */
  setEventListening = async (enabled: boolean): Promise<void> => {
    const session = this.state.session;
    if (!session) return;
    await api.setChatEventListening(session.id, enabled);
    this.metadataWrites += 1;
    if (this.state.session?.id !== session.id) return;
    this.adoptSession({ ...session, eventListeningEnabled: enabled });
  };

  sendMessage = async (content: string): Promise<void> => {
    const sessionId = this.state.session?.id;
    const trimmed = content.trim();
    if (!sessionId || !trimmed) return;
    try {
      await sendMessageToChat(sessionId, trimmed);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to send message";
      this.set({ error: errorMsg });
      toast.error("Failed to send message", { description: errorMsg });
    }
  };

  stopGeneration = async (): Promise<void> => {
    const sessionId = this.state.session?.id;
    if (!sessionId) return;
    try {
      await stopGenerationApi(sessionId);
    } catch (e) {
      console.error("[ChatSession] Failed to stop generation:", e);
    }
  };

  restartSession = async (): Promise<void> => {
    const sessionId = this.state.session?.id;
    if (!sessionId) return;
    try {
      await api.resetChatSession(sessionId);
      // The backend broadcasts a clearAll patch via WS which resets messages.
      // Also clear local state immediately for responsiveness.
      this.container = { entries: [], status: "stopped" };
      this.flush();
    } catch (e) {
      console.error("[ChatSession] Failed to reset session:", e);
      toast.error("Failed to start new conversation");
    }
  };
}
