/**
 * Claude Code stream-json protocol contract. Single source of truth for the
 * stdout message shapes, stdin input format, system-event subtypes, and tool
 * names vibedeckx depends on. Objects are loose (unknown fields pass) so the
 * runtime tolerates upstream additions; compat tests flag them as WARN.
 */
import { z } from "zod";
import type { ContractItem } from "../contracts.js";

export const CLAUDE_BINARY_NAME = "claude";
export const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

// ---- Background-task lifecycle (system subtypes; require --verbose) ----
// task_started fires when the agent launches background work (task_type
// "local_agent" for background subagents, "local_bash" for background
// commands); task_notification fires when it finishes — right before the
// harness auto-resumes the main agent. task_updated with a terminal
// patch.status is a redundant clear channel. These feed the session
// manager's pending-background-task ledger.

export const TASK_STARTED_SUBTYPE = "task_started";
export const TASK_NOTIFICATION_SUBTYPE = "task_notification";
export const TASK_UPDATED_SUBTYPE = "task_updated";
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "canceled", "killed", "error"] as const;

/**
 * Tool names the frontend renders with dedicated UIs
 * (apps/vibedeckx-ui/components/agent/agent-message.tsx). A rename upstream
 * degrades those tools to the generic JSON renderer — the live compat probes
 * assert emitted tool names stay within this list.
 */
export const FRONTEND_RENDERED_TOOLS = [
  "AskUserQuestion",
  "ExitPlanMode",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "TaskOutput",
  "WebFetch",
  "WebSearch",
  "Skill",
  "FileChange",
] as const;

// ---- Content blocks ----

export const ClaudeContentBlockSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.looseObject({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.unknown() }),
  z.looseObject({ type: z.literal("thinking"), thinking: z.string() }),
]);

// ---- Stdout messages ----

export const ClaudeAssistantMessageSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string() })),
  }),
  session_id: z.string().optional(),
});

export const ClaudeUserMessageSchema = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.unknown(),
  }),
  session_id: z.string().optional(),
});

export const ClaudeSystemMessageSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.string().optional(),
  message: z.string().optional(),
  task_id: z.string().optional(),
  task_type: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  patch: z.looseObject({ status: z.string().optional() }).optional(),
  session_id: z.string().optional(),
});

export const ClaudeResultMessageSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string().optional(),
  error: z.string().optional(),
  result: z.string().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  session_id: z.string().optional(),
});

// ---- Inferred TS types (keep the historical names from agent-types.ts) ----

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown }
  | { type: "thinking"; thinking: string };

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  session_id: string;
}

export interface ClaudeUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ClaudeContentBlock[];
  };
  session_id: string;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  message?: string;
  session_id?: string;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
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

export type ClaudeOutputMessage =
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeSystemMessage
  | ClaudeResultMessage
  | ClaudeUnknownMessage;

export type ClaudeImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeUserInput {
  type: "user";
  message: {
    role: "user";
    content: string | (ClaudeContentBlock | ClaudeImageBlock)[];
  };
}

// ---- Contract registry ----

export const CLAUDE_CONTRACTS: ContractItem[] = [
  { id: "CC-OUT-assistant", schema: ClaudeAssistantMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/process-manager.ts startClaudeStreamProcess"] },
  { id: "CC-OUT-system", schema: ClaudeSystemMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/agent-session-manager.ts background-task ledger"] },
  { id: "CC-OUT-result", schema: ClaudeResultMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/process-manager.ts startClaudeStreamProcess"] },
  { id: "CC-OUT-content_blocks", schema: ClaudeContentBlockSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "apps/vibedeckx-ui/components/agent/agent-message.tsx"] },
];
