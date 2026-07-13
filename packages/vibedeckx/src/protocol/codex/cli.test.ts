import { describe, expect, it } from "vitest";
import { buildCodexAppServerSpawnConfig, buildCodexExecCommand } from "./cli.js";

describe("codex CLI builders", () => {
  it("builds app-server spawn config for a native binary", () => {
    expect(buildCodexAppServerSpawnConfig("/usr/local/bin/codex")).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server"],
      shell: false,
    });
  });

  it("falls back to npx for app-server", () => {
    expect(buildCodexAppServerSpawnConfig(null)).toEqual({
      command: "npx",
      args: ["-y", "@openai/codex", "app-server"],
      shell: false,
    });
  });

  it("injects cross-remote MCP into a native app-server without exposing the token in args", () => {
    const config = buildCodexAppServerSpawnConfig("/usr/local/bin/codex", {
      url: "https://app.example.com/api/cross-remote-mcp",
      token: "secret-token",
    });

    expect(config).toEqual({
      command: "/usr/local/bin/codex",
      args: [
        "app-server",
        "-c",
        'mcp_servers.cross-remote={ url = "https://app.example.com/api/cross-remote-mcp", bearer_token_env_var = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN" }',
      ],
      env: { VIBEDECKX_CROSS_REMOTE_MCP_TOKEN: "secret-token" },
      shell: false,
    });
    expect(JSON.stringify(config.args)).not.toContain("secret-token");
  });

  it("injects cross-remote MCP into the npx app-server fallback", () => {
    const config = buildCodexAppServerSpawnConfig(null, {
      url: "https://app.example.com/api/cross-remote-mcp",
      token: "secret-token",
    });

    expect(config.args).toEqual([
      "-y",
      "@openai/codex",
      "app-server",
      "-c",
      'mcp_servers.cross-remote={ url = "https://app.example.com/api/cross-remote-mcp", bearer_token_env_var = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN" }',
    ]);
    expect(config.env).toEqual({ VIBEDECKX_CROSS_REMOTE_MCP_TOKEN: "secret-token" });
  });

  it("builds the exec command exactly as process-manager did (native)", () => {
    expect(buildCodexExecCommand("/usr/local/bin/codex", "do the thing", "/tmp/last.txt")).toBe(
      `/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox exec 'do the thing' --output-last-message '/tmp/last.txt'`,
    );
  });

  it("builds the exec command exactly as process-manager did (npx, no result file)", () => {
    expect(buildCodexExecCommand(null, "hello")).toBe(
      `npx -y @openai/codex --dangerously-bypass-approvals-and-sandbox exec 'hello'`,
    );
  });

  it("escapes single quotes in the prompt", () => {
    expect(buildCodexExecCommand("/bin/codex", "it's fine")).toBe(
      `/bin/codex --dangerously-bypass-approvals-and-sandbox exec 'it'\\''s fine'`,
    );
  });
});
