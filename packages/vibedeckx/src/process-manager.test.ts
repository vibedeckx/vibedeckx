import { describe, expect, it } from "vitest";
import { clearBinaryCaches, detectBinary } from "./protocol/shared/binary.js";
import { ProcessManager } from "./process-manager.js";

// Access the private method for a contract check without spawning anything.
type WithBuildPromptCommand = {
  buildPromptCommand(prompt: string, provider: "claude" | "codex", finalResultFile?: string): string;
};

describe("ProcessManager prompt commands (protocol layer)", () => {
  const pm = new ProcessManager(null as never) as unknown as WithBuildPromptCommand;

  it("routes codex prompts through buildCodexExecCommand", () => {
    clearBinaryCaches();
    const nativeCodex = detectBinary("codex");
    const expectedBase = nativeCodex ?? "npx -y @openai/codex";
    expect(pm.buildPromptCommand("do it", "codex", "/tmp/last.txt")).toBe(
      `${expectedBase} --dangerously-bypass-approvals-and-sandbox exec 'do it' --output-last-message '/tmp/last.txt'`,
    );
  });

  it("routes claude prompts through buildClaudePrintCommand", () => {
    clearBinaryCaches();
    const nativeClaude = detectBinary("claude");
    const expectedBase = nativeClaude ?? "npx -y @anthropic-ai/claude-code";
    expect(pm.buildPromptCommand("hi", "claude")).toBe(
      `${expectedBase} -p 'hi' --dangerously-skip-permissions --verbose`,
    );
  });
});
