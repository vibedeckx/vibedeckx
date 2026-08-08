import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      id: "schedule-s1", project_id: "p1", workspace_id: "", name: "scheduled",
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
      await vi.waitFor(() => expect(pm.getProcessesByExecutorId("schedule-s1")[0]?.logs)
        .toContainEqual(expect.objectContaining({ type: "finished" })));
      const retained = pm as unknown as { processes: Map<string, unknown>; processEffects: Map<string, string> };
      expect(retained.processEffects.size).toBe(retained.processes.size);
    }
  });

  it("replays an identical preallocated effect after fast completion while logs are retained", async () => {
    const pm = new ProcessManager(null as never);
    const executor: Executor = {
      id: "schedule-fast", project_id: "p1", workspace_id: "", name: "fast",
      command: "true", executor_type: "command", prompt_provider: null,
      cwd: null, pty: true, position: 0, disabled_targets: [],
      created_at: new Date().toISOString(),
    };

    await expect(pm.start(executor, "/tmp", true, "schedule-run-fast", "stable-effect"))
      .resolves.toBe("schedule-run-fast");
    await vi.waitFor(() => expect(pm.getProcessesByExecutorId("schedule-fast")[0]?.logs)
      .toContainEqual(expect.objectContaining({ type: "finished" })));

    await expect(pm.start(executor, "/tmp", true, "schedule-run-fast", "stable-effect"))
      .resolves.toBe("schedule-run-fast");
    await expect(pm.start({ ...executor, command: "echo different" }, "/tmp", true,
      "schedule-run-fast", "different-effect"))
      .rejects.toBeInstanceOf(ProcessEffectConflictError);
    expect(pm.getProcessesByExecutorId("schedule-fast")).toHaveLength(1);
  });
});

describe("ProcessManager processes under a path", () => {
  let base: string;
  let pm: ProcessManager;
  const started: string[] = [];

  const longRunning = (id: string): Executor => ({
    id, project_id: "p1", workspace_id: "", name: id,
    command: "sleep 30", executor_type: "command", prompt_provider: null,
    cwd: null, pty: true, position: 0, disabled_targets: [],
    created_at: new Date().toISOString(),
  });

  const startIn = async (id: string, cwd: string): Promise<string> => {
    const processId = await pm.start(longRunning(id), cwd, true);
    started.push(processId);
    return processId;
  };

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "vdx-pm-under-path-"));
    pm = new ProcessManager(null as never);
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((id) => pm.stop(id)));
    rmSync(base, { recursive: true, force: true });
  });

  it("matches the directory itself and its descendants but not a name-prefixed sibling", async () => {
    const dev = path.join(base, "dev");
    const nested = path.join(dev, "packages", "app");
    const sibling = path.join(base, "dev2");
    for (const dir of [dev, nested, sibling]) mkdirSync(dir, { recursive: true });

    const inRoot = await startIn("e-root", dev);
    const inNested = await startIn("e-nested", nested);
    const inSibling = await startIn("e-sibling", sibling);

    const matched = pm.getRunningProcessIdsUnderPath(dev);

    expect(matched).toEqual(expect.arrayContaining([inRoot, inNested]));
    expect(matched).not.toContain(inSibling);
    expect(matched).toHaveLength(2);
  });

  it("keeps children whose names begin with two dots", async () => {
    const dev = path.join(base, "dev");
    // A ".." prefix test would relativize "..cache" to "..cache" and read the
    // leading dots as a traversal, silently skipping the process inside it.
    const dotted = path.join(dev, "..cache", "app");
    mkdirSync(dotted, { recursive: true });

    const inDotted = await startIn("e-dotted", dotted);

    expect(pm.getRunningProcessIdsUnderPath(dev)).toContain(inDotted);
  });

  it("omits processes that have already exited", async () => {
    const dev = path.join(base, "dev");
    mkdirSync(dev, { recursive: true });
    const shortLived = await pm.start({ ...longRunning("e-done"), command: "true" }, dev, true);
    started.push(shortLived);

    await vi.waitFor(() => expect(pm.getProcessesByExecutorId("e-done")[0]?.logs)
      .toContainEqual(expect.objectContaining({ type: "finished" })));

    expect(pm.getRunningProcessIdsUnderPath(dev)).not.toContain(shortLived);
  });
});

describe("ProcessManager confirmed stop", () => {
  let base: string;
  let pm: ProcessManager;

  const pidOf = (processId: string): number => (pm as unknown as {
    processes: Map<string, { process: { pid: number } }>;
  }).processes.get(processId)!.process.pid;

  const pidIsAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const start = (command: string): Promise<string> => pm.start({
    id: "e-stop", project_id: "p1", workspace_id: "", name: "run",
    command, executor_type: "command", prompt_provider: null,
    cwd: null, pty: true, position: 0, disabled_targets: [],
    created_at: new Date().toISOString(),
  }, base, true);

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "vdx-pm-stop-"));
    pm = new ProcessManager(null as never);
  });

  afterEach(() => {
    pm.shutdown();
    rmSync(base, { recursive: true, force: true });
  });

  it("does not resolve until a well-behaved process has actually exited", async () => {
    const processId = await start("sleep 30");
    const pid = pidOf(processId);
    expect(pidIsAlive(pid)).toBe(true);

    await expect(pm.stopAndWait(processId)).resolves.toBe(true);

    // Checked with no intervening await: the contract is that the process is
    // gone by the time the promise resolves, not shortly afterwards.
    expect(pidIsAlive(pid)).toBe(false);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    // The PTY spawns `$SHELL -c <command>`, so `exec` is what makes the
    // SIGTERM-ignoring process the very one stopAndWait is tracking, rather
    // than a child of it that the shell would outlive.
    //
    // The ready file closes the spawn race: signalling before bash has exec'd
    // into node would hit plain bash, which dies on SIGTERM and would make
    // this test pass without ever reaching the escalation path. It is written
    // after the handler is installed, so its presence proves both.
    const ready = path.join(base, "ready");
    const processId = await start(
      `exec ${process.execPath} -e 'process.on("SIGTERM", () => {});`
      + ` setInterval(() => {}, 1000); require("fs").writeFileSync("${ready}", "")'`,
    );
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const pid = pidOf(processId);
    expect(pidIsAlive(pid)).toBe(true);

    await expect(pm.stopAndWait(processId, { termGraceMs: 300 })).resolves.toBe(true);

    expect(pidIsAlive(pid)).toBe(false);
  });
});
