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
