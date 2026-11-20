import { describe, expect, it } from "vitest";
import { buildInitialize, buildSessionNew, buildPrompt, buildCancel, parseFxLine, unwrapFxMcpOutput } from "./codec.js";

describe("fx ACP codec", () => {
  it("builds v1 initialization, append-only system prompts, images and notification cancellation", () => {
    expect(JSON.parse(buildInitialize(1)).params.protocolVersion).toBe(1);
    expect(JSON.parse(buildSessionNew(2, { cwd: "/work", systemPrompt: "instructions" })).params).toEqual({ cwd: "/work", mcpServers: [], systemPrompt: [{ type: "text", text: "instructions" }], systemPromptMode: "append" });
    expect(JSON.parse(buildSessionNew(2, { cwd: "/work", systemPrompt: " " })).params.systemPrompt).toBeUndefined();
    expect(JSON.parse(buildPrompt(3, "native", [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "base64" }])).params.prompt).toEqual([{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "base64" }]);
    expect(JSON.parse(buildCancel("native"))).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "native" } });
  });
  it("injects both hub servers with header arrays", () => {
    const config = { url: "https://hub.example/mcp", token: "session-secret" };
    const params = JSON.parse(buildSessionNew(2, { cwd: "/work", crossRemoteMcp: config, sessionToolsMcp: config })).params;
    expect(params.mcpServers).toEqual(["cross-remote", "vibedeckx"].map(name => ({ type: "http", name, url: config.url, headers: [{ name: "Authorization", value: "Bearer session-secret" }] })));
  });
  it("unwraps complete fx MCP envelopes without discarding truncated output", () => {
    const result = { content: [{ type: "text", text: "[]" }], isError: false };
    expect(unwrapFxMcpOutput(JSON.stringify({ server: "cross-remote", tool: "list_accessible_remotes", result }))).toBe(JSON.stringify(result));
    expect(unwrapFxMcpOutput('{"server":"cross-remote","result":')).toBe('{"server":"cross-remote","result":');
  });
  it("separates bidirectional ids and rejects malformed messages", () => {
    expect(parseFxLine('{"jsonrpc":"2.0","id":1,"method":"unknown","params":{}}').kind).toBe("server_request");
    for (const line of ["not-json", "null", "{}", '{"jsonrpc":"2.0","method":"session/update","params":{}}']) expect(parseFxLine(line).kind).toBe("invalid");
  });
});
