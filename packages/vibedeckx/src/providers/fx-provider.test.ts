import { describe, expect, it, vi } from "vitest";
import { FxProvider } from "./fx-provider.js";
import { FX_PLAN_MODE_INSTRUCTIONS } from "../protocol/fx/codec.js";
import type { ParsedAgentEvent } from "../agent-provider.js";

const response = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const writes = (events: ParsedAgentEvent[]) => events.filter(e => e.type === "stdin_write").map(e => JSON.parse(e.content));
function ready(p: FxProvider, app = "app", native = "native", mode: "plan" | "edit" = "edit") {
  p.onSessionCreated(app, mode);
  expect(JSON.parse(p.getInitializationMessages(app, { cwd: "/workspace" })!).method).toBe("initialize");
  expect(writes(p.parseStdoutLine(response(1, { protocolVersion: 1 }), app))[0]).toMatchObject({ id: 2, method: "session/new", params: { cwd: "/workspace" } });
  expect(p.parseStdoutLine(response(2, { sessionId: native, modes: { currentModeId: "full-access" } }), app)).toEqual([{ type: "native_session_id", id: native }]);
}
const update = (u: unknown, sessionId = "native") => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

describe("FxProvider lifecycle", () => {
  it("waits for each handshake response and keeps every pre-initialization message in order", () => {
    const p = new FxProvider();
    p.onSessionCreated("a");
    expect(JSON.parse(p.getInitializationMessages("a", { cwd: "/a" })!).method).toBe("initialize");
    expect(p.formatUserInput("history", "a")).toBe("");
    expect(p.formatUserInput("next", "a")).toBe("");
    const newSession = writes(p.parseStdoutLine(response(1, { protocolVersion: 1 }), "a"))[0];
    expect(newSession.params.cwd).toBe("/a");
    const created = p.parseStdoutLine(response(2, { sessionId: "new-native", modes: { currentModeId: "full-access" } }), "a");
    expect(created[0]).toEqual({ type: "native_session_id", id: "new-native" });
    const prompt = writes(created)[0];
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "history" }]);
    const ended = p.parseStdoutLine(response(prompt.id, { stopReason: "end_turn" }), "a");
    expect(ended.map(e => e.type)).toEqual(["result", "turn_started", "stdin_write"]);
    expect(writes(ended)[0].params.prompt[0].text).toBe("next");
  });
  it.each(["ask", "auto", undefined])("refuses mismatched or unknown starting mode %s without changing global defaults", mode => {
    const p = new FxProvider(); p.onSessionCreated("a"); p.getInitializationMessages("a");
    p.formatUserInput("queued", "a");
    p.parseStdoutLine(response(1, { protocolVersion: 1 }), "a");
    const events = p.parseStdoutLine(response(2, { sessionId: "native", ...(mode ? { modes: { currentModeId: mode } } : {}) }), "a");
    expect(events).toEqual([expect.objectContaining({ type: "result", subtype: "error", error: expect.stringContaining("full-access permission mode") })]);
    expect(writes(events)).toEqual([]);
  });
  it("serializes multiple turns, preserves result usage, and never treats occupancy as usage", () => {
    const p = new FxProvider(); ready(p);
    const first = JSON.parse(p.formatUserInput("one", "app"));
    expect(p.formatUserInput("two", "app")).toBe("");
    expect(p.formatUserInput("three", "app")).toBe("");
    expect(p.parseStdoutLine(update({ sessionUpdate: "usage_update", used: 4000, size: 100000 }), "app")).toEqual([]);
    const second = p.parseStdoutLine(response(first.id, { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 30 } }), "app");
    expect(second[0]).toMatchObject({ type: "result", subtype: "success", input_tokens: 20, output_tokens: 30 });
    const next = writes(second)[0];
    expect(next.params.prompt[0].text).toBe("two");
    const third = writes(p.parseStdoutLine(response(next.id, { stopReason: "end_turn" }), "app"))[0];
    expect(third.params.prompt[0].text).toBe("three");
    expect(p.parseStdoutLine(response(third.id, { stopReason: "end_turn" }), "app")).toHaveLength(1);
  });
  it("waits for cancelled response before sending post-Stop input, then remains usable", () => {
    const p = new FxProvider(); ready(p);
    const first = JSON.parse(p.formatUserInput("one", "app"));
    expect(JSON.parse(p.formatInterrupt("app")!)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "native" } });
    expect(p.formatUserInput("after stop", "app")).toBe("");
    const events = p.parseStdoutLine(response(first.id, { stopReason: "cancelled" }), "app");
    expect(events[0]).toMatchObject({ type: "result", subtype: "cancelled" });
    expect(writes(events)[0].params.prompt[0].text).toBe("after stop");
  });
  it.each([3, "server-id"])("cancels unexpected approval id %s without opening a card or waiting for user input", serverId => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("go", "app"));
    const events = p.parseStdoutLine(JSON.stringify({ jsonrpc: "2.0", id: serverId, method: "session/request_permission", params: {
      sessionId: "native", toolCall: { toolCallId: "t" }, options: [{ optionId: "allow", kind: "allow_once" }],
    } }), "app");
    expect(writes(events)[0]).toEqual({ jsonrpc: "2.0", id: serverId, result: { outcome: { outcome: "cancelled" } } });
    expect(events[1]).toMatchObject({ type: "error", message: expect.stringContaining("full-access") });
    expect(events.some(e => e.type === "approval_request")).toBe(false);
    // A server request sharing our prompt's id must not consume its response.
    expect(p.parseStdoutLine(response(prompt.id, { stopReason: "end_turn" }), "app")[0]).toMatchObject({ type: "result", subtype: "success" });
  });
  it("injects fresh per-session MCP tokens without leaking between sessions", () => {
    const p = new FxProvider();
    for (const id of ["a", "b", "a"]) {
      p.onSessionCreated(id);
      p.getInitializationMessages(id, { cwd: "/work", sessionToolsMcp: { url: "https://hub/mcp", token: id } });
      const request = writes(p.parseStdoutLine(response(1, { protocolVersion: 1 }), id))[0];
      expect(request.params.mcpServers[0]).toMatchObject({ name: "vibedeckx", headers: [{ name: "Authorization", value: `Bearer ${id}` }] });
    }
  });
  it("merges tool snapshots without duplicating cards or completed output and streams thoughts/text", () => {
    const p = new FxProvider(); ready(p); p.formatUserInput("go", "app");
    for (const [kind, type] of [["agent_message_chunk", "text"], ["agent_thought_chunk", "thinking"]]) {
      expect(p.parseStdoutLine(update({ sessionUpdate: kind, content: { type: "text", text: "chunk" } }), "app")).toEqual([{ type, content: "chunk", delta: true }]);
    }
    const start = { sessionUpdate: "tool_call", toolCallId: "t", name: "shell", rawInput: { command: "pwd" }, status: "pending" };
    expect(p.parseStdoutLine(update(start), "app")[0]).toMatchObject({ type: "tool_use", tool: "Bash", input: { command: "pwd" } });
    expect(p.parseStdoutLine(update(start), "app")).toEqual([]);
    const content = [{ type: "content", content: { type: "text", text: "/workspace" } }];
    expect(p.parseStdoutLine(update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", content }), "app")).toEqual([]);
    const end = update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content });
    expect(p.parseStdoutLine(end, "app")).toEqual([{ type: "tool_result", tool: "Bash", output: "/workspace", toolUseId: "t" }]);
    expect(p.parseStdoutLine(end, "app")).toEqual([]);
    expect(p.parseStdoutLine(update(start, "foreign"), "app")).toEqual([]);
  });
  it("replaces changed completed snapshots with the child report and preserves MCP names on results", () => {
    const p = new FxProvider(); ready(p); p.formatUserInput("go", "app");
    p.parseStdoutLine(update({ sessionUpdate: "tool_call", toolCallId: "child", name: "subagent", rawInput: { action: "message", agent: "child", message: "work" } }), "app");
    const result = (text: string) => update({ sessionUpdate: "tool_call_update", toolCallId: "child", status: "completed", content: [{ type: "content", content: { type: "text", text } }] });
    expect(p.parseStdoutLine(result("Sent to child"), "app")[0]).toMatchObject({ tool: "Agent", output: "Sent to child" });
    expect(p.parseStdoutLine(result("CHILD_DONE"), "app")[0]).toMatchObject({ tool: "Agent", output: "CHILD_DONE", toolUseId: "child" });
    expect(p.parseStdoutLine(result("CHILD_DONE"), "app")).toEqual([]);
    expect(p.parseStdoutLine(update({ sessionUpdate: "tool_call", toolCallId: "mcp", name: "mcp_my_server_my_tool", rawInput: {}, _meta: { fx: { toolCall: { mcp: { server: "my_server", tool: "my_tool" } } } } }), "app")[0]).toMatchObject({ tool: "mcp__my_server__my_tool" });
    expect(p.parseStdoutLine(update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" }), "app")[0]).toMatchObject({ tool: "mcp__my_server__my_tool" });
  });
  it.each(["end_turn", "cancelled", "error"])("ends a turn with yielded shell and pending child on %s without inventing background tasks", stopReason => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("go", "app"));
    for (const name of ["shell", "subagent"]) {
      const events = p.parseStdoutLine(update({ sessionUpdate: "tool_call", toolCallId: name, name, rawInput: { action: name === "shell" ? "run" : "message" }, status: "in_progress" }), "app");
      expect(events.map(e => e.type)).toEqual(["tool_use"]);
    }
    p.parseStdoutLine(update({ sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed", content: [] }), "app");
    if (stopReason === "cancelled") p.formatInterrupt("app");
    const events = p.parseStdoutLine(stopReason === "error" ? JSON.stringify({ jsonrpc: "2.0", id: prompt.id, error: { code: -32000, message: "Failed" } }) : response(prompt.id, { stopReason }), "app");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "result", subtype: stopReason === "end_turn" ? "success" : stopReason });
    expect(JSON.parse(p.formatUserInput("next", "app")).method).toBe("session/prompt");
  });
  it("preserves yielded shell identity and output across prompts and empty progress", () => {
    const p = new FxProvider(); ready(p);
    const first = JSON.parse(p.formatUserInput("run", "app"));
    p.parseStdoutLine(update({ sessionUpdate: "tool_call", toolCallId: "shell", name: "shell", rawInput: { action: "run", command: "sleep 30" } }), "app");
    const progress = (status: string, text: string) => update({ sessionUpdate: "tool_call_update", toolCallId: "shell", status, content: [{ type: "content", content: { type: "text", text } }] });
    p.parseStdoutLine(progress("completed", "initial output"), "app");
    expect(p.parseStdoutLine(progress("in_progress", ""), "app")).toEqual([]);
    p.parseStdoutLine(response(first.id, { stopReason: "end_turn" }), "app");
    // Idle updates still cannot reopen a turn.
    expect(p.parseStdoutLine(progress("in_progress", "idle output"), "app")).toEqual([]);
    p.formatUserInput("next", "app");
    expect(p.parseStdoutLine(progress("in_progress", "late output"), "app")).toEqual([
      { type: "tool_result", tool: "Bash", toolUseId: "shell", output: "late output" },
    ]);
    expect(p.parseStdoutLine(progress("in_progress", ""), "app")).toEqual([]);
    expect(p.parseStdoutLine(update({ sessionUpdate: "tool_call_update", toolCallId: "shell", status: "in_progress", content: [] }), "app")).toEqual([]);
  });
  it.each(["bad-json", response(1, {}), JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Not authenticated" } })])("ends a failed initialization and never flushes queued prompts: %s", line => {
    const p = new FxProvider(); p.onSessionCreated("a"); p.getInitializationMessages("a"); p.formatUserInput("buffered", "a");
    expect(p.parseStdoutLine(line, "a")[0]).toMatchObject({ type: "result", subtype: "error" });
    expect(p.parseStdoutLine(response(1, { protocolVersion: 1 }), "a")).toEqual([]);
    expect(() => p.formatUserInput("retry", "a")).toThrow();
  });
  it("cancels and ends malformed running streams once", () => {
    const p = new FxProvider(); ready(p); p.formatUserInput("go", "app");
    const events = p.parseStdoutLine("broken", "app");
    expect(events.map(e => e.type)).toEqual(["stdin_write", "result"]);
    expect(p.parseStdoutLine(response(4, { stopReason: "cancelled" }), "app")).toEqual([]);
  });
  it("ignores unknown updates and stale errors, and retries after a prompt error", () => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("go", "app"));
    expect(p.parseStdoutLine(update({ sessionUpdate: "future_update", value: 1 }), "app")).toEqual([]);
    const error = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Rate limit" } });
    expect(p.parseStdoutLine(error(999), "app")).toEqual([]);
    expect(p.parseStdoutLine(error(prompt.id), "app")).toEqual([{ type: "result", subtype: "error", error: "fx request failed: -32000: Rate limit" }]);
    expect(JSON.parse(p.formatUserInput("retry", "app")).method).toBe("session/prompt");
  });
  it("preserves model errors streamed as text before an error stop reason (fx 0.0.17)", () => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("go", "app"));
    const original = 'HTTP 404: {"error":{"message":"Model \'vendor/unknown\' not found","type":"model_not_found"}}';
    expect(p.parseStdoutLine(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: original } }), "app"))
      .toEqual([{ type: "text", content: original, delta: true }]);
    expect(p.parseStdoutLine(response(prompt.id, { stopReason: "error" }), "app")[0])
      .toMatchObject({ type: "result", subtype: "error" });
    expect(JSON.parse(p.formatUserInput("retry", "app")).method).toBe("session/prompt");
  });
  it("does not create state for stdout from a destroyed session", () => {
    const p = new FxProvider();
    expect(p.parseStdoutLine(response(1, {}), "gone")).toEqual([]);
    expect(() => p.formatUserInput("oops", "gone")).toThrow(/not been created/);
  });
  it("reports queued messages discarded by Stop", () => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("go", "app"));
    p.formatUserInput("queued", "app"); p.formatInterrupt("app");
    const events = p.parseStdoutLine(response(prompt.id, { stopReason: "cancelled" }), "app");
    expect(events).toEqual([{ type: "system", content: expect.stringContaining("1 queued message") }, expect.objectContaining({ type: "result", subtype: "cancelled" })]);
    expect(writes(events)).toEqual([]);
  });
  it("fresh process/session state never reuses another native id or pending input", () => {
    const p = new FxProvider(); ready(p, "a", "native-a"); ready(p, "b", "native-b");
    expect(JSON.parse(p.formatUserInput("b", "b")).params.sessionId).toBe("native-b");
    p.onSessionDestroyed("a"); ready(p, "a", "new-a");
    expect(JSON.parse(p.formatUserInput("replayed history", "a")).params.sessionId).toBe("new-a");
  });
  it("plan mode prefixes instructions as a separate block on every prompt; edit sends content untouched", () => {
    const p = new FxProvider();
    expect((p as { getCapabilities?: unknown }).getCapabilities).toBeUndefined();
    ready(p, "plan", "native", "plan");
    const first = JSON.parse(p.formatUserInput("plan the change", "plan"));
    expect(first.params.prompt).toEqual([{ type: "text", text: FX_PLAN_MODE_INSTRUCTIONS }, { type: "text", text: "plan the change" }]);
    p.parseStdoutLine(response(first.id, { stopReason: "end_turn" }), "plan");
    const image = JSON.parse(p.formatUserInput([{ type: "image", mediaType: "image/png", data: "AA==" }], "plan"));
    expect(image.params.prompt).toEqual([{ type: "text", text: FX_PLAN_MODE_INSTRUCTIONS }, { type: "image", mimeType: "image/png", data: "AA==" }]);
    // Mode switch respawns with onSessionCreated(newMode): edit drops the block.
    p.onSessionDestroyed("plan"); ready(p, "plan", "native", "edit");
    expect(JSON.parse(p.formatUserInput("now edit", "plan")).params.prompt).toEqual([{ type: "text", text: "now edit" }]);
  });
  it("starts plan with the same full-access process and reports missing binary without a fallback", () => {
    const p = new FxProvider(); vi.spyOn(p, "detectBinary").mockReturnValue(null);
    expect(p.buildSpawnConfig("/work", "plan")).toEqual(p.buildSpawnConfig("/work", "edit"));
    expect(p.buildSpawnConfig("/work", "edit", undefined, "new-model")).toMatchObject({ command: "fx", args: ["acp", "--model", "new-model"] });
    expect(p.getInstallHint()).toContain("https://fx.sh");
  });
});
