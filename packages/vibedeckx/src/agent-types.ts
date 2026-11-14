/**
 * Agent Session Types for Claude Code Integration
 */

// ============ Agent Type ============

/**
 * The single source of truth for which coding agents exist. Adding an agent
 * type means: add an entry here, implement its AgentProvider, and register it
 * in providers/index.ts. The type union, zod enums and request validation all
 * derive from this table.
 *
 * Each entry's value is the agent's CLI command name, used only for
 * diagnostics (e.g. `connect install` warning when it is not on PATH).
 */
const AGENT_TYPE_CLI = {
  "claude-code": "claude",
  codex: "codex",
} as const;

export type AgentType = keyof typeof AGENT_TYPE_CLI;

/** Every valid agent type, as a non-empty tuple (usable with `z.enum`). */
export const AGENT_TYPES = Object.keys(AGENT_TYPE_CLI) as [AgentType, ...AgentType[]];

/** Used when a request or stored row carries no agent type at all. */
export const DEFAULT_AGENT_TYPE: AgentType = "claude-code";

/** CLI command names of every agent type. */
export const AGENT_CLI_COMMANDS: readonly string[] = Object.values(AGENT_TYPE_CLI);

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AGENT_TYPE_CLI, value);
}

/**
 * Resolve a requested agent type: absent (undefined/null/"") falls back to
 * DEFAULT_AGENT_TYPE, a known type passes through, and an unknown non-empty
 * value yields null — callers must reject it rather than silently run Claude.
 */
export function resolveAgentType(value: unknown): AgentType | null {
  if (value === undefined || value === null || value === "") return DEFAULT_AGENT_TYPE;
  return isAgentType(value) ? value : null;
}

export function invalidAgentTypeMessage(field = "agentType"): string {
  return `${field} must be one of: ${AGENT_TYPES.join(", ")}`;
}

// ============ Content Part Types (for image attachments) ============

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mediaType: string; data: string }; // base64
export type ContentPart = TextPart | ImagePart;

// ============ Agent Message Types ============

/** Why a turn's turn_end marker was written. See endActiveTurn in agent-session-manager.ts. */
/**
 * `completed_with_pending_tasks` is a success: the agent answered, but
 * background tasks outlived the turn and the turn was closed on a deadline
 * rather than by them finishing. Kept distinct from `completed` so the divider
 * can say so — a turn that claims a clean finish while a task is still running
 * is the same lie this bound exists to end.
 */
export type TurnOutcome =
  | "completed"
  | "completed_with_pending_tasks"
  | "failed"
  | "stopped"
  | "process_exit"
  | "server_restart";

/**
 * Whether a turn's outcome is a user-facing attention milestone.
 *
 * - `result` — the turn's outcome IS the deliverable: emit
 *   `session_result_ready` / `session_failed`.
 * - `internal` — workflow plumbing or a helper step; never notifies.
 * - `milestone-managed` — a workflow owns this turn's attention event (a
 *   reviewer's completion becomes `review_ready`, not a second generic
 *   notification).
 * - `failures-only` — a workflow owns this turn's success (an unattended loop
 *   moves straight on to the next hop), but a failure still notifies: nothing
 *   downstream would report it.
 *
 * Decided when the turn STARTS and persisted on the opening user entry (then
 * copied to its `turn_end`) — deliberately not process-memory-only, because
 * crash repair and remote outbox generation must reach the same decision after
 * a restart. See docs/plans/2026-07-25-persistent-notification-milestones-design.md.
 */
export type NotificationDisposition = "result" | "internal" | "milestone-managed" | "failures-only";

export type AgentMessage =
  // origin marks machine-authored user turns (e.g. workflow-injected reviewer
  // prompts) so the UI can render them as markdown instead of verbatim text;
  // 'commander' marks what the Main Chat injects (events, nudges, results).
  | { type: 'user'; content: string | ContentPart[]; timestamp: number; origin?: 'workflow' | 'commander'; notificationDisposition?: NotificationDisposition; event?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number } }
  | { type: 'assistant'; content: string; partial?: boolean; agentType?: AgentType; timestamp: number }
  | { type: 'tool_use'; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: 'tool_result'; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'system'; content: string; timestamp: number }
  | { type: 'turn_end'; timestamp: number; durationMs?: number; outcome?: TurnOutcome; notificationDisposition?: NotificationDisposition }
  | { type: 'approval_request'; requestType: 'command' | 'fileChange'; requestId: string; command?: string; cwd?: string; changes?: Array<{path: string; diff?: string; kind: string}>; timestamp: number }
  | { type: 'tool_approval_request'; tool: string; input: unknown; approvalId: string; resolved?: 'approved' | 'denied'; timestamp: number };

// ============ Claude Code JSON Protocol Types ============
// Moved to the protocol layer; re-exported here so existing imports keep working.
export type {
  ClaudeOutputMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeSystemMessage,
  ClaudeResultMessage,
  ClaudeUnknownMessage,
  ClaudeContentBlock,
  ClaudeImageBlock,
  ClaudeUserInput,
} from "./protocol/claude-code/schema.js";

// ============ Agent Session Types ============

export type AgentSessionStatus = 'running' | 'stopped' | 'error';

export interface AgentSession {
  id: string;
  project_id: string;
  branch: string;
  status: AgentSessionStatus;
  created_at: string;
}

// ============ WebSocket Message Types ============

// AgentWsMessage is now defined in conversation-patch.ts using JSON Patch format
// Re-export for convenience
export type { AgentWsMessage, Patch, PatchEntry, PatchValue } from './conversation-patch.js';

export interface AgentWsInput {
  type: 'user_message';
  content: string | ContentPart[];
}
