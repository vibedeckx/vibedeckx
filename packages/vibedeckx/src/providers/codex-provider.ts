import type { AgentType, ContentPart } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";
import type { CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { detectBinary } from "../protocol/shared/binary.js";
import {
  buildApprovalResponse,
  buildCancelRequest,
  buildInitialize,
  buildThreadStart,
  buildTurnStart,
  parseCodexLine,
} from "../protocol/codex/codec.js";
import { buildCodexAppServerSpawnConfig } from "../protocol/codex/cli.js";
import { CODEX_BINARY_NAME, CODEX_CLIENT_METHODS, CODEX_NOTIFICATIONS, CODEX_SERVER_REQUESTS } from "../protocol/codex/schema.js";

interface CodexSessionState {
  threadId: string | null;
  rpcIdCounter: number;
  initialized: boolean;
  pendingRequests: Map<number, string>;
  permissionMode: "plan" | "edit";
  /** Buffered first-turn content, sent after thread/start response provides threadId */
  pendingTurnContent: string | ContentPart[] | null;
  lastTokenUsage: { input_tokens?: number; output_tokens?: number };
  turnsWithFinalMessage: Set<string>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class CodexProvider implements AgentProvider {
  private sessions = new Map<string, CodexSessionState>();
  private static idCounter = 0;
  private lastPermissionMode: "plan" | "edit" = "edit";

  getAgentType(): AgentType {
    return "codex";
  }

  getDisplayName(): string {
    return "Codex";
  }

  getInstallHint(): string {
    return "Codex doesn't seem to be installed. Install it with `npm i -g @openai/codex`, or make sure the `codex` binary is on your PATH. (It also runs via `npx`, which requires network access on first use.)";
  }

  detectBinary(): string | null {
    return detectBinary(CODEX_BINARY_NAME);
  }

  isAvailable(): boolean {
    // Always runnable: buildSpawnConfig falls back to `npx @openai/codex`
    // when no native `codex` binary is on PATH.
    return true;
  }

  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit", _crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
    // Store permissionMode for use in formatUserInput's turn/start params
    this.lastPermissionMode = permissionMode;
    return buildCodexAppServerSpawnConfig(this.detectBinary());
  }

  // ============ Task 5.5: parseStdoutLine — JSON-RPC message routing ============

  parseStdoutLine(line: string, sessionId: string): ParsedAgentEvent[] {
    const incoming = parseCodexLine(line);
    const state = this.getSessionState(sessionId);

    switch (incoming.kind) {
      case "error_response": {
        // Every request we send (initialize / thread/start / turn/start) is
        // turn-fatal on failure, so surface it as an error result.
        const reqMethod = state.pendingRequests.get(Number(incoming.id));
        state.pendingRequests.delete(Number(incoming.id));
        console.error(
          `[CodexProvider] JSON-RPC error response for ${reqMethod ?? "unknown request"} (id=${incoming.id}, session=${sessionId}): ${JSON.stringify(incoming.error)}`,
        );
        if (reqMethod === CODEX_CLIENT_METHODS.threadStart) {
          // The buffered first turn can never be flushed without a threadId
          state.pendingTurnContent = null;
        }
        const errText = typeof incoming.error?.message === "string" ? incoming.error.message : JSON.stringify(incoming.error);
        return [{
          type: "result",
          subtype: "error",
          error: `Codex ${reqMethod ?? "request"} failed: ${errText}`,
        }];
      }

      case "response": {
        const reqMethod = state.pendingRequests.get(Number(incoming.id));
        state.pendingRequests.delete(Number(incoming.id));
        const result = incoming.result as { thread?: { id?: string } } | undefined;
        if (reqMethod === CODEX_CLIENT_METHODS.threadStart && result?.thread?.id) {
          state.threadId = result.thread.id;
          // Send buffered first turn now that we have threadId
          if (state.pendingTurnContent !== null) {
            const content = state.pendingTurnContent;
            state.pendingTurnContent = null;
            const id = state.rpcIdCounter++;
            state.pendingRequests.set(id, CODEX_CLIENT_METHODS.turnStart);
            return [{ type: "stdin_write", content: buildTurnStart(id, state.threadId, content) }];
          }
        }
        return [];
      }

      case "server_request":
        return this.handleServerRequest(incoming.id, incoming.method, incoming.params);

      case "notification":
        return this.handleNotification(incoming.method, incoming.params, sessionId);

      case "ignored":
        return [];
    }
  }

  // ============ Notification routing ============

  private handleNotification(method: string, params: any, sessionId: string): ParsedAgentEvent[] {
    switch (method) {
      case CODEX_NOTIFICATIONS.itemCompleted:
        return this.handleItemCompleted(params, sessionId);
      case CODEX_NOTIFICATIONS.turnCompleted:
        return this.handleTurnCompleted(params, sessionId);
      case CODEX_NOTIFICATIONS.tokenUsageUpdated:
        return this.handleTokenUsage(params, sessionId);
      default:
        return [];
    }
  }

  // ============ Task 5.6: item/completed — ThreadItem parsing ============

  private handleItemCompleted(params: any, sessionId: string): ParsedAgentEvent[] {
    const item = params?.item;
    if (!item?.type) return [];

    switch (item.type) {
      case "agentMessage": {
        if (params?.turnId && (item.phase === "final_answer" || item.text)) {
          const state = this.getSessionState(sessionId);
          state.turnsWithFinalMessage.add(String(params.turnId));
        }
        return [{ type: "text", content: item.text ?? "" }];
      }

      case "reasoning": {
        const parts: string[] = item.summary ?? item.content ?? [];
        const text = parts.join("\n");
        if (!text) return [];
        return [{ type: "thinking", content: text }];
      }

      case "userMessage":
        // Codex echoes the user's input — already rendered by sendUserMessage, skip
        return [];

      case "commandExecution": {
        const id = item.id ?? this.generateId();
        return [
          { type: "tool_use", tool: "Bash", input: { command: item.command }, toolUseId: id },
          { type: "tool_result", tool: "Bash", output: item.aggregatedOutput ?? "", toolUseId: id },
        ];
      }

      case "fileChange": {
        const id = item.id ?? this.generateId();
        const changes = (item.changes ?? []).map((c: any) => ({
          path: c.path,
          diff: c.diff,
          kind: typeof c.kind === "object" ? c.kind.type : String(c.kind),
        }));
        return [
          { type: "tool_use", tool: "FileChange", input: { changes }, toolUseId: id },
          { type: "tool_result", tool: "FileChange", output: item.status ?? "completed", toolUseId: id },
        ];
      }

      case "plan":
        return [{ type: "text", content: item.text ?? "" }];

      case "webSearch": {
        const id = item.id ?? this.generateId();
        return [{ type: "tool_use", tool: "WebSearch", input: { query: item.query }, toolUseId: id }];
      }

      case "mcpToolCall": {
        const id = item.id ?? this.generateId();
        const toolName = item.tool ?? "MCP";
        const output = item.error?.message ?? (item.result ? JSON.stringify(item.result) : "");
        return [
          { type: "tool_use", tool: toolName, input: item.arguments, toolUseId: id },
          { type: "tool_result", tool: toolName, output, toolUseId: id },
        ];
      }

      case "collabAgentToolCall": {
        const id = item.id ?? this.generateId();
        return [
          { type: "tool_use", tool: "Agent", input: { tool: item.tool, prompt: item.prompt }, toolUseId: id },
        ];
      }

      default:
        // imageView, contextCompaction, enteredReviewMode, exitedReviewMode, dynamicToolCall, etc.
        return [{ type: "system", content: `[${item.type}]` }];
    }
  }

  // ============ Task 5.7: turn/completed ============

  private handleTurnCompleted(params: any, sessionId: string): ParsedAgentEvent[] {
    const turn = params?.turn;
    if (!turn) return [];
    const state = this.getSessionState(sessionId);
    const turnId = turn.id == null ? null : String(turn.id);
    const hadFinalMessage = turnId != null && state.turnsWithFinalMessage.has(turnId);
    if (turnId != null) {
      state.turnsWithFinalMessage.delete(turnId);
    }

    if (turn.status === "completed" && !hadFinalMessage) {
      console.log(
        `[CodexProvider] turn/completed (turnId=${turnId}) suppressed — no final agentMessage seen this turn (session stays "running")`,
      );
      return [];
    }

    const result: ParsedAgentEvent = {
      type: "result",
      subtype: turn.status === "completed" ? "success" : "error",
      ...state?.lastTokenUsage,
    };
    if (turn.error?.message) {
      result.error = turn.error.message;
    }
    return [result];
  }

  // ============ Task 5.8: thread/tokenUsage/updated ============

  private handleTokenUsage(params: any, sessionId: string): ParsedAgentEvent[] {
    const usage = params?.tokenUsage;
    if (!usage) return [];
    const last = usage.last;
    if (!last) return [];
    const state = this.getSessionState(sessionId);
    state.lastTokenUsage = {
      input_tokens: last.inputTokens,
      output_tokens: last.outputTokens,
    };
    return [];
  }

  // ============ Task 5.9: Server requests (approvals) ============

  private handleServerRequest(id: string | number, method: string, params: any): ParsedAgentEvent[] {
    switch (method) {
      case CODEX_SERVER_REQUESTS.commandApproval:
        return [{
          type: "approval_request",
          requestType: "command",
          requestId: String(id),
          command: params?.command ?? "",
          cwd: params?.cwd,
        }];

      case CODEX_SERVER_REQUESTS.fileChangeApproval:
        return [{
          type: "approval_request",
          requestType: "fileChange",
          requestId: String(id),
          changes: params?.changes ?? [],
        }];

      case CODEX_SERVER_REQUESTS.userInput:
        return [{
          type: "tool_use",
          tool: "AskUserQuestion",
          input: { questions: params?.questions },
          toolUseId: String(id),
        }];

      default:
        return [];
    }
  }

  // ============ Pre-initialization: send initialize + thread/start right after spawn ============

  getInitializationMessages(sessionId: string): string | null {
    const state = this.getSessionState(sessionId);
    if (state.initialized) return null;

    const id1 = state.rpcIdCounter++;
    const id2 = state.rpcIdCounter++;
    state.pendingRequests.set(id1, CODEX_CLIENT_METHODS.initialize);
    state.pendingRequests.set(id2, CODEX_CLIENT_METHODS.threadStart);
    state.initialized = true;

    return buildInitialize(id1) + buildThreadStart(id2, state.permissionMode);
  }

  // ============ Task 5.10: formatUserInput — JSON-RPC message construction ============

  formatUserInput(content: string | ContentPart[], sessionId: string): string {
    const state = this.getSessionState(sessionId);
    // Sync permissionMode from last buildSpawnConfig call
    state.permissionMode = this.lastPermissionMode;

    // Fast path: threadId already available (pre-initialization completed)
    if (state.threadId) {
      const id = state.rpcIdCounter++;
      state.pendingRequests.set(id, CODEX_CLIENT_METHODS.turnStart);
      return buildTurnStart(id, state.threadId, content);
    }

    // Edge case: getInitializationMessages wasn't called (e.g. dormant session wake)
    if (!state.initialized) {
      const id1 = state.rpcIdCounter++;
      const id2 = state.rpcIdCounter++;
      state.pendingRequests.set(id1, CODEX_CLIENT_METHODS.initialize);
      state.pendingRequests.set(id2, CODEX_CLIENT_METHODS.threadStart);
      state.initialized = true;
      state.pendingTurnContent = content;
      return buildInitialize(id1) + buildThreadStart(id2, state.permissionMode);
    }

    // Initialized but threadId not yet available (race: user sent message before thread/start responded)
    // Buffer content — will be sent when parseStdoutLine receives thread/start response
    if (state.pendingTurnContent !== null) {
      console.warn(
        `[CodexProvider] formatUserInput: overwriting previously buffered turn content for session ${sessionId} — thread/start response still missing`,
      );
    } else {
      console.warn(
        `[CodexProvider] formatUserInput: no threadId yet for session ${sessionId} — buffering turn content until thread/start responds`,
      );
    }
    state.pendingTurnContent = content;
    return "";
  }

  // ============ Task 5.11: formatApprovalResponse ============

  formatApprovalResponse(requestId: string, decision: string, _sessionId: string): string {
    return buildApprovalResponse(requestId, decision);
  }

  // ============ Interrupt (cancel current turn) ============

  formatInterrupt(sessionId: string): string | null {
    const state = this.getSessionState(sessionId);
    for (const [id, method] of state.pendingRequests) {
      if (method === CODEX_CLIENT_METHODS.turnStart) {
        return buildCancelRequest(id);
      }
    }
    return null;
  }

  // ============ Lifecycle hooks ============

  onSessionCreated(sessionId: string, permissionMode: "plan" | "edit" = "plan"): void {
    this.sessions.set(sessionId, {
      threadId: null,
      rpcIdCounter: 1,
      initialized: false,
      pendingRequests: new Map(),
      permissionMode,
      pendingTurnContent: null,
      lastTokenUsage: {},
      turnsWithFinalMessage: new Set(),
    });
  }

  onSessionDestroyed(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Get session state, creating default if missing (defensive). */
  getSessionState(sessionId: string): CodexSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        threadId: null,
        rpcIdCounter: 1,
        initialized: false,
        pendingRequests: new Map(),
        permissionMode: "plan",
        pendingTurnContent: null,
        lastTokenUsage: {},
        turnsWithFinalMessage: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private generateId(): string {
    return `codex-${++CodexProvider.idCounter}`;
  }
}
