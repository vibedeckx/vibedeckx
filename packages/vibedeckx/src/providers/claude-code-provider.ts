import type { AgentType, ContentPart } from "../agent-types.js";
import type { ClaudeOutputMessage, ClaudeContentBlock } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";
import { buildMcpConfigArg, type CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { detectBinary } from "../protocol/shared/binary.js";
import { parseClaudeLine, serializeUserInput } from "../protocol/claude-code/codec.js";
import { buildClaudeSessionSpawnConfig } from "../protocol/claude-code/cli.js";
import {
  CLAUDE_BINARY_NAME,
  TASK_NOTIFICATION_SUBTYPE,
  TASK_STARTED_SUBTYPE,
  TASK_UPDATED_SUBTYPE,
  TERMINAL_TASK_STATUSES,
} from "../protocol/claude-code/schema.js";

export class ClaudeCodeProvider implements AgentProvider {
  getAgentType(): AgentType {
    return "claude-code";
  }

  getDisplayName(): string {
    return "Claude Code";
  }

  getInstallHint(): string {
    return "Claude Code doesn't seem to be installed. Install it with `npm i -g @anthropic-ai/claude-code`, or make sure the `claude` binary is on your PATH. (It also runs via `npx`, which requires network access on first use.)";
  }

  detectBinary(): string | null {
    return detectBinary(CLAUDE_BINARY_NAME);
  }

  isAvailable(): boolean {
    // Always runnable: buildSpawnConfig falls back to `npx @anthropic-ai/claude-code`
    // when no native `claude` binary is on PATH.
    return true;
  }

  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
    return buildClaudeSessionSpawnConfig(
      this.detectBinary(),
      permissionMode,
      crossRemoteMcp ? buildMcpConfigArg(crossRemoteMcp) : undefined,
    );
  }

  parseStdoutLine(line: string, _sessionId: string): ParsedAgentEvent[] {
    const msg = parseClaudeLine(line);
    if (!msg) {
      return [];
    }

    if (msg.type === "user") {
      return [];
    }

    if (msg.type === "assistant") {
      const content = (msg as { type: "assistant"; message?: { content?: ClaudeContentBlock[] } }).message?.content;
      if (!content) return [];
      const events: ParsedAgentEvent[] = [];
      for (const block of content) {
        switch (block.type) {
          case "text":
            events.push({ type: "text", content: block.text });
            break;
          case "tool_use":
            events.push({ type: "tool_use", tool: block.name, input: block.input, toolUseId: block.id });
            break;
          case "tool_result":
            events.push({
              type: "tool_result",
              tool: "",
              output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
              toolUseId: block.tool_use_id,
            });
            break;
          case "thinking":
            events.push({ type: "thinking", content: block.thinking });
            break;
        }
      }
      return events;
    }

    if (msg.type === "system") {
      const systemMsg = msg as {
        type: "system";
        subtype?: string;
        message?: string;
        task_id?: string;
        task_type?: string;
        description?: string;
        status?: string;
      };
      // Background-task lifecycle events (`--verbose` stream-json). task_started
      // fires when the agent launches background work (task_type "local_agent"
      // for background subagents, "local_bash" for background commands);
      // task_notification fires when it finishes — right before the harness
      // auto-resumes the main agent. These feed the session manager's pending-
      // background-task ledger, which defers completion handling on `result`.
      if (systemMsg.subtype === TASK_STARTED_SUBTYPE && systemMsg.task_id) {
        return [{
          type: "task_started",
          taskId: systemMsg.task_id,
          taskType: systemMsg.task_type,
          description: systemMsg.description,
        }];
      }
      if (systemMsg.subtype === TASK_NOTIFICATION_SUBTYPE && systemMsg.task_id) {
        return [{ type: "task_finished", taskId: systemMsg.task_id, status: systemMsg.status }];
      }
      // Redundant clear channel: task_updated with a terminal patch.status
      // fires alongside task_notification for the same task. The ledger is a
      // Set (idempotent delete), so parsing both means a future rename of
      // either event name alone can't wedge the ledger.
      if (systemMsg.subtype === TASK_UPDATED_SUBTYPE && systemMsg.task_id) {
        const patchStatus = (msg as { patch?: { status?: string } }).patch?.status;
        if (patchStatus && (TERMINAL_TASK_STATUSES as readonly string[]).includes(patchStatus)) {
          return [{ type: "task_finished", taskId: systemMsg.task_id, status: patchStatus }];
        }
        return [];
      }
      if (systemMsg.message) {
        return [{ type: "system", content: systemMsg.message }];
      }
      return [];
    }

    if (msg.type === "result") {
      const resultMsg = msg as { type: "result"; subtype?: string; error?: string; duration_ms?: number; cost_usd?: number };
      const events: ParsedAgentEvent[] = [];
      if (resultMsg.subtype === "error" && resultMsg.error) {
        events.push({ type: "error", message: resultMsg.error });
      }
      events.push({
        type: "result",
        subtype: resultMsg.subtype === "error" ? "error" : "success",
        error: resultMsg.error,
        duration_ms: resultMsg.duration_ms,
        cost_usd: resultMsg.cost_usd,
      });
      return events;
    }

    return [];
  }

  formatUserInput(content: string | ContentPart[], _sessionId: string): string {
    return serializeUserInput(content);
  }

  // Lifecycle hooks are no-ops for Claude (stateless per-session)
  onSessionCreated(_sessionId: string, _permissionMode?: "plan" | "edit"): void {}
  onSessionDestroyed(_sessionId: string): void {}
}
