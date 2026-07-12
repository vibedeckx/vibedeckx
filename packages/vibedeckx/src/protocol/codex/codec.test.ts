import { describe, expect, it } from "vitest";
import {
  buildApprovalResponse,
  buildCodexInput,
  buildInitialize,
  buildThreadStart,
  buildTurnInterrupt,
  buildTurnStart,
  parseCodexLine,
  threadStartParamsFor,
} from "./codec.js";

describe("parseCodexLine", () => {
  it("classifies an error response", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32600, message: "Not initialized" } });
    expect(parseCodexLine(line)).toEqual({
      kind: "error_response",
      id: 3,
      error: { code: -32600, message: "Not initialized" },
    });
  });

  it("classifies a success response", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "t-1" } } });
    expect(parseCodexLine(line)).toEqual({ kind: "response", id: 2, result: { thread: { id: "t-1" } } });
  });

  it("classifies a server request (id + method)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /tmp/x", cwd: "/tmp" },
    });
    expect(parseCodexLine(line)).toEqual({
      kind: "server_request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /tmp/x", cwd: "/tmp" },
    });
  });

  it("classifies a notification (method, no id)", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t" } } });
    expect(parseCodexLine(line)).toEqual({ kind: "notification", method: "turn/completed", params: { turn: { id: "t" } } });
  });

  it("returns ignored for non-JSON and unmatched shapes", () => {
    expect(parseCodexLine("not json").kind).toBe("ignored");
    expect(parseCodexLine(JSON.stringify({ jsonrpc: "2.0" })).kind).toBe("ignored");
  });

  it("returns ignored for scalar JSON lines", () => {
    expect(parseCodexLine("null").kind).toBe("ignored");
    expect(parseCodexLine("42").kind).toBe("ignored");
  });
});

describe("codex message builders", () => {
  it("builds initialize with our client identity", () => {
    expect(JSON.parse(buildInitialize(1))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } },
    });
    expect(buildInitialize(1).endsWith("\n")).toBe(true);
  });

  it("maps permission modes to sandbox/approvalPolicy", () => {
    expect(threadStartParamsFor("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
    expect(threadStartParamsFor("edit")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(JSON.parse(buildThreadStart(2, "edit"))).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: { sandbox: "danger-full-access", approvalPolicy: "never" },
    });
  });

  it("builds turn/start with text and image input", () => {
    expect(JSON.parse(buildTurnStart(3, "t-1", "hello"))).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: { threadId: "t-1", input: [{ type: "text", text: "hello" }] },
    });
    expect(
      buildCodexInput([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ]),
    ).toEqual([
      { type: "text", text: "look" },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("builds turn/interrupt and approval replies", () => {
    // Real codex interrupt shape (verified live, 0.144.1): a request with its
    // own JSON-RPC id, targeting the turn UUID — not $/cancelRequest.
    expect(JSON.parse(buildTurnInterrupt(5, "thread-1", "019f-turn-uuid"))).toEqual({
      jsonrpc: "2.0",
      id: 5,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "019f-turn-uuid" },
    });
    expect(buildTurnInterrupt(5, "thread-1", "019f-turn-uuid").endsWith("\n")).toBe(true);
    expect(JSON.parse(buildApprovalResponse("7", "accept"))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { decision: "accept" },
    });
  });
});
