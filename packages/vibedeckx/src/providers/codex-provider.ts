import { execFileSync } from "child_process";
import type { AgentType } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";

interface CodexSessionState {
  threadId: string | null;
  rpcIdCounter: number;
  initialized: boolean;
  pendingRequests: Map<number, string>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class CodexProvider implements AgentProvider {
  private binaryPath: string | null | undefined = undefined;
  private sessions = new Map<string, CodexSessionState>();
  private static idCounter = 0;

  getAgentType(): AgentType {
    return "codex";
  }

  getDisplayName(): string {
    return "Codex";
  }

  detectBinary(): string | null {
    if (this.binaryPath !== undefined) {
      return this.binaryPath;
    }
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(cmd, ["codex"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      this.binaryPath = result || null;
      console.log(`[CodexProvider] Native codex binary found: ${result}`);
    } catch {
      this.binaryPath = null;
      console.log(`[CodexProvider] Native codex binary not found, will use npx`);
    }
    return this.binaryPath;
  }

  buildSpawnConfig(_cwd: string, _permissionMode: "plan" | "edit"): SpawnConfig {
    const nativeBinary = this.detectBinary();
    if (nativeBinary) {
      return { command: nativeBinary, args: ["app-server"], shell: false };
    }
    return {
      command: "npx",
      args: ["-y", "@openai/codex", "app-server"],
      shell: false,
    };
  }

  // ============ Task 5.5: parseStdoutLine — JSON-RPC message routing ============

  parseStdoutLine(line: string, sessionId: string): ParsedAgentEvent[] {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }

    const state = this.getSessionState(sessionId);

    // (a) Response: has id + result, no method
    if (msg.id != null && !msg.method && msg.result !== undefined) {
      const reqMethod = state.pendingRequests.get(Number(msg.id));
      state.pendingRequests.delete(Number(msg.id));
      // Extract threadId from thread/start response
      if (reqMethod === "thread/start" && msg.result?.thread?.id) {
        state.threadId = msg.result.thread.id;
      }
      return [];
    }

    // (c) Server request: has id + method (check before notifications since both have method)
    if (msg.id != null && msg.method) {
      return this.handleServerRequest(msg);
    }

    // (b) Notification: has method, no id
    if (msg.method) {
      return this.handleNotification(msg);
    }

    return [];
  }

  // ============ Notification routing ============

  private handleNotification(msg: any): ParsedAgentEvent[] {
    const params = msg.params;
    switch (msg.method) {
      case "item/completed":
        return this.handleItemCompleted(params?.item);
      case "turn/completed":
        return this.handleTurnCompleted(params);
      case "thread/tokenUsage/updated":
        return this.handleTokenUsage(params);
      default:
        return [];
    }
  }

  // ============ Task 5.6: item/completed — ThreadItem parsing ============

  private handleItemCompleted(item: any): ParsedAgentEvent[] {
    if (!item?.type) return [];

    switch (item.type) {
      case "agentMessage":
        return [{ type: "text", content: item.text ?? "" }];

      case "reasoning": {
        const parts: string[] = item.summary ?? item.content ?? [];
        return [{ type: "thinking", content: parts.join("\n") }];
      }

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

  private handleTurnCompleted(params: any): ParsedAgentEvent[] {
    const turn = params?.turn;
    if (!turn) return [];
    return [{
      type: "result",
      subtype: turn.status === "completed" ? "success" : "error",
      error: turn.error?.message,
    }];
  }

  // ============ Task 5.8: thread/tokenUsage/updated ============

  private handleTokenUsage(params: any): ParsedAgentEvent[] {
    const usage = params?.tokenUsage;
    if (!usage) return [];
    const last = usage.last;
    if (!last) return [];
    return [{
      type: "result",
      subtype: "success",
      input_tokens: last.inputTokens,
      output_tokens: last.outputTokens,
    }];
  }

  // ============ Task 5.9: Server requests (approvals) ============

  private handleServerRequest(msg: any): ParsedAgentEvent[] {
    const params = msg.params;
    switch (msg.method) {
      case "item/commandExecution/requestApproval":
        return [{
          type: "approval_request",
          requestType: "command",
          requestId: String(msg.id),
          command: params?.command ?? "",
          cwd: params?.cwd,
        }];

      case "item/fileChange/requestApproval":
        return [{
          type: "approval_request",
          requestType: "fileChange",
          requestId: String(msg.id),
          changes: params?.changes ?? [],
        }];

      case "item/tool/requestUserInput":
        return [{
          type: "tool_use",
          tool: "AskUserQuestion",
          input: { questions: params?.questions },
          toolUseId: String(msg.id),
        }];

      default:
        return [];
    }
  }

  // ============ Stubs for tasks 5.10-5.12 ============

  formatUserInput(_content: string, _sessionId: string): string {
    // Stub — implemented in task 5.10
    return "";
  }

  formatApprovalResponse(_requestId: string, _decision: string, _sessionId: string): string {
    // Stub — implemented in task 5.11
    return "";
  }

  // ============ Lifecycle hooks ============

  onSessionCreated(sessionId: string): void {
    this.sessions.set(sessionId, {
      threadId: null,
      rpcIdCounter: 1,
      initialized: false,
      pendingRequests: new Map(),
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
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private generateId(): string {
    return `codex-${++CodexProvider.idCounter}`;
  }
}
