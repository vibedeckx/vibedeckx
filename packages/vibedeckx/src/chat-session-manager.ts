/**
 * ChatSessionManager — lightweight AI chat session manager using Vercel AI SDK.
 *
 * No child processes, no tool tracking, no permission modes.
 * Streams responses from DeepSeek via `streamText` and broadcasts
 * JSON Patches over WebSocket (same architecture as AgentSessionManager).
 */

import { randomUUID } from "crypto";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { resolveChatModel } from "./utils/chat-model.js";
import WsWebSocket from "ws";
import type WebSocket from "ws";
import type { AgentMessage, AgentSessionStatus } from "./agent-types.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { Patch, AgentWsMessage, BrowserCommand, BrowserCommandResult } from "./conversation-patch.js";
import type { Storage } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import { proxyToRemote, proxyToRemoteAuto } from "./utils/remote-proxy.js";
import type { RemoteExecutorInfo, RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import type { BrowserManager, BrowserError } from "./browser-manager.js";


// ============ Types ============

interface ChatStore {
  patches: Patch[];
  entries: AgentMessage[];
  nextIndex: number;
}

interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  userId: string;
  store: ChatStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  abortController: AbortController | null;
  eventListeningEnabled: boolean;
}

// ============ Helpers ============

function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, "");
}

function extractLogText(logs: LogMessage[], tailLines: number): string {
  const textLogs = logs
    .filter((l): l is Exclude<LogMessage, { type: "finished" }> => l.type !== "finished")
    .map((l) => l.data);
  const joined = textLogs.join("");
  const lines = joined.split("\n");
  return stripAnsi(lines.slice(-tailLines).join("\n"));
}

// ============ Manager ============

export class ChatSessionManager {
  /** sessionId → ChatSession */
  private sessions = new Map<string, ChatSession>();

  /** projectId:branch → sessionId (one session per project+branch) */
  private sessionIndex = new Map<string, string>();

  /** terminalId → watcher state for active terminal output watchers */
  private terminalWatchers = new Map<string, {
    unsubscribe: () => void;
    state: {
      debounceTimer: ReturnType<typeof setTimeout> | null;
      idleTimer: ReturnType<typeof setTimeout>;
      outputBuffer: string;
    };
    sessionId: string;
  }>();

  /** processId → cleanup function for remote executor monitors */
  private remoteExecutorMonitors = new Map<string, () => void>();

  /** sessionId → queued messages waiting to be sent after current stream finishes */
  private messageQueue = new Map<string, string[]>();

  private storage: Storage;
  private eventBus: EventBus | null = null;
  private processManager: ProcessManager;
  private agentSessionManager: AgentSessionManager;
  private remoteSessionMap: Map<string, RemoteSessionInfo>;
  private remoteExecutorMap: Map<string, RemoteExecutorInfo>;
  private remotePatchCache: RemotePatchCache;
  private reverseConnectManager: ReverseConnectManager | null = null;
  private browserManager: BrowserManager | null = null;

  /** Pending browser commands waiting for iframe response: commandId → resolve */
  private pendingBrowserCommands = new Map<string, {
    resolve: (result: BrowserCommandResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    storage: Storage,
    processManager: ProcessManager,
    agentSessionManager: AgentSessionManager,
    remoteSessionMap: Map<string, RemoteSessionInfo>,
    remoteExecutorMap: Map<string, RemoteExecutorInfo>,
    remotePatchCache: RemotePatchCache,
    reverseConnectManager?: ReverseConnectManager,
    browserManager?: BrowserManager,
  ) {
    this.storage = storage;
    this.processManager = processManager;
    this.agentSessionManager = agentSessionManager;
    this.remoteSessionMap = remoteSessionMap;
    this.remoteExecutorMap = remoteExecutorMap;
    this.remotePatchCache = remotePatchCache;
    this.reverseConnectManager = reverseConnectManager ?? null;
    this.browserManager = browserManager ?? null;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    this.setupEventListeners();
  }

  setEventListening(sessionId: string, enabled: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.eventListeningEnabled = enabled;
    return true;
  }

  getEventListening(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.eventListeningEnabled ?? false;
  }

  private setupEventListeners(): void {
    if (!this.eventBus) return;
    this.eventBus.subscribe((event: GlobalEvent) => {
      if (event.type === "executor:stopped") {
        this.handleExecutorFinished(event);
      } else if (event.type === "session:taskCompleted") {
        console.log(`[ChatSession] EventBus received session:taskCompleted for project=${event.projectId} branch=${event.branch}`);
        this.handleSessionTaskCompleted(event);
      }
    });
  }

  private handleSessionTaskCompleted(event: Extract<GlobalEvent, { type: "session:taskCompleted" }>): void {
    try {
      // Find a chat session for this project+branch that has event listening enabled
      const key = `${event.projectId}:${event.branch ?? ""}`;
      console.log(`[ChatSession] handleSessionTaskCompleted: key=${key}, sessionIndex keys=[${[...this.sessionIndex.keys()].join(", ")}]`);
      const sessionId = this.sessionIndex.get(key);
      if (!sessionId) {
        console.log(`[ChatSession] handleSessionTaskCompleted: no chat session found for key=${key}`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        console.log(`[ChatSession] handleSessionTaskCompleted: session object not found for id=${sessionId}`);
        return;
      }
      if (!session.eventListeningEnabled) {
        console.log(`[ChatSession] handleSessionTaskCompleted: eventListening disabled for session ${sessionId}`);
        return;
      }

      // Format stats
      const stats: string[] = [];
      if (event.duration_ms !== undefined) {
        const seconds = (event.duration_ms / 1000).toFixed(1);
        stats.push(`Duration: ${seconds}s`);
      }
      if (event.cost_usd !== undefined) {
        stats.push(`Cost: $${event.cost_usd.toFixed(4)}`);
      }
      if (event.input_tokens !== undefined) {
        stats.push(`Input tokens: ${event.input_tokens.toLocaleString()}`);
      }
      if (event.output_tokens !== undefined) {
        stats.push(`Output tokens: ${event.output_tokens.toLocaleString()}`);
      }

      const message = [
        `[Agent Event: Task Completed]`,
        `Branch: ${event.branch ?? "main"}`,
        stats.length > 0 ? stats.join(" | ") : "",
        ``,
        `Summarize in 1-2 sentences what the coding agent accomplished.`,
      ].filter(Boolean).join("\n");

      // Send as a user message into the main chat — triggers AI response
      this.enqueueOrSend(sessionId, message);
    } catch (error) {
      console.error(`[ChatSession] handleSessionTaskCompleted error:`, error);
    }
  }

  private handleExecutorFinished(event: Extract<GlobalEvent, { type: "executor:stopped" }>): void {
    try {
      console.log(`[ChatSession] handleExecutorFinished: executorId=${event.executorId}, projectId=${event.projectId}, exitCode=${event.exitCode}`);

      // Look up executor metadata
      const executor = this.storage.executors.getById(event.executorId);
      if (!executor) { console.log(`[ChatSession] handleExecutorFinished: executor not found`); return; }

      // Look up group to get branch
      const group = this.storage.executorGroups.getById(executor.group_id);
      if (!group) { console.log(`[ChatSession] handleExecutorFinished: group not found for executor.group_id=${executor.group_id}`); return; }

      const branch = group.branch || null;

      // Find a chat session for this project+branch that has event listening enabled
      const key = `${event.projectId}:${branch ?? ""}`;
      const sessionId = this.sessionIndex.get(key);
      if (!sessionId) {
        console.log(`[ChatSession] handleExecutorFinished: no session for key="${key}", sessionIndex keys=[${[...this.sessionIndex.keys()].join(", ")}]`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) { console.log(`[ChatSession] handleExecutorFinished: session object not found for id=${sessionId}`); return; }
      if (!session.eventListeningEnabled) { console.log(`[ChatSession] handleExecutorFinished: eventListening disabled for session ${sessionId}`); return; }

      console.log(`[ChatSession] handleExecutorFinished: processing event, session=${sessionId}, subscribers=${session.subscribers.size}`);

      // Use tail output included in the event (snapshotted by process-manager at emit time)
      const tailOutput = event.tailOutput ?? "";

      const exitStatus = event.exitCode === 0 ? "success" : "failed";
      const message = [
        `[Executor Event: Process Finished]`,
        `Executor: "${executor.name}"`,
        `Command: ${executor.command}`,
        `Exit Code: ${event.exitCode} (${exitStatus})`,
        ``,
        `Last output:`,
        `---`,
        tailOutput || "(no output captured)",
        `---`,
        ``,
        `Check your Workspace Rules for any rules that apply to this event, then respond.`,
      ].join("\n");

      // Send as a user message into the main chat — triggers DeepSeek AI response
      this.enqueueOrSend(sessionId, message);
    } catch (error) {
      console.error(`[ChatSession] handleExecutorFinished error:`, error);
    }
  }

  private handleBrowserError(sessionId: string, error: BrowserError): void {
    const typeLabels: Record<string, string> = {
      js_error: "JS Error",
      console_error: "Console Error",
      network_error: "Network Error",
      crash: "Browser Crash",
    };

    const label = typeLabels[error.type] ?? error.type;
    const parts = [
      `[Browser Event: ${label}]`,
      error.url ? `URL: ${error.url}` : null,
      `Error: ${error.message}`,
      error.stack ? `Stack: ${error.stack}` : null,
      ``,
      `Summarize in 1-2 sentences.`,
    ].filter(Boolean);

    this.enqueueOrSend(sessionId, parts.join("\n"));
  }

  private findRemoteSessionForProject(projectId: string, branch?: string | null): { localSessionId: string; info: RemoteSessionInfo } | null {
    // Session IDs use format: remote-{serverId}-{projectId}-{remoteSessionId}
    // Match any session that contains the projectId segment
    const projectSegment = `-${projectId}-`;
    let fallback: { localSessionId: string; info: RemoteSessionInfo } | null = null;

    for (const [key, info] of this.remoteSessionMap) {
      if (key.startsWith("remote-") && key.includes(projectSegment)) {
        // Exact branch match
        if (info.branch === (branch ?? null)) {
          return { localSessionId: key, info };
        }
        // Keep first match as fallback in case no branch match
        if (!fallback) {
          fallback = { localSessionId: key, info };
        }
      }
    }

    if (fallback) {
      console.log(`[ChatSession] findRemoteSessionForProject: no exact branch match for branch=${branch ?? "null"}, using fallback session=${fallback.localSessionId} (branch=${fallback.info.branch ?? "null"})`);
    }
    return fallback;
  }

  /**
   * Extract AgentMessage[] from the local remotePatchCache for a given session.
   * Parses cached WS messages and collects ENTRY patch values into an ordered array.
   */
  private extractMessagesFromCache(sessionId: string): AgentMessage[] {
    const cacheEntry = this.remotePatchCache.get(sessionId);
    console.log(`[ChatSession] extractMessagesFromCache: sessionId=${sessionId}, cacheExists=${!!cacheEntry}, cachedMsgCount=${cacheEntry?.messages.length ?? 0}, patchCount=${cacheEntry?.patchCount ?? 0}, finished=${cacheEntry?.finished ?? "N/A"}, remoteWsState=${cacheEntry?.remoteWs?.readyState ?? "null"}, subscribers=${cacheEntry?.subscribers.size ?? 0}`);
    if (!cacheEntry || cacheEntry.messages.length === 0) return [];

    const result: AgentMessage[] = [];
    // Track patch types for diagnostics
    let entryCount = 0;
    let statusCount = 0;
    let readyCount = 0;
    let finishedCount = 0;
    let otherCount = 0;
    let nonJsonPatchCount = 0;
    let parseErrorCount = 0;

    for (const raw of cacheEntry.messages) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.JsonPatch || !Array.isArray(parsed.JsonPatch)) {
          nonJsonPatchCount++;
          continue;
        }

        for (const op of parsed.JsonPatch) {
          if ((op.op === "add" || op.op === "replace") && op.value?.type === "ENTRY" && op.value.content) {
            const match = op.path?.match(/^\/entries\/(\d+)$/);
            if (match) {
              const index = parseInt(match[1], 10);
              result[index] = op.value.content as AgentMessage;
              entryCount++;
            }
          } else if (op.path === "/status") {
            statusCount++;
          } else if (op.value?.type === "READY") {
            readyCount++;
          } else if (op.value?.type === "FINISHED") {
            finishedCount++;
          } else {
            otherCount++;
          }
        }
      } catch {
        parseErrorCount++;
      }
    }

    const filtered = result.filter(Boolean);
    console.log(`[ChatSession] extractMessagesFromCache: extracted ${filtered.length} messages from ${cacheEntry.messages.length} cached raw messages. Patch breakdown: entry=${entryCount}, status=${statusCount}, ready=${readyCount}, finished=${finishedCount}, other=${otherCount}, nonJsonPatch=${nonJsonPatchCount}, parseErrors=${parseErrorCount}`);
    return filtered;
  }

  private summarizeMessages(messages: AgentMessage[]) {
    return messages.map((msg) => {
      switch (msg.type) {
        case "user":
          return { type: "user", content: msg.content };
        case "assistant":
          return { type: "assistant", content: msg.content };
        case "tool_use": {
          const inputStr = typeof msg.input === "string"
            ? msg.input
            : JSON.stringify(msg.input);
          return {
            type: "tool_use",
            tool: msg.tool,
            input: inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr,
          };
        }
        case "tool_result":
          return {
            type: "tool_result",
            tool: msg.tool,
            output: msg.output.length > 500 ? msg.output.substring(0, 500) + "..." : msg.output,
          };
        case "error":
          return { type: "error", message: msg.message };
        case "system":
          return { type: "system", content: msg.content };
        case "thinking":
          return { type: "thinking", content: msg.content };
        default:
          return { type: (msg as AgentMessage).type };
      }
    });
  }

  // ---- Terminal watcher ----

  private startTerminalWatcher(sessionId: string, terminalId: string): void {
    // Clean up any existing watcher for this terminal
    this.stopTerminalWatcher(terminalId);

    const DEBOUNCE_MS = 3000;
    const IDLE_TIMEOUT_MS = 60000;
    const MAX_LINES = 100;
    const MAX_BYTES = 8192;

    // Mutable state shared between subscriber callback and flush — kept as a single
    // object so the terminalWatchers map always has a live reference to current timers.
    const state = {
      debounceTimer: null as ReturnType<typeof setTimeout> | null,
      idleTimer: setTimeout(() => this.stopTerminalWatcher(terminalId), IDLE_TIMEOUT_MS),
      outputBuffer: "",
    };

    const flush = () => {
      if (!state.outputBuffer.trim()) {
        console.log(`[ChatSession] terminal watcher flush: empty buffer, skipping (terminal=${terminalId})`);
        return;
      }

      console.log(`[ChatSession] terminal watcher flush: ${state.outputBuffer.length} bytes (terminal=${terminalId})`);

      // Strip ANSI codes
      let output = state.outputBuffer.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
        "",
      );

      // Cap at MAX_LINES / MAX_BYTES
      const lines = output.split("\n");
      if (lines.length > MAX_LINES) {
        output = lines.slice(-MAX_LINES).join("\n");
      }
      if (output.length > MAX_BYTES) {
        output = output.slice(-MAX_BYTES);
      }

      const message = [
        `[Terminal Event: Output]`,
        `Terminal: ${terminalId}`,
        ``,
        `Output:`,
        `---`,
        output,
        `---`,
        ``,
        `Summarize what happened in 1-2 sentences.`,
      ].join("\n");

      // Clean up watcher before sending (prevents duplicate flushes)
      this.stopTerminalWatcher(terminalId);

      // Inject into chat session (queued if a stream is already active)
      this.enqueueOrSend(sessionId, message);
    };

    const unsubscribe = this.processManager.subscribe(terminalId, (msg) => {
      console.log(`[ChatSession] watcher subscriber fired: terminal=${terminalId} type=${msg.type} bufferLen=${state.outputBuffer.length}`);

      if (msg.type === "finished") {
        // Terminal exited — flush what we have
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
        flush();
        return;
      }

      if (msg.type === "pty" || msg.type === "stdout" || msg.type === "stderr") {
        state.outputBuffer += msg.data;

        // Reset debounce timer
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(() => {
          console.log(`[ChatSession] debounce timer fired for terminal=${terminalId}, bufferLen=${state.outputBuffer.length}`);
          flush();
        }, DEBOUNCE_MS);

        // Reset idle timer
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => this.stopTerminalWatcher(terminalId), IDLE_TIMEOUT_MS);
      }
    });

    if (!unsubscribe) {
      console.log(`[ChatSession] Cannot watch terminal ${terminalId} — not found in processManager`);
      clearTimeout(state.idleTimer);
      return;
    }

    this.terminalWatchers.set(terminalId, {
      unsubscribe,
      state, // live reference — timer IDs stay current
      sessionId,
    });

    console.log(`[ChatSession] Started terminal watcher for terminal=${terminalId} session=${sessionId}`);
  }

  private stopTerminalWatcher(terminalId: string): void {
    const watcher = this.terminalWatchers.get(terminalId);
    if (!watcher) return;

    watcher.unsubscribe();
    if (watcher.state.debounceTimer) clearTimeout(watcher.state.debounceTimer);
    clearTimeout(watcher.state.idleTimer);
    this.terminalWatchers.delete(terminalId);
    console.log(`[ChatSession] Stopped terminal watcher for terminal=${terminalId}`);
  }

  /**
   * Start a watcher for a remote terminal by opening a virtual channel over
   * the existing reverse-connect WebSocket (or a direct WebSocket as fallback).
   * Mirrors the local startTerminalWatcher() — accumulates output with
   * debounce, flushes on "finished" or idle timeout, and feeds the result
   * into enqueueOrSend().
   */
  private startRemoteTerminalWatcher(
    sessionId: string,
    terminalId: string,
    remoteInfo: RemoteExecutorInfo,
  ): void {
    // Clean up any existing watcher for this terminal
    this.stopTerminalWatcher(terminalId);

    const DEBOUNCE_MS = 3000;
    const IDLE_TIMEOUT_MS = 60000;
    const MAX_LINES = 100;
    const MAX_BYTES = 8192;

    const state = {
      debounceTimer: null as ReturnType<typeof setTimeout> | null,
      idleTimer: setTimeout(() => this.stopTerminalWatcher(terminalId), IDLE_TIMEOUT_MS),
      outputBuffer: "",
    };

    const flush = () => {
      const buffered = state.outputBuffer;
      state.outputBuffer = ""; // Clear immediately to prevent double-flush

      if (!buffered.trim()) {
        console.log(`[ChatSession] remote terminal watcher flush: empty buffer, skipping (terminal=${terminalId})`);
        return;
      }

      console.log(`[ChatSession] remote terminal watcher flush: ${buffered.length} bytes (terminal=${terminalId})`);

      // Strip ANSI codes
      let output = buffered.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
        "",
      );

      const lines = output.split("\n");
      if (lines.length > MAX_LINES) {
        output = lines.slice(-MAX_LINES).join("\n");
      }
      if (output.length > MAX_BYTES) {
        output = output.slice(-MAX_BYTES);
      }

      const message = [
        `[Terminal Event: Output]`,
        `Terminal: ${terminalId}`,
        ``,
        `Output:`,
        `---`,
        output,
        `---`,
        ``,
        `Summarize what happened in 1-2 sentences.`,
      ].join("\n");

      // Clean up watcher before sending (prevents duplicate flushes)
      this.stopTerminalWatcher(terminalId);

      // Inject into chat session
      this.enqueueOrSend(sessionId, message);
    };

    // Open a virtual channel over the existing reverse-connect WebSocket,
    // or fall back to a direct WebSocket connection.
    let remoteWs: WsWebSocket | VirtualWsAdapter;

    const useVirtual = this.reverseConnectManager?.isConnected(remoteInfo.remoteServerId);

    if (useVirtual && this.reverseConnectManager) {
      const channelId = randomUUID();
      const wsPath = `/api/executor-processes/${remoteInfo.remoteProcessId}/logs`;
      const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      const adapter = new VirtualWsAdapter(
        (data) => this.reverseConnectManager!.sendChannelData(remoteInfo.remoteServerId, channelId, data),
        () => this.reverseConnectManager!.closeChannel(remoteInfo.remoteServerId, channelId),
      );
      this.reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
      this.reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);
      remoteWs = adapter;
      console.log(`[ChatSession] Remote terminal watcher: virtual channel opened for ${remoteInfo.remoteProcessId}`);
      setTimeout(() => adapter.emit("open"), 0);
    } else {
      const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
      const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
      const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
      const remoteWsUrl = `${wsUrl}/api/executor-processes/${remoteInfo.remoteProcessId}/logs?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      console.log(`[ChatSession] Remote terminal watcher: connecting to ${remoteWsUrl.replace(remoteInfo.remoteApiKey, "***")}`);
      remoteWs = new WsWebSocket(remoteWsUrl);
    }

    const closeWs = () => {
      try {
        remoteWs.close();
      } catch {
        // already closed
      }
    };

    remoteWs.on("message", (data) => {
      let msg: { type: string; data?: string; exitCode?: number };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Skip non-log messages (init, error, etc.)
      if (msg.type !== "pty" && msg.type !== "stdout" && msg.type !== "stderr" && msg.type !== "finished") return;

      if (msg.type === "finished") {
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
        flush();
        closeWs();
        return;
      }

      if (msg.type === "pty" || msg.type === "stdout" || msg.type === "stderr") {
        state.outputBuffer += msg.data ?? "";

        // Reset debounce timer
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(() => {
          console.log(`[ChatSession] remote debounce timer fired for terminal=${terminalId}, bufferLen=${state.outputBuffer.length}`);
          flush();
          closeWs();
        }, DEBOUNCE_MS);

        // Reset idle timer
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => this.stopTerminalWatcher(terminalId), IDLE_TIMEOUT_MS);
      }
    });

    remoteWs.on("close", () => {
      console.log(`[ChatSession] Remote terminal watcher: connection closed for terminal=${terminalId}`);
      // If we still have buffered output, flush it
      if (state.outputBuffer.trim() && this.terminalWatchers.has(terminalId)) {
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
        flush();
      }
    });

    remoteWs.on("error", (error) => {
      console.error(`[ChatSession] Remote terminal watcher error for terminal=${terminalId}:`, error);
    });

    const unsubscribe = () => {
      closeWs();
    };

    this.terminalWatchers.set(terminalId, {
      unsubscribe,
      state,
      sessionId,
    });

    console.log(`[ChatSession] Started remote terminal watcher for terminal=${terminalId} session=${sessionId}`);
  }

  /**
   * Open a lightweight server-side WebSocket to a remote executor's log stream
   * to detect when it finishes. Without this, `executor:stopped` is only emitted
   * when a frontend client connects the log proxy — which may not happen until
   * the user switches browser tabs.
   */
  private monitorRemoteExecutor(localProcessId: string, remoteInfo: RemoteExecutorInfo): void {
    // Avoid double-monitoring (e.g. if the frontend proxy is already connected)
    if (this.remoteExecutorMonitors.has(localProcessId)) return;

    let remoteWs: WsWebSocket | VirtualWsAdapter;

    const useVirtual = this.reverseConnectManager?.isConnected(remoteInfo.remoteServerId);

    if (useVirtual && this.reverseConnectManager) {
      const channelId = randomUUID();
      const wsPath = `/api/executor-processes/${remoteInfo.remoteProcessId}/logs`;
      const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      const adapter = new VirtualWsAdapter(
        (data) => this.reverseConnectManager!.sendChannelData(remoteInfo.remoteServerId, channelId, data),
        () => this.reverseConnectManager!.closeChannel(remoteInfo.remoteServerId, channelId),
      );
      this.reverseConnectManager.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
      this.reverseConnectManager.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);
      remoteWs = adapter;
      setTimeout(() => adapter.emit("open"), 0);
    } else {
      if (!remoteInfo.remoteUrl) {
        console.log(`[ChatSession] monitorRemoteExecutor: no direct URL for ${localProcessId}, skipping`);
        return;
      }
      const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
      const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
      const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
      const remoteWsUrl = `${wsUrl}/api/executor-processes/${remoteInfo.remoteProcessId}/logs?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      remoteWs = new WsWebSocket(remoteWsUrl);
    }

    const cleanup = () => {
      this.remoteExecutorMonitors.delete(localProcessId);
      try { remoteWs.close(); } catch { /* already closed */ }
    };

    // Collect output from remote log messages to include in the event
    const outputChunks: string[] = [];

    remoteWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        // Accumulate output from pty/stdout/stderr messages
        if ((parsed.type === "pty" || parsed.type === "stdout" || parsed.type === "stderr") && parsed.data) {
          outputChunks.push(parsed.data);
        }
        if (parsed.type === "finished") {
          const info = this.remoteExecutorMap.get(localProcessId);
          if (info && !info.stoppedEmitted) {
            info.stoppedEmitted = true;
            // Build tail output from collected chunks, strip ANSI codes
            let raw = outputChunks.join("");
            raw = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
            const tailOutput = raw.length > 10000 ? raw.slice(-10000) : raw;
            this.eventBus?.emit({
              type: "executor:stopped",
              projectId: info.projectId ?? "",
              executorId: info.executorId,
              processId: localProcessId,
              exitCode: parsed.exitCode ?? 0,
              target: info.remoteServerId,
              tailOutput,
            });
          }
          this.remoteExecutorMap.delete(localProcessId);
          // Soft-delete: keep the DB row so "Last run" + post-finish log
          // replay survive past the process's lifecycle.
          this.storage.remoteExecutorProcesses.markFinished(
            localProcessId,
            typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
          );
          cleanup();
        }
      } catch { /* ignore parse errors */ }
    });

    remoteWs.on("close", () => {
      cleanup();
    });

    remoteWs.on("error", (error) => {
      console.error(`[ChatSession] monitorRemoteExecutor error for ${localProcessId}:`, error);
      cleanup();
    });

    this.remoteExecutorMonitors.set(localProcessId, cleanup);
    console.log(`[ChatSession] Started remote executor monitor for ${localProcessId}`);
  }

  // ---- Session lifecycle ----

  getOrCreateSession(projectId: string, branch: string | null, userId: string): string {
    const key = `${projectId}:${branch ?? ""}`;
    const existing = this.sessionIndex.get(key);
    if (existing && this.sessions.has(existing)) {
      return existing;
    }

    const id = randomUUID();
    const session: ChatSession = {
      id,
      projectId,
      branch,
      userId,
      store: { patches: [], entries: [], nextIndex: 0 },
      subscribers: new Set(),
      status: "stopped",
      abortController: null,
      eventListeningEnabled: false,
    };

    this.sessions.set(id, session);
    this.sessionIndex.set(key, id);
    console.log(`[ChatSession] Created session ${id} for project=${projectId} branch=${branch} userId=${userId}`);
    return id;
  }

  getSession(sessionId: string): ChatSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getMessages(sessionId: string): AgentMessage[] {
    return this.sessions.get(sessionId)?.store.entries ?? [];
  }

  // ---- WebSocket subscription ----

  subscribe(sessionId: string, ws: WebSocket): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Replay all historical patches
    for (const patch of session.store.patches) {
      const msg: AgentWsMessage = { JsonPatch: patch };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Client gone
      }
    }

    // Send current status
    const statusPatch = ConversationPatch.updateStatus(session.status);
    try {
      ws.send(JSON.stringify({ JsonPatch: statusPatch }));
    } catch {
      // Client gone
    }

    // Signal replay complete
    try {
      ws.send(JSON.stringify({ Ready: true }));
    } catch {
      // Client gone
    }

    session.subscribers.add(ws);

    return () => {
      session.subscribers.delete(ws);
    };
  }

  // ---- Tools & system prompt ----

  private getSystemPrompt(projectId: string, branch: string | null): string {
    const lines = [
      "You are a helpful assistant for a software development workspace.",
      "CRITICAL RULE: Every action you take MUST be an actual tool invocation. Writing text like 'I'll run X' or 'I've started X' does NOT execute anything — only a tool_use block does. If you need to perform an action, invoke the tool. If you cannot invoke the tool right now, say so honestly instead of pretending you did. Never narrate a tool call without actually making it. Violating this rule means the action silently fails while you falsely report success.",
      "You can check the status of running executors (dev servers, build processes, etc.) using the getExecutorStatus tool.",
      "You can start executors using the runExecutor tool and stop them using the stopExecutor tool.",
      "When the user asks about running processes, errors, build status, or dev server status, use the getExecutorStatus tool.",
      "When the user asks to start, run, or launch a process, use runExecutor. When they ask to stop or kill a process, use stopExecutor.",
      "CRITICAL — runExecutor is ASYNCHRONOUS: a successful return from runExecutor means the executor was *started*, NOT that it has finished. The process is still running in the background. Do NOT tell the user the task is done, the build succeeded, tests passed, or the command completed based on runExecutor's return value. The executor is only finished when you receive an `[Executor Event: Process Finished]` message — that message (and only that message) carries the exit code and final output. If the user is waiting on the result of a one-shot executor (build, test, script), wait for the Process Finished event before reporting outcome. For long-running executors (dev servers), it is fine to report that it was started.",
      ...(() => {
        const project = this.storage.projects.getById(projectId);
        const remotes = this.storage.projectRemotes.getByProject(projectId);
        if (remotes.length === 0) return [];
        const remoteNames = remotes.map((r) => {
          const server = this.storage.remoteServers.getById(r.remote_server_id);
          return server?.name ?? r.remote_server_id;
        });
        const lines = [
          `This project has ${remotes.length} remote server(s): ${remoteNames.join(", ")}.`,
        ];
        if (!project?.path) {
          lines.push("This project has no local path — executors must run on a remote server.");
        }
        if (remotes.length === 1) {
          lines.push(
            `When the user asks to run or stop an executor without specifying a remote, use "${remoteNames[0]}" automatically.`
          );
        } else {
          lines.push(
            "When the user asks to run or stop an executor without specifying which remote, ask them to choose a remote before calling the tool. Available remotes: " + remoteNames.join(", ") + "."
          );
        }
        return lines;
      })(),
      "You can view the coding agent's conversation history using the getAgentConversation tool.",
      "When the user asks about what the agent is doing, has done, or references agent activities, use this tool.",
      "When you receive an [Executor Event] message, first check if any Workspace Rules apply to this event. If a rule matches, follow it (e.g. run another executor, send a command, etc.) AND briefly state what finished. IMPORTANT: If a rule says to run an executor, you MUST call the runExecutor tool every time — even if that same executor was already run earlier in this session. Never skip the tool call or claim you started an executor without actually calling runExecutor. Each rule match requires a new tool invocation. When a rule requires multiple sequential actions (e.g. run A then B then C), invoke each tool one at a time — do not narrate future steps, just invoke the next tool. If no rule applies, respond in 1-2 sentences only stating what finished, whether it succeeded or failed, and the key detail (e.g. error message) if it failed. Do not repeat the output logs.",
      "You can list active terminal sessions using the listTerminals tool.",
      "You can send commands to a terminal using the runInTerminal tool. The command runs visibly in the user's terminal and returns immediately.",
      "After sending a command, terminal output will arrive as a [Terminal Event] message once the command finishes. Wait for it before commenting on results.",
      "When the user asks to run a command, check something in the terminal, or interact with a shell, use these tools.",
      "If no terminals are open, suggest the user open one in the Terminal tab first.",
      "You can open web pages in the preview browser using the openPreview tool.",
      "You can interact with pages: clickElement, fillInput, selectOption, pressKey.",
      "You can inspect pages: screenshot (returns base64 image), getPageContent (returns text/HTML), waitForElement.",
      "When you receive a [Browser Event] message, respond in 1-2 sentences. State what error occurred and suggest a fix if obvious.",
      `Current workspace: project=${projectId}, branch=${branch ?? "default"}.`,
    ];

    // Inject workspace rules
    const rules = this.storage.rules.getByWorkspace(projectId, branch);
    const enabledRules = rules.filter(r => r.enabled);
    if (enabledRules.length > 0) {
      lines.push("");
      lines.push("## Workspace Rules");
      lines.push("The user has configured the following rules for this workspace. Follow them:");
      enabledRules.forEach((rule, i) => {
        lines.push(`${i + 1}. [${rule.name}]: ${rule.content}`);
      });
    }

    return lines.join("\n");
  }

  private createTools(projectId: string, branch: string | null, sessionId?: string) {
    const storage = this.storage;
    const processManager = this.processManager;
    const agentSessionManager = this.agentSessionManager;
    const remoteExecutorMap = this.remoteExecutorMap;
    const reverseConnectManager = this.reverseConnectManager;
    const browserManager = this.browserManager;
    const onBrowserError = (error: BrowserError) => {
      if (sessionId) this.handleBrowserError(sessionId, error);
    };
    /** Try iframe command first, fall back to Playwright. Returns null if iframe handled it. */
    const tryIframeCommand = sessionId
      ? (cmd: Omit<BrowserCommand, "id">) => this.sendBrowserCommand(sessionId, cmd)
      : () => Promise.resolve(null);

    return {
      getAgentConversation: tool({
        description:
          "Get the conversation history of the coding agent in the current workspace. " +
          "Use this when the user asks about what the coding agent is doing, what it has done, " +
          "or needs context about the agent's work. Returns recent messages from the agent session.",
        inputSchema: z.object({
          tailMessages: z
            .number()
            .min(1)
            .max(50)
            .default(20)
            .describe("Number of recent messages to return"),
        }),
        execute: async ({ tailMessages }) => {
          // Collect local session
          let localResult: { sessionId: string; status: string; totalMessages: number; messages: unknown[] } | null = null;
          let agentSession = agentSessionManager.getSessionByBranch(projectId, branch);
          if (!agentSession) {
            const projectSessions = agentSessionManager.getSessionsByProject(projectId);
            agentSession = projectSessions.find(s => s.status === "running")
              ?? projectSessions[0]
              ?? null;
          }
          if (agentSession) {
            const allMessages = agentSessionManager.getMessages(agentSession.id);
            const recent = allMessages.slice(-tailMessages);
            localResult = {
              sessionId: agentSession.id,
              status: agentSession.status,
              totalMessages: allMessages.length,
              messages: this.summarizeMessages(recent),
            };
          }

          // Collect remote session
          let remoteResult: { sessionId: string; status: string; totalMessages: number; messages: unknown[]; note?: string } | null = null;
          const remote = this.findRemoteSessionForProject(projectId, branch);
          console.log(`[ChatSession] getAgentConversation: projectId=${projectId}, branch=${branch ?? "null"}, remote=${remote ? remote.localSessionId : "null"}, remoteBranch=${remote?.info.branch ?? "null"}`);
          if (remote) {
            try {
              const result = await proxyToRemote(
                remote.info.remoteUrl,
                remote.info.remoteApiKey,
                "GET",
                `/api/agent-sessions/${remote.info.remoteSessionId}`,
              );
              console.log(`[ChatSession] getAgentConversation: remote proxy result ok=${result.ok}, status=${result.status}`);
              if (result.ok) {
                const data = result.data as { session: { status: string }; messages: AgentMessage[] };
                let allMessages = data.messages ?? [];
                console.log(`[ChatSession] getAgentConversation: remote returned ${allMessages.length} messages, session.status=${data.session?.status}`);

                // Fallback: if remote returned no messages, extract from local cache
                if (allMessages.length === 0) {
                  allMessages = this.extractMessagesFromCache(remote.localSessionId);
                }

                // If session is running but still no messages, poll cache briefly
                // to allow time for ENTRY patches to arrive via WebSocket
                if (allMessages.length === 0 && data.session?.status === "running") {
                  const cacheState = this.remotePatchCache.get(remote.localSessionId);
                  console.log(`[ChatSession] getAgentConversation: 0 messages for running session, starting retry. Cache state: wsState=${cacheState?.remoteWs?.readyState ?? "null"}, cachedMsgs=${cacheState?.messages.length ?? 0}, patchCount=${cacheState?.patchCount ?? 0}, finished=${cacheState?.finished ?? "N/A"}, reconnecting=${cacheState?.reconnecting ?? "N/A"}`);
                  for (let attempt = 0; attempt < 3; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    allMessages = this.extractMessagesFromCache(remote.localSessionId);
                    console.log(`[ChatSession] getAgentConversation: retry attempt ${attempt + 1}/3, extracted ${allMessages.length} messages`);
                    if (allMessages.length > 0) break;
                  }
                  if (allMessages.length === 0) {
                    const finalCache = this.remotePatchCache.get(remote.localSessionId);
                    console.log(`[ChatSession] getAgentConversation: all retries exhausted, still 0 messages. Final cache: wsState=${finalCache?.remoteWs?.readyState ?? "null"}, cachedMsgs=${finalCache?.messages.length ?? 0}, patchCount=${finalCache?.patchCount ?? 0}`);
                  }
                }

                const recent = allMessages.slice(-tailMessages);
                remoteResult = {
                  sessionId: remote.localSessionId,
                  status: data.session?.status ?? "unknown",
                  totalMessages: allMessages.length,
                  messages: this.summarizeMessages(recent),
                  ...(allMessages.length === 0 && data.session?.status === "running"
                    ? { note: "Session just started, agent is still initializing. Try again in a few seconds." }
                    : {}),
                };
              } else {
                console.error(`[ChatSession] getAgentConversation: remote proxy failed status=${result.status}`);
                // Try local cache even if remote returned non-ok status
                const cachedMessages = this.extractMessagesFromCache(remote.localSessionId);
                if (cachedMessages.length > 0) {
                  remoteResult = {
                    sessionId: remote.localSessionId,
                    status: "running",
                    totalMessages: cachedMessages.length,
                    messages: this.summarizeMessages(cachedMessages.slice(-tailMessages)),
                  };
                }
              }
            } catch (err) {
              console.error(`[ChatSession] getAgentConversation: remote proxy error:`, err);
              // Try local cache even if remote is unreachable
              const cachedMessages = this.extractMessagesFromCache(remote.localSessionId);
              if (cachedMessages.length > 0) {
                remoteResult = {
                  sessionId: remote.localSessionId,
                  status: "running",
                  totalMessages: cachedMessages.length,
                  messages: this.summarizeMessages(cachedMessages.slice(-tailMessages)),
                };
              }
            }
          }

          if (!localResult && !remoteResult) {
            return { local: null, remote: null, message: "No coding agent session found for this workspace." };
          }

          return { local: localResult, remote: remoteResult };
        },
      }),

      getExecutorStatus: tool({
        description:
          "Get the status of all executors (dev servers, build processes, etc.) in the current workspace. " +
          "Use this when the user asks about running processes, errors, build output, or dev server status.",
        inputSchema: z.object({
          tailLines: z
            .number()
            .min(1)
            .max(100)
            .default(20)
            .describe("Number of recent output lines to include per executor"),
        }),
        execute: async ({ tailLines }) => {
          const group = storage.executorGroups.getByBranch(projectId, branch ?? "");

          if (!group) {
            return { executors: [], message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);

          const results = executors.map((executor) => {
            const processes = processManager.getProcessesByExecutorId(executor.id);
            const latestProcess = processes[processes.length - 1];

            return {
              name: executor.name,
              command: executor.command,
              isRunning: latestProcess?.isRunning ?? false,
              recentOutput: latestProcess
                ? extractLogText(latestProcess.logs, tailLines)
                : "(no process history)",
            };
          });

          return { executors: results };
        },
      }),

      runExecutor: tool({
        description:
          "Start an executor (dev server, build process, etc.) by name. " +
          "Use this when the user asks to start, run, or launch a process. " +
          "Optionally specify a remote server ID to run the executor on a remote machine. " +
          "ASYNCHRONOUS: this tool returns as soon as the process is spawned; it does NOT wait for the process to finish. " +
          "A successful return only means the executor was started. Completion is signaled later by an `[Executor Event: Process Finished]` message, which carries the exit code. Do not claim the task/build/test is complete based on this tool's return value.",
        inputSchema: z.object({
          executorName: z
            .string()
            .describe("Name of the executor to start (case-insensitive match)"),
          remote: z
            .string()
            .optional()
            .describe("Remote server name or ID to run the executor on. If omitted, uses project executor_mode or runs locally."),
        }),
        execute: async ({ executorName, remote }) => {
          const group = storage.executorGroups.getByBranch(projectId, branch ?? "");

          if (!group) {
            return { success: false, message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);
          const executor = executors.find(
            (e) => e.name.toLowerCase() === executorName.toLowerCase()
          );

          if (!executor) {
            const available = executors.map((e) => e.name).join(", ");
            return {
              success: false,
              message: `Executor "${executorName}" not found. Available: ${available || "none"}`,
            };
          }

          // Resolve remote by name or ID
          let remoteServerId = remote;
          if (remote) {
            const byId = storage.remoteServers.getById(remote);
            if (!byId) {
              const allServers = storage.remoteServers.getAll();
              const byName = allServers.find((s) => s.name.toLowerCase() === remote.toLowerCase());
              if (byName) {
                remoteServerId = byName.id;
              }
            }
          }

          // Resolve remote target: explicit param → project.executor_mode fallback
          // This matches the behavior of process-routes.ts start handler so the
          // executor panel (which filters by executor_mode) sees the process.
          const project = storage.projects.getById(projectId);
          let executorMode = remoteServerId || project?.executor_mode;
          let resolvedRemote = executorMode && executorMode !== "local" ? executorMode : undefined;

          // Fallback: if local mode but no local path, try to find a remote
          if (!resolvedRemote && !project?.path) {
            const remotes = storage.projectRemotes.getByProject(projectId);
            if (remotes.length > 0) {
              resolvedRemote = remotes[0].remote_server_id;
            }
          }

          // Remote execution — proxy to the resolved remote server
          if (resolvedRemote) {
            const remoteConfig = storage.projectRemotes.getByProjectAndServer(projectId, resolvedRemote);
            if (!remoteConfig) {
              return { success: false, message: `Remote server "${resolvedRemote}" not configured for this project.` };
            }

            const result = await proxyToRemoteAuto(
              resolvedRemote,
              remoteConfig.server_url ?? "",
              remoteConfig.server_api_key || "",
              "POST",
              `/api/path/execute`,
              {
                path: remoteConfig.remote_path,
                command: executor.command,
                executor_type: executor.executor_type,
                prompt_provider: executor.prompt_provider,
                branch: branch ?? undefined,
                cwd: executor.cwd || undefined,
                pty: executor.pty,
              },
              { reverseConnectManager: reverseConnectManager ?? undefined },
            );

            if (!result.ok) {
              return { success: false, message: `Remote start failed: ${JSON.stringify(result.data)}` };
            }

            const remoteData = result.data as { processId: string };
            const localProcessId = `remote-${executor.id}-${remoteData.processId}`;
            remoteExecutorMap.set(localProcessId, {
              remoteServerId: resolvedRemote,
              remoteUrl: remoteConfig.server_url ?? "",
              remoteApiKey: remoteConfig.server_api_key || "",
              remoteProcessId: remoteData.processId,
              executorId: executor.id,
              projectId,
              branch,
            });
            this.storage.remoteExecutorProcesses.insert(localProcessId, {
              remoteServerId: resolvedRemote,
              remoteUrl: remoteConfig.server_url ?? "",
              remoteApiKey: remoteConfig.server_api_key || "",
              remoteProcessId: remoteData.processId,
              executorId: executor.id,
              projectId,
              branch,
            });

            // Emit SSE event so the Executor panel learns about the new process
            // (matches process-routes.ts behavior for UI-started executors)
            this.eventBus?.emit({
              type: "executor:started",
              projectId,
              executorId: executor.id,
              processId: localProcessId,
              target: resolvedRemote,
            });

            // Auto-enable event listening so the chat receives the executor:stopped event
            if (sessionId) {
              this.setEventListening(sessionId, true);
            }

            // Monitor remote process so executor:stopped fires even if no
            // frontend client connects the log WebSocket proxy.
            this.monitorRemoteExecutor(localProcessId, {
              remoteServerId: resolvedRemote,
              remoteUrl: remoteConfig.server_url ?? "",
              remoteApiKey: remoteConfig.server_api_key || "",
              remoteProcessId: remoteData.processId,
              executorId: executor.id,
              projectId,
              branch,
            });

            return {
              success: true,
              processId: localProcessId,
              executorName: executor.name,
              command: executor.command,
              target: resolvedRemote,
              message: `Started "${executor.name}" on remote server "${resolvedRemote}" (${executor.command}).`,
            };
          }

          // Check if already running (local only)
          const processes = processManager.getProcessesByExecutorId(executor.id);
          const running = processes.find((p) => p.isRunning);
          if (running) {
            return {
              success: false,
              processId: running.processId,
              executorName: executor.name,
              message: `Executor "${executor.name}" is already running (processId=${running.processId}).`,
            };
          }

          // Resolve project path (local execution)
          if (!project?.path) {
            return { success: false, message: "No project path configured and no remote servers available." };
          }


          const basePath = resolveWorktreePath(project.path, branch);

          try {
            const processId = processManager.start(executor, basePath);

            // Auto-enable event listening so the chat receives the executor:stopped event
            if (sessionId) {
              this.setEventListening(sessionId, true);
            }

            return {
              success: true,
              processId,
              executorName: executor.name,
              command: executor.command,
              message: `Started "${executor.name}" (${executor.command}).`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return { success: false, message: `Failed to start executor: ${msg}` };
          }
        },
      }),

      stopExecutor: tool({
        description:
          "Stop a running executor (dev server, build process, etc.) by name. " +
          "Use this when the user asks to stop, kill, or terminate a process. " +
          "Optionally specify a remote server ID to stop a remote executor.",
        inputSchema: z.object({
          executorName: z
            .string()
            .describe("Name of the executor to stop (case-insensitive match)"),
          remote: z
            .string()
            .optional()
            .describe("Remote server name or ID where the executor is running. If omitted, auto-detects."),
        }),
        execute: async ({ executorName, remote }) => {
          const group = storage.executorGroups.getByBranch(projectId, branch ?? "");

          if (!group) {
            return { success: false, message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);
          const executor = executors.find(
            (e) => e.name.toLowerCase() === executorName.toLowerCase()
          );

          if (!executor) {
            const available = executors.map((e) => e.name).join(", ");
            return {
              success: false,
              message: `Executor "${executorName}" not found. Available: ${available || "none"}`,
            };
          }

          // Resolve remote by name or ID
          let remoteServerId = remote;
          if (remote) {
            const byId = storage.remoteServers.getById(remote);
            if (!byId) {
              const allServers = storage.remoteServers.getAll();
              const byName = allServers.find((s) => s.name.toLowerCase() === remote.toLowerCase());
              if (byName) {
                remoteServerId = byName.id;
              }
            }
          }

          // Resolve remote target: explicit param or auto-detect from remoteExecutorMap
          let resolvedRemote = remoteServerId;

          // Auto-detect: if not specified, check if the executor is running on a remote
          if (!resolvedRemote) {
            const runningRemotes: string[] = [];
            for (const [, info] of remoteExecutorMap.entries()) {
              if (info.executorId === executor.id) {
                runningRemotes.push(info.remoteServerId);
              }
            }
            if (runningRemotes.length === 1) {
              resolvedRemote = runningRemotes[0];
            } else if (runningRemotes.length > 1) {
              const remoteNames = runningRemotes.map((id) => {
                const server = storage.remoteServers.getById(id);
                return server?.name ?? id;
              });
              return {
                success: false,
                needsClarification: true,
                availableRemotes: remoteNames,
                message: `Executor "${executor.name}" is running on multiple remotes. Please ask the user which one to stop. Running on: ${remoteNames.join(", ")}`,
              };
            }
          }

          // Remote stop — find the remote process in remoteExecutorMap and proxy the stop
          if (resolvedRemote) {
            let remoteEntry: { key: string; info: RemoteExecutorInfo } | undefined;
            for (const [key, info] of remoteExecutorMap.entries()) {
              if (info.executorId === executor.id && info.remoteServerId === resolvedRemote) {
                remoteEntry = { key, info };
                break;
              }
            }

            if (!remoteEntry) {
              // Not running on remote, fall through to local check
            } else {
              const result = await proxyToRemoteAuto(
                remoteEntry.info.remoteServerId,
                remoteEntry.info.remoteUrl,
                remoteEntry.info.remoteApiKey,
                "POST",
                `/api/executor-processes/${remoteEntry.info.remoteProcessId}/stop`,
                undefined,
                { reverseConnectManager: reverseConnectManager ?? undefined },
              );

              if (!result.ok) {
                return { success: false, message: `Remote stop failed: ${JSON.stringify(result.data)}` };
              }

              remoteExecutorMap.delete(remoteEntry.key);
              // Soft-delete keeps the row available for "Last run" + log replay.
              this.storage.remoteExecutorProcesses.markFinished(remoteEntry.key, 0, 'killed');
              return {
                success: true,
                executorName: executor.name,
                processId: remoteEntry.key,
                target: resolvedRemote,
                message: `Stopped "${executor.name}" on remote server "${resolvedRemote}".`,
              };
            }
          }

          const processes = processManager.getProcessesByExecutorId(executor.id);
          const running = processes.find((p) => p.isRunning);

          if (!running) {
            return {
              success: false,
              executorName: executor.name,
              message: `Executor "${executor.name}" is not running.`,
            };
          }

          const stopped = processManager.stop(running.processId);
          return {
            success: stopped,
            executorName: executor.name,
            processId: running.processId,
            message: stopped
              ? `Stopped "${executor.name}" (processId=${running.processId}).`
              : `Failed to stop "${executor.name}".`,
          };
        },
      }),

      listTerminals: tool({
        description:
          "List all active terminal sessions in the current workspace. " +
          "Use this to discover available terminals before running commands with runInTerminal.",
        inputSchema: z.object({}),
        execute: async () => {
          // Local terminals
          const localTerminals = processManager.getTerminals(projectId).map((t) => ({
            id: t.id,
            name: t.name,
            cwd: t.cwd,
            branch: t.branch,
            location: "local" as const,
          }));

          // Remote terminals from remoteExecutorMap
          const remoteTerminals: Array<{
            id: string;
            name: string;
            cwd?: string;
            branch?: string | null;
            location: "remote";
          }> = [];
          for (const [key, info] of remoteExecutorMap.entries()) {
            if (!key.startsWith("remote-terminal-")) continue;
            if (info.projectId && info.projectId !== projectId) continue;
            remoteTerminals.push({
              id: key,
              name: key,
              branch: info.branch,
              location: "remote",
            });
          }

          const terminals = [...localTerminals, ...remoteTerminals];
          if (terminals.length === 0) {
            return {
              terminals: [],
              message: "No active terminals. The user should open a terminal in the Terminal tab first.",
            };
          }
          return { terminals };
        },
      }),

      runInTerminal: tool({
        description:
          "Send a shell command to an active terminal session. The command runs visibly in the user's terminal. " +
          "Returns immediately — terminal output will arrive as a [Terminal Event] message once the command finishes. " +
          "Use listTerminals first to get available terminal IDs. " +
          "Use this when the user asks to run a command, check something, or interact with their shell.",
        inputSchema: z.object({
          terminalId: z.string().describe("ID of the terminal to run the command in (from listTerminals)"),
          command: z.string().describe("The shell command to execute"),
        }),
        execute: async ({ terminalId, command }) => {
          try {
            // Remote terminal — proxy to remote server (fire-and-forget)
            if (terminalId.startsWith("remote-terminal-")) {
              const remoteInfo = remoteExecutorMap.get(terminalId);
              console.log(`[runInTerminal] terminalId=${terminalId}, remoteProcessId=${remoteInfo?.remoteProcessId}, serverId=${remoteInfo?.remoteServerId}`);
              if (!remoteInfo) {
                return { sent: false, message: `Remote terminal ${terminalId} not found.` };
              }
              const result = await proxyToRemoteAuto(
                remoteInfo.remoteServerId,
                remoteInfo.remoteUrl,
                remoteInfo.remoteApiKey,
                "POST",
                `/api/path/terminals/${remoteInfo.remoteProcessId}/send`,
                { command },
                { reverseConnectManager: reverseConnectManager ?? undefined },
              );
              if (!result.ok) {
                return { sent: false, message: `Remote send failed: ${JSON.stringify(result.data)}` };
              }

              // Start a remote terminal watcher so output flows back as a [Terminal Event]
              const sessionKey = `${projectId}:${branch ?? ""}`;
              const chatSessionId = this.sessionIndex.get(sessionKey);
              console.log(`[runInTerminal] remote: sessionKey=${sessionKey}, chatSessionId=${chatSessionId ?? "NOT FOUND"}`);
              if (chatSessionId) {
                this.startRemoteTerminalWatcher(chatSessionId, terminalId, remoteInfo);
              } else {
                console.log(`[runInTerminal] WARNING: No chat session found — remote terminal watcher NOT started`);
              }

              return { sent: true, message: "Command sent to remote terminal. Output will arrive as a [Terminal Event]." };
            }

            // Local terminal — send command and start watcher
            processManager.sendToTerminal(terminalId, command);
            console.log(`[runInTerminal] Command sent to PTY for terminal=${terminalId}`);

            // Find the chat session that called this tool so we can inject the [Terminal Event] later
            const sessionKey = `${projectId}:${branch ?? ""}`;
            const chatSessionId = this.sessionIndex.get(sessionKey);
            console.log(`[runInTerminal] sessionKey=${sessionKey}, chatSessionId=${chatSessionId ?? "NOT FOUND"}`);
            if (chatSessionId) {
              this.startTerminalWatcher(chatSessionId, terminalId);
            } else {
              console.log(`[runInTerminal] WARNING: No chat session found — terminal watcher NOT started`);
            }

            return { sent: true, message: "Command sent to terminal. Output will arrive as a [Terminal Event]." };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return { sent: false, message: msg };
          }
        },
      }),

      openPreview: tool({
        description:
          "Open a URL in the preview browser. " +
          "Use this when the user asks to open, preview, or navigate to a web page. " +
          "This opens the page in the preview iframe (preferred) or falls back to server-side Playwright.",
        inputSchema: z.object({
          url: z.string().describe("The URL to open (e.g. https://remote-server:3000)"),
        }),
        execute: async ({ url }) => {
          // Prefer iframe preview — send WS message to frontend
          if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (session && session.subscribers.size > 0) {
              const raw = JSON.stringify({ openPreviewFrame: { projectId, url } } satisfies AgentWsMessage);
              for (const ws of session.subscribers) {
                try { ws.send(raw); } catch { /* ignore */ }
              }
              return { success: true, title: "Preview opened", url };
            }
          }

          // Fallback to Playwright (no frontend connected)
          if (!browserManager) {
            return { success: false, message: "Browser preview not available." };
          }
          try {
            let session = browserManager.getSession(projectId);
            if (!session) {
              session = await browserManager.startSession(projectId, branch, onBrowserError);
            }
            const result = await browserManager.navigate(projectId, url);
            if (!result) {
              return { success: false, message: "No browser session available." };
            }
            return { success: true, title: result.title, url: result.url };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to open URL";
            return { success: false, error: msg };
          }
        },
      }),

      clickElement: tool({
        description:
          "Click an element on the page in the preview browser. " +
          "Accepts CSS selectors, text selectors (text=Submit), or role selectors (role=button[name='Submit']).",
        inputSchema: z.object({
          selector: z.string().describe("Selector for the element to click"),
        }),
        execute: async ({ selector }) => {
          // Try iframe first (user sees it live)
          const iframeResult = await tryIframeCommand({ action: "click", selector });
          if (iframeResult) return iframeResult;
          // Fallback to Playwright
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            await page.click(selector, { timeout: 5000 });
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Click failed";
            return { success: false, error: msg };
          }
        },
      }),

      fillInput: tool({
        description:
          "Fill an input or textarea on the page in the preview browser. " +
          "Clears existing value before typing. Accepts CSS, text, or role selectors.",
        inputSchema: z.object({
          selector: z.string().describe("Selector for the input element"),
          value: z.string().describe("Value to fill"),
        }),
        execute: async ({ selector, value }) => {
          // Try iframe first (user sees it live)
          const iframeResult = await tryIframeCommand({ action: "fill", selector, value });
          if (iframeResult) return iframeResult;
          // Fallback to Playwright
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            await page.fill(selector, value, { timeout: 5000 });
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Fill failed";
            return { success: false, error: msg };
          }
        },
      }),

      selectOption: tool({
        description: "Select an option from a <select> dropdown in the preview browser.",
        inputSchema: z.object({
          selector: z.string().describe("Selector for the <select> element"),
          value: z.string().describe("Value or label of the option to select"),
        }),
        execute: async ({ selector, value }) => {
          // Try iframe first
          const iframeResult = await tryIframeCommand({ action: "select", selector, value });
          if (iframeResult) return iframeResult;
          // Fallback to Playwright
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            await page.selectOption(selector, value, { timeout: 5000 });
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Select failed";
            return { success: false, error: msg };
          }
        },
      }),

      pressKey: tool({
        description: "Press a keyboard key in the preview browser (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown').",
        inputSchema: z.object({
          key: z.string().describe("Key to press (e.g. 'Enter', 'Tab', 'Escape')"),
        }),
        execute: async ({ key }) => {
          // Try iframe first
          const iframeResult = await tryIframeCommand({ action: "pressKey", key });
          if (iframeResult) return iframeResult;
          // Fallback to Playwright
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            await page.keyboard.press(key);
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Key press failed";
            return { success: false, error: msg };
          }
        },
      }),

      screenshot: tool({
        description:
          "Take a screenshot of the current page in the preview browser. " +
          "Returns a base64 PNG image. Use this to see the current state of the page.",
        inputSchema: z.object({}),
        execute: async () => {
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            const buffer = await page.screenshot({ type: "png", fullPage: false });
            const base64 = buffer.toString("base64");
            return { success: true, image: base64 };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Screenshot failed";
            return { success: false, error: msg };
          }
        },
      }),

      getPageContent: tool({
        description:
          "Get the text content or HTML of the current page (or a specific element) in the preview browser. " +
          "If no selector is provided, returns the full page text content.",
        inputSchema: z.object({
          selector: z.string().optional().describe("Optional CSS selector to get content of a specific element"),
        }),
        execute: async ({ selector }) => {
          // Try iframe first (reads from the user's actual page)
          const iframeResult = await tryIframeCommand({ action: "getText", selector: selector ?? undefined });
          if (iframeResult) {
            if (iframeResult.success && iframeResult.content) {
              const capped = iframeResult.content.length > 10000
                ? iframeResult.content.slice(0, 10000) + "\n...(truncated)"
                : iframeResult.content;
              return { success: true, content: capped };
            }
            return iframeResult;
          }
          // Fallback to Playwright
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            if (selector) {
              const text = await page.textContent(selector, { timeout: 5000 });
              return { success: true, content: text ?? "" };
            }
            const text = await page.evaluate(() => document.body.innerText);
            const capped = text.length > 10000 ? text.slice(0, 10000) + "\n...(truncated)" : text;
            return { success: true, content: capped };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to get page content";
            return { success: false, error: msg };
          }
        },
      }),

      waitForElement: tool({
        description: "Wait for an element to appear on the page in the preview browser.",
        inputSchema: z.object({
          selector: z.string().describe("Selector to wait for"),
          timeout: z.number().min(1000).max(30000).default(10000).describe("Timeout in milliseconds"),
        }),
        execute: async ({ selector, timeout }) => {
          const page = browserManager?.getPage(projectId);
          if (!page) return { success: false, error: "No browser session. Use openPreview first." };
          try {
            await page.waitForSelector(selector, { timeout });
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Wait timed out";
            return { success: false, error: msg };
          }
        },
      }),
    };
  }

  // ---- Message queue (prevents concurrent streams on the same session) ----

  private enqueueOrSend(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`[ChatSession] enqueueOrSend: session ${sessionId} not found, dropping message`);
      return;
    }

    if (session.abortController) {
      // A stream is already active — queue the message
      let queue = this.messageQueue.get(sessionId);
      if (!queue) {
        queue = [];
        this.messageQueue.set(sessionId, queue);
      }
      queue.push(content);
      console.log(`[ChatSession] Queued message for session ${sessionId} (queue length: ${queue.length})`);
      return;
    }

    // No active stream — send immediately
    console.log(`[ChatSession] enqueueOrSend: sending immediately for session ${sessionId} (abortController=null)`);
    this.sendMessage(sessionId, content).catch((err) => {
      console.error(`[ChatSession] enqueueOrSend sendMessage error:`, err);
    });
  }

  private drainQueue(sessionId: string): void {
    const queue = this.messageQueue.get(sessionId);
    if (!queue || queue.length === 0) {
      this.messageQueue.delete(sessionId);
      return;
    }

    const next = queue.shift()!;
    if (queue.length === 0) this.messageQueue.delete(sessionId);

    console.log(`[ChatSession] Draining queued message for session ${sessionId}`);
    this.sendMessage(sessionId, next).catch((err) => {
      console.error(`[ChatSession] drainQueue sendMessage error:`, err);
    });
  }

  // ---- Send message & stream AI response ----

  async sendMessage(sessionId: string, content: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`[ChatSession] sendMessage: session ${sessionId} not found`);
      return false;
    }
    const isExecutorEvent = content.includes("[Executor Event");
    console.log(`[ChatSession] sendMessage called: session=${sessionId}, contentLen=${content.length}, isExecutorEvent=${isExecutorEvent}, isTerminalEvent=${content.includes("[Terminal Event]")}, subscribers=${session.subscribers.size}`);

    // 1. Push user message
    const userMsg: AgentMessage = { type: "user", content, timestamp: Date.now() };
    this.pushEntry(session, userMsg);
    if (isExecutorEvent) {
      console.log(`[ChatSession] Executor event user message pushed at index ${session.store.nextIndex - 1}, broadcasting to ${session.subscribers.size} subscribers`);
    }

    // 2. Update status to running
    session.status = "running";
    this.broadcastPatch(session, ConversationPatch.updateStatus("running"));

    // 3. Build messages array for AI SDK
    const messages = session.store.entries
      .filter((e): e is Extract<AgentMessage, { type: "user" | "assistant" }> =>
        e.type === "user" || e.type === "assistant"
      )
      .map((e) => ({
        role: e.type as "user" | "assistant",
        content: typeof e.content === "string" ? e.content : e.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n"),
      }));

    // 4. Stream response
    const abortController = new AbortController();
    session.abortController = abortController;

    let assistantIndex: number | null = null;
    let accumulatedText = "";

    try {
      const result = streamText({
        model: resolveChatModel(this.storage),
        system: this.getSystemPrompt(session.projectId, session.branch),
        messages,
        tools: this.createTools(session.projectId, session.branch, session.id),
        stopWhen: stepCountIs(3),
        abortSignal: abortController.signal,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "chat-session",
          metadata: {
            sessionId: session.id,
            userId: session.userId,
            tags: ["vibedeckx", "chat-session"],
            projectId: session.projectId,
            branch: session.branch ?? "(default)",
          },
        },
      });

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;

        switch (part.type) {
          case "text-delta": {
            accumulatedText += part.text;

            if (assistantIndex === null) {
              // First chunk — create the assistant entry
              const assistantMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: true,
                timestamp: Date.now(),
              };
              assistantIndex = session.store.nextIndex;
              session.store.nextIndex++;

              const patch = ConversationPatch.addEntry(assistantIndex, assistantMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = assistantMsg;
              this.broadcastPatch(session, patch);
            } else {
              // Subsequent chunks — replace entry
              const assistantMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: true,
                timestamp: Date.now(),
              };
              const patch = ConversationPatch.replaceEntry(assistantIndex, assistantMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = assistantMsg;
              this.broadcastPatch(session, patch);
            }
            break;
          }

          case "tool-call": {
            // Finalize any partial assistant message before the tool call
            if (assistantIndex !== null && accumulatedText) {
              const finalMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: false,
                timestamp: Date.now(),
              };
              const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = finalMsg;
              this.broadcastPatch(session, patch);
            }

            const toolUseMsg: AgentMessage = {
              type: "tool_use",
              tool: part.toolName,
              input: part.input,
              toolUseId: part.toolCallId,
              timestamp: Date.now(),
            };
            this.pushEntry(session, toolUseMsg);

            // Reset so next text starts a new assistant message
            assistantIndex = null;
            accumulatedText = "";
            break;
          }

          case "tool-result": {
            const output = part.output;
            const toolResultMsg: AgentMessage = {
              type: "tool_result",
              tool: part.toolName,
              output: typeof output === "string" ? output : JSON.stringify(output),
              toolUseId: part.toolCallId,
              timestamp: Date.now(),
            };
            this.pushEntry(session, toolResultMsg);
            break;
          }
        }
      }

      // 5. Finalize — mark as non-partial
      if (assistantIndex !== null) {
        const finalMsg: AgentMessage = {
          type: "assistant",
          content: accumulatedText,
          partial: false,
          timestamp: Date.now(),
        };
        const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
        session.store.patches.push(patch);
        session.store.entries[assistantIndex] = finalMsg;
        this.broadcastPatch(session, patch);
      }
    } catch (err: unknown) {
      // Don't push error for intentional abort
      if (abortController.signal.aborted) {
        // Finalize partial message if we have one
        if (assistantIndex !== null && accumulatedText) {
          const finalMsg: AgentMessage = {
            type: "assistant",
            content: accumulatedText,
            partial: false,
            timestamp: Date.now(),
          };
          const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
          session.store.patches.push(patch);
          session.store.entries[assistantIndex] = finalMsg;
          this.broadcastPatch(session, patch);
        }
      } else {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error(`[ChatSession] Stream error for ${sessionId}:`, errorMessage);
        const errorMsg: AgentMessage = {
          type: "error",
          message: errorMessage,
          timestamp: Date.now(),
        };
        this.pushEntry(session, errorMsg);
      }
    } finally {
      session.abortController = null;
      session.status = "stopped";
      this.broadcastPatch(session, ConversationPatch.updateStatus("stopped"));

      // Process any queued messages (e.g. [Terminal Event] that arrived during this stream)
      const queueLen = this.messageQueue.get(sessionId)?.length ?? 0;
      console.log(`[ChatSession] sendMessage finished for ${sessionId}, draining queue (${queueLen} items), subscribers=${session.subscribers.size}`);
      this.drainQueue(sessionId);
    }

    return true;
  }

  // ---- Stop generation ----

  stopGeneration(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.abortController) return false;

    session.abortController.abort();
    return true;
  }

  /**
   * Reset a chat session — abort any in-flight generation, clear messages,
   * and broadcast a clearAll patch so connected frontends reset.
   */
  resetSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Abort in-flight generation
    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
    }

    // Clear the message store
    session.store.patches = [];
    session.store.entries = [];
    session.store.nextIndex = 0;
    session.status = "stopped";

    // Broadcast clearAll + status to connected subscribers
    const clearPatch = ConversationPatch.clearAll();
    this.broadcastPatch(session, clearPatch);
    const statusPatch = ConversationPatch.updateStatus("stopped");
    this.broadcastPatch(session, statusPatch);

    console.log(`[ChatSession] Reset session ${sessionId}`);
    return true;
  }

  // ---- Internal helpers ----

  private pushEntry(session: ChatSession, entry: AgentMessage): void {
    const index = session.store.nextIndex;
    session.store.nextIndex++;

    const patch = ConversationPatch.addEntry(index, entry);
    session.store.patches.push(patch);
    session.store.entries[index] = entry;
    this.broadcastPatch(session, patch);
  }

  private broadcastPatch(session: ChatSession, patch: Patch): void {
    if (session.subscribers.size === 0) {
      // Check if this is an ENTRY patch (new message) — log it since no one will receive it
      const hasEntry = patch.some(p => p.value?.type === "ENTRY");
      if (hasEntry) {
        console.log(`[ChatSession] broadcastPatch: ENTRY patch but 0 subscribers for session ${session.id}`);
      }
    }
    const raw = JSON.stringify({ JsonPatch: patch });
    for (const ws of session.subscribers) {
      try {
        if (ws.readyState !== 1 /* OPEN */) {
          console.log(`[ChatSession] broadcastPatch: subscriber ws.readyState=${ws.readyState} (not OPEN), skipping`);
          continue;
        }
        ws.send(raw);
      } catch (err) {
        console.log(`[ChatSession] broadcastPatch: send failed:`, err);
      }
    }
  }

  // ---- Browser command via iframe ----

  /**
   * Send a browser command to the frontend via WebSocket.
   * The frontend forwards it to the iframe's injected script via postMessage.
   * Returns the result or null if no subscribers or timeout.
   */
  sendBrowserCommand(
    sessionId: string,
    command: Omit<BrowserCommand, "id">,
    timeoutMs = 5000,
  ): Promise<BrowserCommandResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.subscribers.size === 0) {
      return Promise.resolve(null); // No frontend connected
    }

    const id = `bcmd-${randomUUID()}`;
    const fullCommand: BrowserCommand = { id, ...command };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingBrowserCommands.delete(id);
        resolve(null); // Timeout — frontend didn't respond
      }, timeoutMs);

      this.pendingBrowserCommands.set(id, { resolve, timer });

      // Broadcast to all subscribers
      const raw = JSON.stringify({ browserCommand: fullCommand } satisfies AgentWsMessage);
      for (const ws of session.subscribers) {
        try {
          ws.send(raw);
        } catch { /* client gone */ }
      }
    });
  }

  /**
   * Called when the frontend sends a browserResult message back over WebSocket.
   */
  handleBrowserResult(result: BrowserCommandResult): void {
    const pending = this.pendingBrowserCommands.get(result.id);
    if (!pending) return; // Already timed out or duplicate
    clearTimeout(pending.timer);
    this.pendingBrowserCommands.delete(result.id);
    pending.resolve(result);
  }
}
