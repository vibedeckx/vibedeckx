import { describe, expect, it } from "vitest";
import {
  buildClaudePrintCommand,
  buildClaudeSessionSpawnConfig,
  buildClaudeStreamExecutorSpawn,
} from "./cli.js";

describe("claude CLI builders", () => {
  it("builds session args for edit mode (native)", () => {
    expect(buildClaudeSessionSpawnConfig("/usr/local/bin/claude", "edit")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--disallowedTools",
        "AskUserQuestion",
        "--verbose",
      ],
    });
  });

  it("builds session args for plan mode with mcp-config (npx)", () => {
    const config = buildClaudeSessionSpawnConfig(null, "plan", '{"mcpServers":{}}');
    expect(config.command).toBe("npx");
    expect(config.args).toEqual([
      "-y",
      "@anthropic-ai/claude-code",
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--permission-mode=plan",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });

  it("builds the one-shot stream executor spawn exactly as process-manager did", () => {
    expect(buildClaudeStreamExecutorSpawn("/usr/local/bin/claude")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--verbose",
      ],
    });
    expect(buildClaudeStreamExecutorSpawn(null)).toEqual({
      command: "npx",
      args: [
        "-y",
        "@anthropic-ai/claude-code",
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--verbose",
      ],
    });
  });

  it("builds the -p print command exactly as process-manager did", () => {
    expect(buildClaudePrintCommand("/usr/local/bin/claude", "it's a prompt")).toBe(
      `/usr/local/bin/claude -p 'it'\\''s a prompt' --dangerously-skip-permissions --verbose`,
    );
    expect(buildClaudePrintCommand(null, "hi")).toBe(
      `npx -y @anthropic-ai/claude-code -p 'hi' --dangerously-skip-permissions --verbose`,
    );
  });
});
