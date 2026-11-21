import { describe, expect, it } from "vitest";
import {
  buildClaudeMcpConfigArg,
  buildClaudeModelsProbe,
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

  it("appends an allowlist after --mcp-config so MCP tools skip the permission prompt", () => {
    const args = buildClaudeSessionSpawnConfig(
      "/bin/claude", "plan", '{"mcpServers":{}}', null, ["mcp__vibedeckx__propose_schedule"],
    ).args;
    expect(args.slice(-4)).toEqual([
      "--mcp-config",
      '{"mcpServers":{}}',
      "--allowedTools",
      "mcp__vibedeckx__propose_schedule",
    ]);
  });

  it("omits --allowedTools entirely when nothing is allowlisted", () => {
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, null, []).args)
      .not.toContain("--allowedTools");
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit").args).not.toContain("--allowedTools");
  });

  it("serializes multiple HTTP MCP servers into one --mcp-config payload", () => {
    const arg = buildClaudeMcpConfigArg({
      "cross-remote": { url: "https://app.example.com/api/cross-remote-mcp", token: "cross-token" },
      vibedeckx: { url: "http://127.0.0.1:5173/api/session-mcp", token: "session-token" },
    });
    expect(JSON.parse(arg)).toEqual({
      mcpServers: {
        "cross-remote": {
          type: "http",
          url: "https://app.example.com/api/cross-remote-mcp",
          headers: { Authorization: "Bearer cross-token" },
        },
        vibedeckx: {
          type: "http",
          url: "http://127.0.0.1:5173/api/session-mcp",
          headers: { Authorization: "Bearer session-token" },
        },
      },
    });
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

describe("claude models probe", () => {
  const response = (models: unknown[], requestId = "vibedeckx-models") => JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { commands: [], models } },
  });

  it("spawns stream-json without a prompt and sends only the initialize control request", () => {
    const { config, probe } = buildClaudeModelsProbe("/bin/claude", 5000);
    expect(config).toEqual({ command: "/bin/claude", args: ["--output-format=stream-json", "--input-format=stream-json", "--verbose"] });
    expect(probe.initial.map((l) => JSON.parse(l))).toEqual([
      { type: "control_request", request_id: "vibedeckx-models", request: { subtype: "initialize" } },
    ]);
  });

  it("answers the model values minus 'default', deduped (2.1.325 shape)", () => {
    const { probe } = buildClaudeModelsProbe(null, 5000);
    expect(probe.onLine('{"type":"system","subtype":"hook"}')).toBeUndefined();
    expect(probe.onLine("not json")).toBeUndefined();
    expect(probe.onLine(response([{ value: "x" }], "other-request"))).toBeUndefined();
    expect(probe.onLine(response([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
      { value: "opus" }, { value: "claude-opus-5" }, { value: "opus" },
    ]))).toEqual({ done: ["opus", "claude-opus-5"] });
  });

  it("fails on a control_response without a models list", () => {
    const { probe } = buildClaudeModelsProbe(null, 5000);
    expect(() => probe.onLine(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "vibedeckx-models" } }))).toThrow();
  });
});
