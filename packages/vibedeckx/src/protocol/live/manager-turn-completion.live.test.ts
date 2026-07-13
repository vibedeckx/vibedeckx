import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../../agent-session-manager.js";
import { EventBus, type GlobalEvent } from "../../event-bus.js";
import { createSqliteStorage } from "../../storage/sqlite.js";
import { claudeBinaryAvailable, codexBinaryAvailable, compatRequired } from "./runner.js";

/**
 * Live end-to-end probe for turn completion through the FULL manager stack:
 * real sqlite storage → spawnAgent (real claude CLI) → stdout serial queue →
 * TurnCompletionLedger → grace timer → commitCompletion.
 *
 * Scenario is the premature-completion race this ledger exists for: two
 * background subagents that finish almost instantly, so their
 * task_notification events land BEFORE the first result and the main agent
 * is auto-resumed twice (3 results total). Exactly one taskCompleted must
 * come out the other end, and it must be the last result.
 */

const available = claudeBinaryAvailable();

if (!available && compatRequired()) {
  throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no claude binary available");
}

const PROMPT =
  "Do not modify any files. Launch exactly two Agent subagents concurrently in one turn, " +
  "both with run_in_background=true. Each should immediately return the single word OK " +
  "without reading anything. Wait for both, then reply FINAL.";

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const codexAvailable = codexBinaryAvailable();

describe.skipIf(!codexAvailable)("manager turn-completion live probe (codex)", () => {
  it("MGR-2: fire-and-forget collab subagent → no completion until it finishes, then exactly one", { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibedeckx-live-codex-"));
    scratchDirs.push(dir);
    writeFileSync(path.join(dir, "README.md"), "# live probe scratch\n");

    const storage = await createSqliteStorage(path.join(dir, "data.sqlite"));
    await storage.projects.create({ id: "p-live-cx", name: "live-probe-codex", path: dir });

    const manager = new AgentSessionManager(storage);
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    try {
      const sessionId = await manager.createNewSession("p-live-cx", null, dir, false, "edit", "codex");
      const sent = await manager.sendUserMessage(
        sessionId,
        "Do not modify any files. Spawn exactly one background agent (your agent/collab tool) whose task is to reply with the single word OK. Do NOT wait for it: end your turn right away with the single word LAUNCHED.",
        dir,
      );
      expect(sent).toBe(true);

      const completedCount = () => events.filter((e) => e.type === "session:taskCompleted").length;

      // The main turn ends quickly (LAUNCHED) while the subagent still runs —
      // the parked result must not commit until the subagent's turn completes.
      const deadline = Date.now() + 200_000;
      while (completedCount() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(completedCount(), "no taskCompleted within the deadline").toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 10_000));

      expect(completedCount()).toBe(1);
      expect(events.filter((e) => e.type === "branch:activity" && e.activity === "completed")).toHaveLength(1);
    } finally {
      manager.shutdown();
    }
  });
});

describe.skipIf(!available)("manager turn-completion live probe", () => {
  it("MGR-1: two fast background subagents → exactly one taskCompleted", { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibedeckx-live-"));
    scratchDirs.push(dir);
    writeFileSync(path.join(dir, "README.md"), "# live probe scratch\n");

    const storage = await createSqliteStorage(path.join(dir, "data.sqlite"));
    await storage.projects.create({ id: "p-live", name: "live-probe", path: dir });

    const manager = new AgentSessionManager(storage);
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    manager.setEventBus(bus);

    try {
      const sessionId = await manager.createNewSession("p-live", null, dir);
      const sent = await manager.sendUserMessage(sessionId, PROMPT, dir);
      expect(sent).toBe(true);

      const completedCount = () => events.filter((e) => e.type === "session:taskCompleted").length;

      // Wait for the first completion (the whole run: launch, two subagents,
      // two auto-resumes), then keep listening well past the grace window to
      // catch any premature/duplicate completions.
      const deadline = Date.now() + 210_000;
      while (completedCount() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(completedCount(), "no taskCompleted within the deadline").toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 10_000));

      expect(completedCount()).toBe(1);
      expect(events.filter((e) => e.type === "branch:activity" && e.activity === "completed")).toHaveLength(1);

      // The completion must be the final turn: by then the DB row is stopped
      // and the completion timestamp covers the whole resume chain.
      const row = await storage.agentSessions.getById(sessionId);
      expect(row?.status).toBe("stopped");
      expect(row?.last_completed_at).toBeGreaterThan(0);
    } finally {
      manager.shutdown();
    }
  });
});
