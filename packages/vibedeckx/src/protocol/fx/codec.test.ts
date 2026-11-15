import { describe, expect, it } from "vitest";
import { buildInitialize, buildSessionNew, buildPrompt, buildCancel, parseFxLine } from "./codec.js";

describe("fx ACP codec", () => {
  it("builds v1 initialization, append-only system prompts, images and notification cancellation", () => {
    expect(JSON.parse(buildInitialize(1)).params.protocolVersion).toBe(1);
    expect(JSON.parse(buildSessionNew(2, { cwd: "/work", systemPrompt: "instructions" })).params).toEqual({ cwd: "/work", mcpServers: [], systemPrompt: [{ type: "text", text: "instructions" }], systemPromptMode: "append" });
    expect(JSON.parse(buildSessionNew(2, { cwd: "/work", systemPrompt: " " })).params.systemPrompt).toBeUndefined();
    expect(JSON.parse(buildPrompt(3, "native", [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "base64" }])).params.prompt).toEqual([{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "base64" }]);
    expect(JSON.parse(buildCancel("native"))).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "native" } });
  });
  it("separates bidirectional ids and rejects malformed messages", () => {
    expect(parseFxLine('{"jsonrpc":"2.0","id":1,"method":"unknown","params":{}}').kind).toBe("server_request");
    for (const line of ["not-json", "null", "{}", '{"jsonrpc":"2.0","method":"session/update","params":{}}']) expect(parseFxLine(line).kind).toBe("invalid");
  });
});
