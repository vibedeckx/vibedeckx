/**
 * Agent Provider Interface
 *
 * Defines the contract that all agent providers must implement.
 * Providers handle agent-specific logic: binary detection, spawn config,
 * stdout parsing, and stdin formatting.
 */

import type { AgentType } from "./agent-types.js";
export type { AgentType };

// ============ SpawnConfig (task 1.3) ============

export interface SpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  shell?: boolean;
}

// ============ ParsedAgentEvent (task 1.2) ============

export type ParsedAgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId: string }
  | { type: "tool_result"; tool: string; output: string; toolUseId: string }
  | { type: "thinking"; content: string }
  | { type: "system"; content: string }
  | { type: "error"; message: string }
  | { type: "result"; subtype: "success" | "error"; error?: string; duration_ms?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number }
  | { type: "approval_request"; requestType: "command"; requestId: string; command: string; cwd?: string }
  | { type: "approval_request"; requestType: "fileChange"; requestId: string; changes: Array<{path: string; diff?: string; kind: string}> };

// ============ AgentProvider Interface (task 1.1) ============

export interface AgentProvider {
  /** Detect the agent binary on the system. Returns path or null if not found. */
  detectBinary(): string | null;

  /** Build the spawn configuration for launching the agent process. */
  buildSpawnConfig(cwd: string, permissionMode: "plan" | "edit"): SpawnConfig;

  /** Parse a single stdout line into zero or more agent events. */
  parseStdoutLine(line: string, sessionId: string): ParsedAgentEvent[];

  /** Format user input for writing to the agent's stdin. */
  formatUserInput(content: string, sessionId: string): string;

  /** Format an approval response (optional — only needed for agents with approval flow). */
  formatApprovalResponse?(requestId: string, decision: string, sessionId: string): string;

  /** Called when a new session is created for this agent type. */
  onSessionCreated?(sessionId: string): void;

  /** Called when a session is destroyed/deleted for this agent type. */
  onSessionDestroyed?(sessionId: string): void;

  /** Human-readable display name for this agent. */
  getDisplayName(): string;

  /** The agent type identifier. */
  getAgentType(): AgentType;
}
