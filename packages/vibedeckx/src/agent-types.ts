/**
 * Agent Session Types for Claude Code Integration
 */

// ============ Agent Type ============

export type AgentType = "claude-code" | "codex";

// ============ Agent Message Types ============

export type AgentMessage =
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'assistant'; content: string; partial?: boolean; timestamp: number }
  | { type: 'tool_use'; tool: string; input: unknown; toolUseId?: string; timestamp: number }
  | { type: 'tool_result'; tool: string; output: string; toolUseId?: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'system'; content: string; timestamp: number }
  | { type: 'approval_request'; requestType: 'command' | 'fileChange'; requestId: string; command?: string; cwd?: string; changes?: Array<{path: string; diff?: string; kind: string}>; timestamp: number };

// ============ Claude Code JSON Protocol Types ============

/**
 * Messages from Claude Code stdout (stream-json format)
 */
export type ClaudeOutputMessage =
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeSystemMessage
  | ClaudeResultMessage
  | ClaudeUnknownMessage;

export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  session_id: string;
}

export interface ClaudeUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ClaudeContentBlock[];
  };
  session_id: string;
}

export interface ClaudeSystemMessage {
  type: 'system';
  subtype: string;
  message?: string;
  session_id?: string;
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  duration_ms?: number;
  duration_api_ms?: number;
  cost_usd?: number;
  session_id?: string;
  error?: string;
}

export interface ClaudeUnknownMessage {
  type: string;
  [key: string]: unknown;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown }
  | { type: 'thinking'; thinking: string };

// ============ Messages to Claude Code stdin ============

export interface ClaudeUserInput {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

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
  content: string;
}
