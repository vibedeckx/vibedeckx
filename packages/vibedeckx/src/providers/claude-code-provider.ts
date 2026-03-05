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
    // TODO: task 2.2 — extract from agent-session-manager.ts
    return null;
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
