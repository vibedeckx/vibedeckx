import { describe, expect, it } from "vitest";
import { mcpLine, parseMcpLine } from "./codec.js";

describe("MCP stdio codec", () => {
  it("classifies responses, errors, requests, and notifications", () => {
    expect(parseMcpLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toMatchObject({ kind: "response", id: 1 });
    expect(parseMcpLine('{"jsonrpc":"2.0","id":2,"error":{"message":"bad"}}')).toMatchObject({ kind: "error", id: 2 });
    expect(parseMcpLine('{"jsonrpc":"2.0","id":3,"method":"sample","params":{}}')).toMatchObject({ kind: "request", id: 3 });
    expect(parseMcpLine('{"jsonrpc":"2.0","method":"notice"}')).toMatchObject({ kind: "notification" });
    expect(parseMcpLine("not-json")).toEqual({ kind: "ignored" });
  });

  it("writes one newline-delimited JSON-RPC message", () => {
    const line = mcpLine({ id: 1, method: "ping", params: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0", id: 1, method: "ping" });
  });
});
