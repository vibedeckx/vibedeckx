import { execFileSync } from "child_process";
import type { AgentType, ContentPart } from "../agent-types.js";
import type { ClaudeOutputMessage, ClaudeContentBlock } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";

export class ClaudeCodeProvider implements AgentProvider {
  private binaryPath: string | null | undefined = undefined;

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
    if (this.binaryPath !== undefined) {
      return this.binaryPath;
    }
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(cmd, ["claude"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      this.binaryPath = result || null;
      console.log(`[ClaudeCodeProvider] Native claude binary found: ${result}`);
    } catch {
      this.binaryPath = null;
      console.log(`[ClaudeCodeProvider] Native claude binary not found, will use npx`);
    }
    return this.binaryPath;
  }

  isAvailable(): boolean {
    // Always runnable: buildSpawnConfig falls back to `npx @anthropic-ai/claude-code`
    // when no native `claude` binary is on PATH.
    return true;
  }

  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit"): SpawnConfig {
    const nativeBinary = this.detectBinary();

    const permissionFlag = permissionMode === "plan"
      ? "--permission-mode=plan"
      : "--dangerously-skip-permissions";

    const claudeArgs = [
      "--output-format=stream-json",
      "--input-format=stream-json",
      permissionFlag,
      // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
      // internally as "dismissed" before we can present a picker and wait for the
      // user. Disable it so the agent falls back to asking in plain text, which the
      // user answers through the normal conversation input.
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
    ];

    if (nativeBinary) {
      return { command: nativeBinary, args: claudeArgs };
    }
    return {
      command: "npx",
      args: ["-y", "@anthropic-ai/claude-code", ...claudeArgs],
    };
  }

  parseStdoutLine(line: string, _sessionId: string): ParsedAgentEvent[] {
    let msg: ClaudeOutputMessage;
    try {
      msg = JSON.parse(line) as ClaudeOutputMessage;
    } catch {
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
      if (systemMsg.subtype === "task_started" && systemMsg.task_id) {
        return [{
          type: "task_started",
          taskId: systemMsg.task_id,
          taskType: systemMsg.task_type,
          description: systemMsg.description,
        }];
      }
      if (systemMsg.subtype === "task_notification" && systemMsg.task_id) {
        return [{ type: "task_finished", taskId: systemMsg.task_id, status: systemMsg.status }];
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
    if (typeof content === "string") {
      return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    }
    // Map ContentPart[] to Claude's content block format
    const blocks = content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      return { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } };
    });
    return JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
  }

  // Lifecycle hooks are no-ops for Claude (stateless per-session)
  onSessionCreated(_sessionId: string, _permissionMode?: "plan" | "edit"): void {}
  onSessionDestroyed(_sessionId: string): void {}
}
