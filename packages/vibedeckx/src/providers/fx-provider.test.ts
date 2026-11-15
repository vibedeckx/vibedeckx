import { describe, expect, it, vi } from "vitest";
import { FxProvider } from "./fx-provider.js";
import type { ParsedAgentEvent } from "../agent-provider.js";

const response = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const writes = (events: ParsedAgentEvent[]) => events.filter(e => e.type === "stdin_write").map(e => JSON.parse(e.content));
function ready(p: FxProvider, app = "app", native = "native") {
  p.onSessionCreated(app, "edit");
  expect(JSON.parse(p.getInitializationMessages(app, { cwd: "/workspace" })!).method).toBe("initialize");
  expect(writes(p.parseStdoutLine(response(1, { protocolVersion: 1 }), app))[0]).toMatchObject({ id: 2, method: "session/new", params: { cwd: "/workspace" } });
  expect(p.parseStdoutLine(response(2, { sessionId: native, modes: { currentModeId: "auto" } }), app)).toEqual([{ type: "native_session_id", id: native }]);
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
    const created = p.parseStdoutLine(response(2, { sessionId: "new-native", modes: { currentModeId: "auto" } }), "a");
    expect(created[0]).toEqual({ type: "native_session_id", id: "new-native" });
    const prompt = writes(created)[0];
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "history" }]);
    const ended = p.parseStdoutLine(response(prompt.id, { stopReason: "end_turn" }), "a");
    expect(ended.map(e => e.type)).toEqual(["result", "turn_started", "stdin_write"]);
    expect(writes(ended)[0].params.prompt[0].text).toBe("next");
  });
  it.each(["ask", "full-access", undefined])("refuses unsafe or unknown starting mode %s without changing global defaults", mode => {
    const p = new FxProvider(); p.onSessionCreated("a"); p.getInitializationMessages("a");
    p.formatUserInput("queued", "a");
    p.parseStdoutLine(response(1, { protocolVersion: 1 }), "a");
    const events = p.parseStdoutLine(response(2, { sessionId: "native", ...(mode ? { modes: { currentModeId: mode } } : {}) }), "a");
    expect(events).toEqual([expect.objectContaining({ type: "result", subtype: "error", error: expect.stringContaining("auto permission mode") })]);
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
  it("routes server ids independently and explicitly denies permissions", () => {
    const p = new FxProvider(); ready(p);
    const prompt = JSON.parse(p.formatUserInput("one", "app"));
    const events = p.parseStdoutLine(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, method: "session/request_permission", params: { sessionId: "native", toolCall: { toolCallId: "t" }, options: [{ optionId: "allow", kind: "allow_once" }] } }), "app");
    expect(writes(events)[0]).toEqual({ jsonrpc: "2.0", id: prompt.id, result: { outcome: { outcome: "cancelled" } } });
    expect(events[1].type).toBe("system");
    expect(p.parseStdoutLine(response(prompt.id, { stopReason: "end_turn" }), "app")[0]).toMatchObject({ type: "result", subtype: "success" });
  });
  it("merges tool snapshots without duplicating cards or completed output and streams thoughts/text", () => {
    const p = new FxProvider(); ready(p); p.formatUserInput("go", "app");
    for (const [kind, type] of [["agent_message_chunk", "text"], ["agent_thought_chunk", "thinking"]]) {
      expect(p.parseStdoutLine(update({ sessionUpdate: kind, content: { type: "text", text: "chunk" } }), "app")).toEqual([{ type, content: "chunk", delta: true }]);
    }
    const start = { sessionUpdate: "tool_call", toolCallId: "t", name: "shell", rawInput: { command: "pwd" }, status: "pending" };
    expect(p.parseStdoutLine(update(start), "app")[0]).toMatchObject({ type: "tool_use", tool: "shell", input: { command: "pwd" } });
    expect(p.parseStdoutLine(update(start), "app")).toEqual([]);
    const content = [{ type: "content", content: { type: "text", text: "/workspace" } }];
    expect(p.parseStdoutLine(update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", content }), "app")).toEqual([]);
    const end = update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content });
    expect(p.parseStdoutLine(end, "app")).toEqual([{ type: "tool_result", tool: "shell", output: "/workspace", toolUseId: "t" }]);
    expect(p.parseStdoutLine(end, "app")).toEqual([]);
    expect(p.parseStdoutLine(update(start, "foreign"), "app")).toEqual([]);
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
  it("rejects plan and reports missing binary without a fallback", () => {
    const p = new FxProvider(); vi.spyOn(p, "detectBinary").mockReturnValue(null);
    expect(p.getCapabilities()).toEqual({ planMode: false });
    expect(() => p.onSessionCreated("plan", "plan")).toThrow(/plan/);
    expect(() => p.buildSpawnConfig("/work", "plan")).toThrow(/plan/);
    expect(p.buildSpawnConfig("/work", "edit", undefined, "new-model")).toMatchObject({ command: "fx", args: ["acp", "--model", "new-model"] });
    expect(p.getInstallHint()).toContain("https://fx.sh");
  });
});
