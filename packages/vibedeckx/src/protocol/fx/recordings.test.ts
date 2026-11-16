import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Historical protocol evidence, not claims about current product support.
// ACP transcripts wrap {direction,message}; HTTP server logs have a different shape.
const fixtures = new URL("./__fixtures__/", import.meta.url);
function rows(name: string): Array<{ direction?: string; message: ReturnType<typeof JSON.parse>; path?: string; authorizationMatched?: boolean }> {
  return readFileSync(new URL(`${name}.jsonl`, fixtures), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function messages(name: string) { return rows(name).filter(r => r.direction !== "stderr").map(r => r.message); }
function updates(ms: ReturnType<typeof messages>) { return ms.filter(m => m.method === "session/update").map(m => m.params.update); }
function text(ms: ReturnType<typeof messages>) { return updates(ms).filter(u => u.sessionUpdate === "agent_message_chunk").map(u => u.content.text).join(""); }
function response(name: string, id: number) {
  const row = rows(name).find(r => r.direction === "stdout" && r.message.id === id && (r.message.result || r.message.error));
  expect(row, `${name}: missing response ${id}`).toBeDefined();
  return row!.message;
}
function turn(name: string, id: number) {
  const rs = rows(name);
  const start = rs.findIndex(r => r.direction === "stdin" && r.message.id === id && r.message.method === "session/prompt");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = rs.findIndex((r, i) => i > start && r.direction === "stdout" && r.message.id === id && (r.message.result || r.message.error));
  expect(end).toBeGreaterThan(start);
  return rs.slice(start, end + 1).filter(r => r.direction !== "stderr").map(r => r.message);
}

describe("fx probe evidence retained after Python probe retirement", () => {
  it("keeps parseable recordings without credential fields or original home paths", () => {
    for (const file of readdirSync(fixtures).filter(f => f.endsWith(".jsonl"))) {
      const content = readFileSync(new URL(file, fixtures), "utf8");
      for (const line of content.trim().split("\n")) expect(() => JSON.parse(line), file).not.toThrow();
      expect(content, file).not.toMatch(/access_token|refresh_token|\/home\/ubuntu\//);
    }
  });

  it("preserves tools, thinking, multi-turn memory and cancel-then-continue evidence", () => {
    const name = "session-tools-permissions";
    const ms = messages(name);
    expect(updates(ms).filter(u => u.sessionUpdate === "tool_call").map(u => u.name)).toEqual(expect.arrayContaining(["read_file", "edit_file", "shell"]));
    expect(updates(ms).map(u => u.sessionUpdate)).toEqual(expect.arrayContaining(["agent_message_chunk", "agent_thought_chunk"]));
    expect(text(turn(name, 9))).toBe("COBALT731");
    expect(response(name, 13).result.stopReason).toBe("cancelled");
    expect(text(turn(name, 14))).toContain("AFTER_CANCEL_OK COBALT731");
    expect(ms.some(m => m.method === "session/cancel" && m.id === undefined)).toBe(true);
    expect(turn(name, 11).some(m => m.method === "session/request_permission")).toBe(false);
  });

  for (const name of ["session-tools-permissions", "http-mcp-session", "auto-explicit-ask"]) {
    it(`${name}: matches historical permission replies in the correct RPC direction`, () => {
      const rs = rows(name);
      const requests = rs.filter(r => r.direction === "stdout" && r.message.method === "session/request_permission");
      expect(requests.length).toBeGreaterThan(0);
      for (const { message: request } of requests) {
        const reply = rs.find(r => r.direction === "stdin" && r.message.id === request.id && r.message.result);
        expect(reply?.message.result.outcome).toEqual({ outcome: "selected", optionId: "allow_once" });
        expect(updates(messages(name)).some(u => u.toolCallId === request.params.toolCall.toolCallId && u.status === "completed")).toBe(true);
      }
    });
  }

  for (const [name, replayed] of [["restart-load", true], ["restart-resume", false]] as const) {
    it(`${name}: retains native recovery evidence without claiming product support`, () => {
      const rs = rows(name);
      const end = rs.findIndex(r => r.direction === "stdout" && r.message.id === 2 && r.message.result);
      expect(end).toBeGreaterThan(-1);
      expect(updates(rs.slice(0, end).map(r => r.message)).some(u => u.sessionUpdate === "user_message_chunk")).toBe(replayed);
      expect(text(turn(name, 3))).toBe("COBALT731");
      const request = messages(name).find(m => ["session/load", "session/resume"].includes(m.method));
      expect(request.params.sessionId).toBe("a7R28241KBaq");
      expect(messages(name).filter(m => m.method === "session/update").every(m => m.params.sessionId === request.params.sessionId)).toBe(true);
    });
  }

  it("checks actual authenticated HTTP calls separately from ACP envelopes", () => {
    expect(updates(messages("http-mcp-session")).filter(u => u.sessionUpdate === "tool_call").map(u => u.name)).toEqual(expect.arrayContaining(["mcp_vibedeckx_probe_echo", "mcp_cross-remote_probe_echo"]));
    const calls = rows("http-mcp-server").filter(r => r.message.method === "tools/call");
    expect(new Set(calls.map(r => r.path))).toEqual(new Set(["/vibedeckx", "/cross-remote"]));
    expect(calls.every(r => r.authorizationMatched === true)).toBe(true);
  });

  it("retains model override, system prompt, parameter and authentication evidence", () => {
    for (const name of ["model-load", "model-resume"]) {
      expect(response(name, 2).result.configOptions.find((c: { id: string }) => c.id === "model").currentValue).toBe("openai/gpt-5.4-mini");
    }
    expect(text(turn("session-parameters-model", 8))).toBe("SYSTEM_PROMPT_OK");
    const errors = messages("session-parameters-model").filter(m => m.error);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(m => m.error.code === -32602)).toBe(true);
    expect(response("unauthenticated", 1).error.code).toBe(-32600);
  });
});
