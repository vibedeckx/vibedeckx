import type { ContentPart } from "../../agent-types.js";
import { FX_METHODS, FxEnvelopeSchema, FxUpdateParamsSchema, FxUpdateSchema, FxPermissionParamsSchema } from "./schema.js";

export interface FxSessionOptions { cwd: string; systemPrompt?: string }
export type FxIncoming =
  | { kind: "response"; id: string | number; result: unknown }
  | { kind: "error_response"; id: string | number | null; message: string }
  | { kind: "update"; params: ReturnType<typeof FxUpdateParamsSchema.parse> }
  | { kind: "permission"; id: string | number; params: ReturnType<typeof FxPermissionParamsSchema.parse> }
  | { kind: "server_request"; id: string | number }
  | { kind: "ignored" }
  | { kind: "invalid"; message: string };

export function parseFxLine(line: string): FxIncoming {
  try {
    const msg = FxEnvelopeSchema.parse(JSON.parse(line));
    // The server has an independent id namespace: route methods BEFORE responses.
    if (msg.method) {
      if (msg.id != null) {
        if (msg.method === FX_METHODS.permission) return { kind: "permission", id: msg.id, params: FxPermissionParamsSchema.parse(msg.params) };
        return { kind: "server_request", id: msg.id };
      }
      if (msg.method === FX_METHODS.update) {
        const params = msg.params as { sessionId?: unknown; update?: { sessionUpdate?: unknown } } | null;
        const kind = params?.update?.sessionUpdate;
        const knownKind = FxUpdateSchema.options.some(option => option.shape.sessionUpdate.safeParse(kind).success);
        if (typeof params?.sessionId === "string" && typeof kind === "string" && !knownKind) return { kind: "ignored" };
        return { kind: "update", params: FxUpdateParamsSchema.parse(msg.params) };
      }
      return { kind: "ignored" };
    }
    if (msg.error) return { kind: "error_response", id: msg.id ?? null, message: `${msg.error.code}: ${msg.error.message}` };
    if (msg.id != null && "result" in msg) return { kind: "response", id: msg.id, result: msg.result };
    return { kind: "invalid", message: "Invalid fx JSON-RPC envelope" };
  } catch {
    // Do not echo malformed payloads: they may contain credentials or images.
    return { kind: "invalid", message: "Invalid fx ACP message (malformed JSON or protocol payload)" };
  }
}
function line(payload: Record<string, unknown>): string { return JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n"; }
export function buildInitialize(id: number): string {
  return line({ id, method: FX_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "vibedeckx", version: "1" } } });
}
export function buildSessionNew(id: number, options: FxSessionOptions): string {
  return line({ id, method: FX_METHODS.newSession, params: {
    cwd: options.cwd, mcpServers: [],
    ...(options.systemPrompt?.trim() ? { systemPrompt: [{ type: "text", text: options.systemPrompt }], systemPromptMode: "append" } : {}),
  } });
}
export function buildSetMode(id: number, sessionId: string): string {
  return line({ id, method: FX_METHODS.setMode, params: { sessionId, modeId: "auto" } });
}
export function buildPrompt(id: number, sessionId: string, content: string | ContentPart[]): string {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  return line({ id, method: FX_METHODS.prompt, params: { sessionId, prompt: parts.map(p => p.type === "text" ? p : { type: "image", mimeType: p.mediaType, data: p.data }) } });
}
export function buildCancel(sessionId: string): string { return line({ method: FX_METHODS.cancel, params: { sessionId } }); }
export function buildPermissionDenied(id: string | number): string { return line({ id, result: { outcome: { outcome: "cancelled" } } }); }
export function buildUnsupportedRequest(id: string | number): string { return line({ id, error: { code: -32601, message: "Method not supported by vibedeckx" } }); }

/** ACP tool content is a snapshot; a completed snapshot replaces progress. */
export function toolOutput(content: unknown[]): string {
  return content.map(item => {
    if (typeof item !== "object" || item === null) return "";
    const block = item as { type?: string; content?: { type?: string; text?: string } };
    return block.type === "content" && block.content?.type === "text" ? block.content.text ?? "" : JSON.stringify(item);
  }).filter(Boolean).join("\n");
}
