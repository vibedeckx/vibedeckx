import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider } from "../providers/claude-code-provider.js";
import { CodexProvider } from "../providers/codex-provider.js";
import { CANONICAL_PROPOSE_SCHEDULE_TOOL } from "../session-tools-mcp.js";

/**
 * The propose_schedule card is dispatched on ONE tool name, so both providers
 * must land on it whatever their CLI reports. These fixtures are real lines
 * captured from the live probes (CC-7b / CX-SM1) against claude 2.1.231 and
 * codex-cli 0.147.0 calling the tool over HTTP MCP — the offline half of
 * docs/schedule-proposal-tool-design.md §4 item 7, so a shape change is caught
 * without spending an API call.
 */
const fixture = (file: string): string[] =>
  readFileSync(new URL(file, import.meta.url), "utf8").split("\n").filter((l) => l.trim());

const toolNames = (events: Array<{ type: string; tool?: string }>): string[] =>
  events.filter((e) => e.type === "tool_use" || e.type === "tool_result").map((e) => e.tool ?? "");

describe("session MCP tool naming across providers", () => {
  it("claude reports the canonical mcp__server__tool name and it survives parsing", () => {
    const provider = new ClaudeCodeProvider();
    const events = fixture("./claude-code/__fixtures__/session-mcp-tool-call.jsonl")
      .flatMap((line) => provider.parseStdoutLine(line, "s1"));

    expect(toolNames(events as never)).toContain(CANONICAL_PROPOSE_SCHEDULE_TOOL);
  });

  it("codex reports a bare tool name plus a server field, and is normalized onto it", () => {
    const raw = fixture("./codex/__fixtures__/session-mcp-tool-call.jsonl");
    // What the CLI actually said, so the normalization's premise is visible here.
    const item = JSON.parse(raw[0]).params.item;
    expect(item).toMatchObject({ server: "vibedeckx", tool: "propose_schedule" });

    const provider = new CodexProvider();
    const events = raw.flatMap((line) => provider.parseStdoutLine(line, "s1"));
    const names = toolNames(events as never);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set([CANONICAL_PROPOSE_SCHEDULE_TOOL]));
  });
});
