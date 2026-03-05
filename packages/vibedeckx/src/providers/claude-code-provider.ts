import { execFileSync } from "child_process";
import type { AgentType } from "../agent-types.js";
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

  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit"): SpawnConfig {
    const nativeBinary = this.detectBinary();

    const permissionFlag = permissionMode === "plan"
      ? "--permission-mode=plan"
      : "--dangerously-skip-permissions";

    const claudeArgs = [
      "-p",
      "--output-format=stream-json",
      "--input-format=stream-json",
      permissionFlag,
      "--verbose",
    ];

    if (nativeBinary) {
      return { command: nativeBinary, args: claudeArgs, shell: true };
    }
    return {
      command: "npx",
      args: ["-y", "@anthropic-ai/claude-code", ...claudeArgs],
      shell: true,
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
      const systemMsg = msg as { type: "system"; message?: string };
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

  formatUserInput(content: string, _sessionId: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  }

  // Lifecycle hooks are no-ops for Claude (stateless per-session)
  onSessionCreated(_sessionId: string): void {}
  onSessionDestroyed(_sessionId: string): void {}
}
