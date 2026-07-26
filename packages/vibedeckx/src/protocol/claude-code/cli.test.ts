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

  it("appends --model after the permission flag when a model is given", () => {
    expect(buildClaudeSessionSpawnConfig("/usr/local/bin/claude", "edit", undefined, "opus")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--disallowedTools",
        "AskUserQuestion",
        "--verbose",
      ],
    });
  });

  it("omits --model for null, undefined, and blank model strings", () => {
    const base = [
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
    ];
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, null).args).toEqual(base);
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, undefined).args).toEqual(base);
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, "   ").args).toEqual(base);
  });

  it("passes an unknown model name through verbatim (no validation)", () => {
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, "totally-made-up").args).toContain(
      "totally-made-up",
    );
  });

  it("combines --model with --mcp-config", () => {
    expect(buildClaudeSessionSpawnConfig(null, "plan", '{"mcpServers":{}}', "sonnet").args).toEqual([
      "-y",
      "@anthropic-ai/claude-code",
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--permission-mode=plan",
      "--model",
      "sonnet",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });
});
