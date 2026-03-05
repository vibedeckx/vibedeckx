import { execFileSync } from "child_process";
import type { AgentType } from "../agent-types.js";
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

  buildSpawnConfig(_cwd: string, _permissionMode: "plan" | "edit"): SpawnConfig {
    // TODO: task 2.3 — extract from agent-session-manager.ts
    return { command: "claude", args: [], shell: true };
  }

  parseStdoutLine(_line: string, _sessionId: string): ParsedAgentEvent[] {
    // TODO: task 2.4 — extract from agent-session-manager.ts
    return [];
  }

  formatUserInput(_content: string, _sessionId: string): string {
    // TODO: task 2.5
    return "";
  }

  // Lifecycle hooks are no-ops for Claude (stateless per-session)
  onSessionCreated(_sessionId: string): void {}
  onSessionDestroyed(_sessionId: string): void {}
}
