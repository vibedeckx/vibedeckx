/**
 * Agent Session Types for Claude Code Integration
 */

// ============ Agent Type ============

export type AgentType = "claude-code" | "codex";

// ============ Content Part Types (for image attachments) ============

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mediaType: string; data: string }; // base64
export type ContentPart = TextPart | ImagePart;

// ============ Agent Message Types ============

/** Why a turn's turn_end marker was written. See endActiveTurn in agent-session-manager.ts. */
export type TurnOutcome = "completed" | "failed" | "stopped" | "process_exit" | "server_restart";

export type AgentMessage =
  // origin marks machine-authored user turns (e.g. workflow-injected reviewer
  // prompts) so the UI can render them as markdown instead of verbatim text.
  | { type: 'user'; content: string | ContentPart[]; timestamp: number; origin?: 'workflow'; event?: { kind: "agent_task_completed"; sessionId: string; turnEndEntryIndex: number } }
  | { type: 'assistant'; content: string; partial?: boolean; agentType?: AgentType; timestamp: number }
  | { type: 'tool_use'; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: 'tool_result'; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'system'; content: string; timestamp: number }
  | { type: 'turn_end'; timestamp: number; durationMs?: number; outcome?: TurnOutcome }
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
