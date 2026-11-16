import { describe, expect, it } from "vitest";
import { normalizeFxTool } from "./tool-mapping.js";

describe("fx existing tool cards", () => {
  it.each([
    ["read_file", "Read", { path: "a", start_line: 2, line_count: 3 }, { file_path: "a", offset: 2, limit: 3 }],
    ["write_file", "Write", { path: "a", content: "new" }, { file_path: "a", content: "new" }],
    ["edit_file", "Edit", { path: "a", old_string: "old", new_string: "new" }, { file_path: "a", old_string: "old", new_string: "new" }],
    ["shell", "Bash", { command: "pwd" }, { command: "pwd" }],
    ["shell", "Bash", { action: "interact", session_id: "s", input: "x" }, { action: "interact", session_id: "s", input: "x" }],
    ["shell", "Bash", { action: "stop", session_id: "s" }, { action: "stop", session_id: "s" }],
    ["glob_files", "Glob", { pattern: "*.ts", path: "." }, { pattern: "*.ts" }],
    ["grep_files", "Grep", { pattern: "text", path: ".", include: "*.txt" }, { pattern: "text", glob: "*.txt" }],
    ["web_search", "WebSearch", { query: "text" }, { query: "text" }],
    ["web_fetch", "WebFetch", { url: "https://example.com" }, { url: "https://example.com", prompt: "" }],
    ["subagent", "Agent", { action: "message", agent: "worker", message: "work" }, { description: "worker", subagent_type: "general-purpose", prompt: "work" }],
    ["subagent", "Agent", { action: "wait" }, { description: "wait", prompt: "" }],
    ["ask_user_question", "AskUserQuestion", { questions: [{ question: "Color?", options: [{ label: "Blue" }] }] }, { questions: [{ question: "Color?", header: "Question 1", options: [{ label: "Blue" }] }] }],
  ])("%s maps to %s with readable inputs", (name, canonical, input, expected) => {
    expect(normalizeFxTool(name, input)).toMatchObject({ name: canonical, input: expected });
  });
  it.each(["toolbox", "vision", "read_tool_result", "install_skill", "future_tool", "mcp_ambiguous_server_tool", "constructor"])("preserves generic %s", name => {
    const input = { action: "inspect", arbitrary: [1, 2] };
    expect(normalizeFxTool(name, input)).toEqual({ name, input });
  });
  it("uses authoritative MCP metadata without splitting underscores or mapping a remote builtin name", () => {
    expect(normalizeFxTool("shell", { x: 1 }, { fx: { toolCall: { mcp: { server: "my_server", tool: "read_file" } } } })).toEqual({ name: "mcp__my_server__read_file", input: { x: 1 } });
    expect(normalizeFxTool("mcp_server_tool", {}, { fx: { toolCall: { mcp: { server: 1, tool: null } } } }).name).toBe("mcp_server_tool");
  });
});
