/**
 * Codex app-server protocol contract (JSON-RPC 2.0 over stdio, newline-
 * delimited). Single source of truth for every message shape and method
 * name vibedeckx depends on. Objects are loose (unknown fields pass) so the
 * runtime tolerates upstream additions; compat tests flag them as WARN.
 */
import { z } from "zod";
import type { ContractItem } from "../contracts.js";

export const CODEX_BINARY_NAME = "codex";
export const CODEX_NPM_PACKAGE = "@openai/codex";

// ---- Method names ----

export const CODEX_CLIENT_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  turnStart: "turn/start",
  // Interrupting an in-flight turn. NOT LSP-style `$/cancelRequest` — that is
  // inert against real codex (verified live, 0.144.1): turn/start's JSON-RPC
  // response returns immediately with an in-progress Turn, so there is no
  // pending call left to cancel. The real abort primitive is a distinct
  // request, `turn/interrupt` with params `{ threadId, turnId }` (turn UUID,
  // not the JSON-RPC id), per `codex app-server generate-json-schema`.
  turnInterrupt: "turn/interrupt",
} as const;

export const CODEX_NOTIFICATIONS = {
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed",
  tokenUsageUpdated: "thread/tokenUsage/updated",
} as const;

export const CODEX_SERVER_REQUESTS = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  userInput: "item/tool/requestUserInput",
} as const;

// ---- Enums used in thread/start params ----

export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export const AskForApprovalSchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type AskForApproval = z.infer<typeof AskForApprovalSchema>;

// ---- thread/start response ----

export const ThreadStartResultSchema = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
});

// ---- Thread items (item/completed) ----

const idish = z.union([z.string(), z.number()]);

export const AgentMessageItemSchema = z.looseObject({
  type: z.literal("agentMessage"),
  id: idish.optional(),
  text: z.string().optional(),
  phase: z.string().optional(),
});

export const ReasoningItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  summary: z.array(z.string()).optional(),
  content: z.array(z.string()).optional(),
});

export const UserMessageItemSchema = z.looseObject({
  type: z.literal("userMessage"),
});

export const CommandExecutionItemSchema = z.looseObject({
  type: z.literal("commandExecution"),
  id: idish.optional(),
  command: z.string(),
  // Real codex (verified live, 0.144.1) sends an explicit `"aggregatedOutput": null`
  // when the executed command produced no stdout, rather than omitting the field.
  aggregatedOutput: z.string().nullable().optional(),
  status: z.string().optional(),
});

export const FileChangeSchema = z.looseObject({
  path: z.string(),
  diff: z.string().optional(),
  kind: z.union([z.string(), z.looseObject({ type: z.string() })]).optional(),
});

export const FileChangeItemSchema = z.looseObject({
  type: z.literal("fileChange"),
  id: idish.optional(),
  changes: z.array(FileChangeSchema).optional(),
  status: z.string().optional(),
});

export const PlanItemSchema = z.looseObject({
  type: z.literal("plan"),
  text: z.string().optional(),
});

export const WebSearchItemSchema = z.looseObject({
  type: z.literal("webSearch"),
  id: idish.optional(),
  query: z.string().optional(),
});

export const McpToolCallItemSchema = z.looseObject({
  type: z.literal("mcpToolCall"),
  id: idish.optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

export const CollabAgentToolCallItemSchema = z.looseObject({
  type: z.literal("collabAgentToolCall"),
  id: idish.optional(),
  tool: z.string().optional(),
  prompt: z.string().optional(),
});

export const KnownThreadItemSchema = z.discriminatedUnion("type", [
  AgentMessageItemSchema,
  ReasoningItemSchema,
  UserMessageItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  PlanItemSchema,
  WebSearchItemSchema,
  McpToolCallItemSchema,
  CollabAgentToolCallItemSchema,
]);

// ---- Notification params ----

export const ItemCompletedParamsSchema = z.looseObject({
  turnId: idish.optional(),
  item: z.looseObject({ type: z.string() }),
});

export const TurnCompletedParamsSchema = z.looseObject({
  turn: z.looseObject({
    id: idish.optional(),
    status: z.string().optional(),
    // Real codex (verified live, 0.144.1) sends an explicit `"error": null` on
    // successful turns rather than omitting the field.
    error: z.looseObject({ message: z.string().optional() }).nullable().optional(),
  }),
});

export const TokenUsageParamsSchema = z.looseObject({
  tokenUsage: z.looseObject({
    last: z
      .looseObject({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .optional(),
  }),
});

// ---- Server request params (approvals) ----

export const CommandApprovalParamsSchema = z.looseObject({
  command: z.string().optional(),
  cwd: z.string().optional(),
});

export const FileChangeApprovalParamsSchema = z.looseObject({
  changes: z.array(FileChangeSchema).optional(),
});

export const UserInputParamsSchema = z.looseObject({
  questions: z.unknown().optional(),
});

// ---- Contract registry ----

export const CODEX_CONTRACTS: ContractItem[] = [
  { id: "CX-RESP-thread_start", schema: ThreadStartResultSchema, consumers: ["src/providers/codex-provider.ts parseStdoutLine"] },
  { id: "CX-NOTIF-item_completed", schema: ItemCompletedParamsSchema, consumers: ["src/providers/codex-provider.ts handleItemCompleted"] },
  { id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: ["src/providers/codex-provider.ts handleItemCompleted"] },
  { id: "CX-NOTIF-turn_completed", schema: TurnCompletedParamsSchema, consumers: ["src/providers/codex-provider.ts handleTurnCompleted"] },
  { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema, consumers: ["src/providers/codex-provider.ts handleTokenUsage"] },
  { id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest", "apps/vibedeckx-ui/components/agent/approval-request.tsx"] },
  { id: "CX-REQ-file_change_approval", schema: FileChangeApprovalParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest"] },
  { id: "CX-REQ-user_input", schema: UserInputParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest", "apps/vibedeckx-ui/components/agent/ask-user-question.tsx"] },
];
