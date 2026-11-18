import { z } from "zod";
import type { ContractItem } from "../contracts.js";

export const FX_BINARY_NAME = "fx";
export const FX_METHODS = {
  initialize: "initialize", newSession: "session/new",
  prompt: "session/prompt", cancel: "session/cancel", update: "session/update",
  permission: "session/request_permission",
} as const;
export const FxIdSchema = z.union([z.string(), z.number()]);
export const FxEnvelopeSchema = z.looseObject({
  jsonrpc: z.literal("2.0"), id: FxIdSchema.nullable().optional(),
  method: z.string().optional(), params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
export const FxInitializeResultSchema = z.looseObject({ protocolVersion: z.literal(1) });
export const FxNewResultSchema = z.looseObject({ sessionId: z.string().min(1), modes: z.looseObject({ currentModeId: z.string() }).optional() });
export const FxPromptResultSchema = z.looseObject({
  stopReason: z.string(),
  usage: z.looseObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
});
const textContent = z.looseObject({ type: z.literal("text"), text: z.string() });
const toolFields = {
  toolCallId: z.string(), name: z.string().optional(), rawInput: z.unknown().optional(),
  status: z.string().optional(), content: z.array(z.unknown()).optional(),
};
export const FxUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z.looseObject({ sessionUpdate: z.literal("agent_message_chunk"), content: textContent }),
  z.looseObject({ sessionUpdate: z.literal("agent_thought_chunk"), content: textContent }),
  z.looseObject({ sessionUpdate: z.literal("user_message_chunk"), content: z.unknown() }),
  z.looseObject({ sessionUpdate: z.literal("tool_call"), ...toolFields, name: z.string(), rawInput: z.unknown() }),
  z.looseObject({ sessionUpdate: z.literal("tool_call_update"), ...toolFields }),
  z.looseObject({ sessionUpdate: z.literal("usage_update"), used: z.number(), size: z.number() }),
  z.looseObject({ sessionUpdate: z.enum(["available_commands_update", "session_info_update", "current_mode_update", "config_option_update", "plan"]) }),
]);
export const FxUpdateParamsSchema = z.looseObject({ sessionId: z.string(), update: FxUpdateSchema });
export const FxPermissionParamsSchema = z.looseObject({
  sessionId: z.string(), toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.looseObject({ optionId: z.string(), kind: z.string() })),
});
export const FX_CONTRACTS: ContractItem[] = [
  ["FX-RPC-envelope", FxEnvelopeSchema], ["FX-RESP-initialize", FxInitializeResultSchema],
  ["FX-RESP-new", FxNewResultSchema], ["FX-RESP-prompt", FxPromptResultSchema],
  ["FX-NOTIF-update", FxUpdateParamsSchema], ["FX-REQ-permission", FxPermissionParamsSchema],
].map(([id, schema]) => ({ id: id as string, schema: schema as z.ZodType, consumers: ["src/providers/fx-provider.ts", "src/protocol/fx/codec.ts"] }));
