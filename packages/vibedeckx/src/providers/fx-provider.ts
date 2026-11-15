import type { AgentProvider, AgentInitializationContext, ParsedAgentEvent, SpawnConfig } from "../agent-provider.js";
import type { ContentPart } from "../agent-types.js";
import type { CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import type { SessionToolsMcpConfig } from "../session-tools-mcp.js";
import { detectBinary } from "../protocol/shared/binary.js";
import { buildFxSpawnConfig } from "../protocol/fx/cli.js";
import { buildInitialize, buildSessionNew, buildPrompt, buildCancel, buildPermissionDenied, buildUnsupportedRequest, parseFxLine, toolOutput, type FxSessionOptions } from "../protocol/fx/codec.js";
import { FX_BINARY_NAME, FX_METHODS, FxInitializeResultSchema, FxNewResultSchema, FxPromptResultSchema } from "../protocol/fx/schema.js";

type Input = string | ContentPart[];
interface FxSessionState {
  nextId: number;
  pending: Map<string | number, string>;
  nativeId: string | null;
  phase: "created" | "initializing" | "ready" | "failed";
  options: FxSessionOptions;
  queue: Input[];
  promptId: number | null;
  failure?: string;
  discardedOnStop?: number;
  tools: Map<string, { name: string; input: unknown; content: unknown[]; emitted: boolean; completed: boolean }>;
}

export class FxProvider implements AgentProvider {
  readonly keepAliveOnInterrupt = true;
  readonly requiresExplicitTurnResult = true;
  private sessions = new Map<string, FxSessionState>();
  getAgentType() { return "fx" as const; }
  getDisplayName() { return "fx"; }
  getCapabilities() { return { planMode: false }; }
  getInstallHint() { return "fx is not installed. Install it from https://fx.sh and make sure the fx binary is on PATH; use fx 0.0.17 or newer and run fx login before starting a session."; }
  detectBinary() { return detectBinary(FX_BINARY_NAME, { refresh: true }); }
  buildSpawnConfig(_cwd: string, mode: "plan" | "edit", _cross?: CrossRemoteMcpConfig, model?: string | null, _tools?: SessionToolsMcpConfig): SpawnConfig {
    this.assertMode(mode);
    return buildFxSpawnConfig(this.detectBinary(), model);
  }
  private assertMode(mode: "plan" | "edit") {
    if (mode === "plan") throw new Error("fx does not support plan mode; choose edit mode.");
  }
  onSessionCreated(id: string, mode: "plan" | "edit" = "edit") {
    this.assertMode(mode);
    this.sessions.set(id, { nextId: 1, pending: new Map(), nativeId: null, phase: "created", options: { cwd: process.cwd() }, queue: [], promptId: null, tools: new Map() });
  }
  onSessionDestroyed(id: string) { this.sessions.delete(id); }
  private state(id: string): FxSessionState {
    const state = this.sessions.get(id);
    if (!state) throw new Error("fx session has not been created.");
    return state;
  }
  private request(state: FxSessionState, method: string, build: (id: number) => string): string {
    const id = state.nextId++;
    state.pending.set(id, method);
    return build(id);
  }
  getInitializationMessages(id: string, context?: AgentInitializationContext): string | null {
    const state = this.state(id);
    if (state.phase !== "created") return null;
    if (context) state.options = { cwd: context.cwd };
    state.phase = "initializing";
    return this.request(state, FX_METHODS.initialize, buildInitialize);
  }
  formatUserInput(content: Input, id: string): string {
    const state = this.state(id);
    if (state.phase === "failed") throw new Error(state.failure ?? "fx initialization failed; restart the session.");
    state.queue.push(content);
    return this.getInitializationMessages(id) ?? this.flush(state);
  }
  private flush(state: FxSessionState): string {
    if (state.phase !== "ready" || state.promptId !== null || !state.nativeId || !state.queue.length) return "";
    const content = state.queue.shift()!;
    state.tools.clear();
    return this.request(state, FX_METHODS.prompt, id => {
      state.promptId = id;
      return buildPrompt(id, state.nativeId!, content);
    });
  }
  formatInterrupt(id: string): string | null {
    const state = this.sessions.get(id);
    if (!state) return null;
    state.discardedOnStop = (state.discardedOnStop ?? 0) + state.queue.length;
    state.queue = [];
    if (!state.nativeId || state.promptId === null) return null;
    return buildCancel(state.nativeId);
  }
  private fail(state: FxSessionState, message: string): ParsedAgentEvent[] {
    const cancel = state.nativeId && state.promptId !== null ? buildCancel(state.nativeId) : "";
    state.phase = "failed";
    state.failure = message;
    state.pending.clear(); state.queue = []; state.promptId = null;
    return [...(cancel ? [{ type: "stdin_write" as const, content: cancel }] : []), { type: "result", subtype: "error", error: message, restartRequired: true }];
  }
  private finishPrompt(state: FxSessionState, events: ParsedAgentEvent[]): ParsedAgentEvent[] {
    if (state.discardedOnStop) {
      events.unshift({ type: "system", content: `Stop cancelled ${state.discardedOnStop} queued message(s) before they were sent to fx. Resend them to continue.` });
      state.discardedOnStop = 0;
    }
    const content = this.flush(state);
    // Close the previous turn before opening the queued prompt.
    if (content) events.push({ type: "turn_started" }, { type: "stdin_write", content });
    return events;
  }
  parseStdoutLine(line: string, id: string): ParsedAgentEvent[] {
    const state = this.sessions.get(id);
    if (!state) return [];
    const incoming = parseFxLine(line);
    if (incoming.kind === "permission") {
      // Never auto-approve. Reply even when failed, otherwise the CLI can hang
      // while trying to finish cancellation. IDs are not our pending requests.
      return [
        { type: "stdin_write", content: buildPermissionDenied(incoming.id) },
        { type: "system", content: "fx requested permission. This integration does not yet support approval; the request was denied." },
      ];
    }
    if (incoming.kind === "server_request") return [{ type: "stdin_write", content: buildUnsupportedRequest(incoming.id) }];
    if (state.phase === "failed") return [];
    if (incoming.kind === "invalid") return this.fail(state, incoming.message);
    if (incoming.kind === "error_response") {
      const method = incoming.id === null ? undefined : state.pending.get(incoming.id);
      if (!method) return [];
      if (method !== FX_METHODS.prompt) return this.fail(state, `fx request failed: ${incoming.message}`);
      state.pending.delete(incoming.id!);
      state.promptId = null;
      return this.finishPrompt(state, [{ type: "result", subtype: "error", error: `fx request failed: ${incoming.message}` }]);
    }
    if (incoming.kind === "ignored") return [];
    if (incoming.kind === "response") {
      const method = state.pending.get(incoming.id);
      if (!method) return [];
      state.pending.delete(incoming.id);
      if (method === FX_METHODS.initialize) {
        if (!FxInitializeResultSchema.safeParse(incoming.result).success) return this.fail(state, "fx returned an invalid initialize response (ACP v1 required).");
        return [{ type: "stdin_write", content: this.request(state, FX_METHODS.newSession, n => buildSessionNew(n, state.options)) }];
      }
      if (method === FX_METHODS.newSession) {
        const result = FxNewResultSchema.safeParse(incoming.result);
        if (!result.success) return this.fail(state, "fx returned an invalid session/new response.");
        if (result.data.modes?.currentModeId !== "auto") {
          return this.fail(state, "fx requires auto permission mode for edit sessions. Upgrade to fx 0.0.17 or newer, or select auto in fx before retrying. No global permission settings were changed.");
        }
        state.nativeId = result.data.sessionId;
        state.phase = "ready";
        const content = this.flush(state);
        return [{ type: "native_session_id", id: state.nativeId }, ...(content ? [{ type: "turn_started" as const }, { type: "stdin_write" as const, content }] : [])];
      }
      if (method === FX_METHODS.prompt) {
        const result = FxPromptResultSchema.safeParse(incoming.result);
        if (!result.success) return this.fail(state, "fx returned an invalid session/prompt response.");
        state.promptId = null;
        const { stopReason, usage } = result.data;
        const events: ParsedAgentEvent[] = [{
          type: "result", subtype: stopReason === "end_turn" ? "success" : stopReason === "cancelled" ? "cancelled" : "error",
          ...(stopReason !== "end_turn" && stopReason !== "cancelled" ? { error: `fx stopped: ${stopReason}` } : {}),
          input_tokens: usage?.inputTokens, output_tokens: usage?.outputTokens,
        }];
        return this.finishPrompt(state, events);
      }
      return [];
    }
    if (incoming.params.sessionId !== state.nativeId || state.promptId === null) return [];
    const update = incoming.params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": return [{ type: "text", content: update.content.text, delta: true }];
      case "agent_thought_chunk": return [{ type: "thinking", content: update.content.text, delta: true }];
      case "tool_call":
      case "tool_call_update": {
        const tool = state.tools.get(update.toolCallId) ?? { name: update.name ?? "Tool", input: update.rawInput ?? {}, content: [], emitted: false, completed: false };
        if (update.name) tool.name = update.name;
        if (update.rawInput !== undefined) tool.input = update.rawInput;
        if (update.content) tool.content = update.content;
        state.tools.set(update.toolCallId, tool);
        const events: ParsedAgentEvent[] = [];
        if (!tool.emitted) { tool.emitted = true; events.push({ type: "tool_use", tool: tool.name, input: tool.input, toolUseId: update.toolCallId }); }
        if (!tool.completed && (update.status === "completed" || update.status === "failed")) {
          tool.completed = true;
          events.push({ type: "tool_result", tool: tool.name, output: toolOutput(tool.content) || update.status, toolUseId: update.toolCallId });
        }
        return events;
      }
      // usage_update is context occupancy, NOT per-turn token usage.
      default: return [];
    }
  }
}
