/**
 * Stateless framing + message construction for the Codex app-server JSON-RPC
 * protocol. All session state (rpc id counters, pending-request maps,
 * threadId) stays in CodexProvider — this module only knows shapes.
 */
import type { ContentPart } from "../../agent-types.js";
import { CODEX_CLIENT_METHODS, type AskForApproval, type SandboxMode } from "./schema.js";

export type CodexIncoming =
  | { kind: "error_response"; id: string | number; error: { code?: number; message?: string } }
  | { kind: "response"; id: string | number; result: unknown }
  | { kind: "server_request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "ignored"; raw: string };

export function parseCodexLine(line: string): CodexIncoming {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "ignored", raw: line };
  }
  const id = msg.id as string | number | null | undefined;
  const method = msg.method as string | undefined;
  if (id != null && !method && msg.error !== undefined) {
    return { kind: "error_response", id, error: (msg.error ?? {}) as { code?: number; message?: string } };
  }
  if (id != null && !method && msg.result !== undefined) {
    return { kind: "response", id, result: msg.result };
  }
  if (id != null && method) {
    return { kind: "server_request", id, method, params: msg.params };
  }
  if (method) {
    return { kind: "notification", method, params: msg.params };
  }
  return { kind: "ignored", raw: line };
}

// ---- Outbound builders (all newline-terminated) ----

function rpcLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
}

export function buildInitialize(id: number): string {
  return rpcLine({
    id,
    method: CODEX_CLIENT_METHODS.initialize,
    params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } },
  });
}

/**
 * Permission-mode mapping. We always set `approvalPolicy: "never"` so Codex
 * runs autonomously without emitting approval prompts — the equivalent of
 * Claude Code's --dangerously-skip-permissions. Edit mode uses
 * danger-full-access: with a confined sandbox + "never", any command that
 * needs to escape the sandbox is auto-denied and silently fails instead of
 * prompting (and on hosts where the Linux sandbox can't initialize, every
 * command would fail).
 */
export function threadStartParamsFor(mode: "plan" | "edit"): { sandbox: SandboxMode; approvalPolicy: AskForApproval } {
  if (mode === "plan") {
    return { sandbox: "read-only", approvalPolicy: "never" };
  }
  return { sandbox: "danger-full-access", approvalPolicy: "never" };
}

export function buildThreadStart(id: number, mode: "plan" | "edit"): string {
  return rpcLine({ id, method: CODEX_CLIENT_METHODS.threadStart, params: threadStartParamsFor(mode) });
}

export function buildCodexInput(content: string | ContentPart[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return { type: "image", url: `data:${part.mediaType};base64,${part.data}` };
  });
}

export function buildTurnStart(id: number, threadId: string, content: string | ContentPart[]): string {
  return rpcLine({
    id,
    method: CODEX_CLIENT_METHODS.turnStart,
    params: { threadId, input: buildCodexInput(content) },
  });
}

export function buildCancelRequest(targetRequestId: number): string {
  return rpcLine({ method: CODEX_CLIENT_METHODS.cancelRequest, params: { id: targetRequestId } });
}

export function buildApprovalResponse(requestId: string, decision: string): string {
  return rpcLine({ id: Number(requestId), result: { decision } });
}
