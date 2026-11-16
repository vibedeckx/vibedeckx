// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMessageItem } from "./agent-message";
import { normalizeFxTool } from "../../../../packages/vibedeckx/src/protocol/fx/tool-mapping";

const sendMessage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./agent-conversation", () => ({ useAgentConversation: () => ({ sendMessage, messages: [] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root?.unmount()); container?.remove(); sendMessage.mockClear(); });
async function render(name: string, input: unknown) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const mapped = normalizeFxTool(name, input);
  await act(async () => root.render(<AgentMessageItem message={{ type: "tool_use", tool: mapped.name, input: mapped.input, toolUseId: "fx-tool", timestamp: Date.now() }} messageIndex={0} />));
}
describe("fx tools reuse existing cards", () => {
  it.each([
    ["read_file", { path: "probe.txt" }, "Read File", "probe.txt"],
    ["edit_file", { path: "probe.txt", old_string: "before", new_string: "after" }, "Edit File", "before"],
    ["write_file", { path: "probe.txt", content: "new content" }, "Write File", "new content"],
    ["shell", { command: "printf HELLO" }, "Run Command", "printf HELLO"],
    ["shell", { action: "stop", session_id: "shell-2" }, "Run Command", "shell-2"],
    ["glob_files", { pattern: "*.ts" }, "Glob", "*.ts"],
    ["grep_files", { pattern: "needle" }, "Search", "needle"],
    ["web_search", { query: "search text" }, "Web Search", "search text"],
    ["web_fetch", { url: "https://example.com/path" }, "Fetch Web Page", "example.com/path"],
    ["subagent", { action: "message", agent: "worker", message: "do work" }, "Agent", "worker"],
    ...["toolbox", "vision", "read_tool_result", "install_skill"].map(name => [name, { value: "readable raw input" }, `Tool: ${name}`, "readable raw input"] as const),
  ] as const)("renders %s", async (name, input, title, text) => {
    await render(name, input);
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(text);
  });
  it("submits an ACP question as a follow-up user message", async () => {
    await render("ask_user_question", { questions: [{ question: "Select a color", options: [{ label: "Blue", description: "Blue color" }] }] });
    expect(container.textContent).toContain("Select a color");
    const buttons = () => Array.from(container.querySelectorAll("button"));
    await act(async () => buttons().find(b => b.textContent?.includes("Blue color"))!.click());
    await act(async () => buttons().find(b => b.textContent === "Submit")!.click());
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Blue"));
  });
});
