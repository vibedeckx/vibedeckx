import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import { CodexProvider } from "./codex-provider.js";

describe("provider buildSpawnConfig model passthrough", () => {
  it("claude puts the model into argv", () => {
    const config = new ClaudeCodeProvider().buildSpawnConfig("/tmp/wt", "edit", undefined, "opus");
    expect(config.args).toContain("--model");
    expect(config.args).toContain("opus");
  });

  it("codex puts the model into a -c override", () => {
    const config = new CodexProvider().buildSpawnConfig("/tmp/wt", "edit", undefined, "o3");
    expect(config.args).toContain('model="o3"');
  });

  it("omits the model when none is given", () => {
    expect(new ClaudeCodeProvider().buildSpawnConfig("/tmp/wt", "edit").args).not.toContain("--model");
    expect(
      new CodexProvider().buildSpawnConfig("/tmp/wt", "edit").args.some((a) => a.startsWith("model=")),
    ).toBe(false);
  });

  it("does not retain the model on the provider instance between spawns", () => {
    // Providers are module-scope singletons shared by every session. A model
    // stored on the instance would leak from one session's spawn into the next.
    const provider = new CodexProvider();
    provider.buildSpawnConfig("/tmp/a", "edit", undefined, "o3");
    const second = provider.buildSpawnConfig("/tmp/b", "edit");
    expect(second.args.some((a) => a.startsWith("model="))).toBe(false);

    const claude = new ClaudeCodeProvider();
    claude.buildSpawnConfig("/tmp/a", "edit", undefined, "opus");
    expect(claude.buildSpawnConfig("/tmp/b", "edit").args).not.toContain("--model");
  });
});
