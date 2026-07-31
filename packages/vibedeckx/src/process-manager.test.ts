import { describe, expect, it } from "vitest";
import { clearBinaryCaches, detectBinary } from "./protocol/shared/binary.js";
import { ProcessEffectConflictError, ProcessManager } from "./process-manager.js";
import type { Executor } from "./storage/types.js";

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

describe("ProcessManager preallocated process identity", () => {
  it("reuses only the identical effect for a preallocated process identity", async () => {
    const pm = new ProcessManager(null as never);
    const executor: Executor = {
      id: "schedule-s1", project_id: "p1", group_id: "", name: "scheduled",
      command: "sleep 5", executor_type: "command", prompt_provider: null,
      cwd: null, pty: true, position: 0, disabled_targets: [],
      created_at: new Date().toISOString(),
    };
    try {
      await expect(pm.start(executor, "/tmp", true, "schedule-run-stable"))
        .resolves.toBe("schedule-run-stable");
      await expect(pm.start(executor, "/tmp", true, "schedule-run-stable"))
        .resolves.toBe("schedule-run-stable");
      await expect(pm.start({ ...executor, command: "echo duplicate" }, "/tmp", true, "schedule-run-stable"))
        .rejects.toBeInstanceOf(ProcessEffectConflictError);
      expect(pm.getProcessesByExecutorId("schedule-s1")).toHaveLength(1);
    } finally {
      await pm.stop("schedule-run-stable");
    }
  });
});
