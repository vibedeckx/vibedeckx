import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createSqliteStorage } from "./storage/sqlite.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { Storage } from "./storage/types.js";
import { SESSION_LIFECYCLE_LOG_PREFIX } from "./session-lifecycle-log.js";

/**
 * Phase 0 of the prepared-session lifecycle design: the manager's existing
 * create / first-send / discard paths emit `[SessionLifecycle]` lines that
 * let the orphan rate be measured. These pin the contract of those lines —
 * one `created` per identity, exactly one first-instruction outcome, a named
 * outcome for every discard — without changing what the paths do.
 */
describe("AgentSessionManager lifecycle logging (Phase 0)", () => {
  let dir: string;
  let storage: Storage;
  let manager: AgentSessionManager;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  const lifecycleLines = () => lines.filter((line) => line.startsWith(SESSION_LIFECYCLE_LOG_PREFIX));
  const events = (name: string) => lifecycleLines().filter((line) => line.includes(` event=${name} `) || line.endsWith(` event=${name}`));

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-lifecycle-log-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    const spawn = vi.fn(async (session: { process: unknown }) => {
      session.process = { exitCode: null, kill: vi.fn(), stdin: { write: vi.fn() } };
    });
    (manager as unknown as { spawnAgent: typeof spawn }).spawnAgent = spawn;
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await manager.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs created with the caller's purpose and operation id, then exactly one first-instruction accept", async () => {
    const id = await manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, {
      sessionId: "s-cmd", purpose: "commander", operationId: "call-1",
    });
    expect(id).toBe("s-cmd");
    const created = events("created");
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("sessionId=s-cmd");
    expect(created[0]).toContain("purpose=commander");
    expect(created[0]).toContain("operationId=call-1");
    expect(created[0]).toContain("recovered=false");

    expect(await manager.sendUserMessage("s-cmd", "first", dir)).toBe(true);
    expect(await manager.sendUserMessage("s-cmd", "second", dir)).toBe(true);

    const accepted = events("first_instruction_accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain("purpose=commander");
    expect(accepted[0]).toContain("operationId=call-1");
    expect(accepted[0]).toMatch(/msSinceCreated=\d+/);
    expect(events("first_instruction_rejected")).toHaveLength(0);
  });

  it("defaults purpose to interactive and logs a provider rejection once", async () => {
    await manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "s-ui" });
    expect(events("created")[0]).toContain("purpose=interactive");

    // No stdin: the resident path refuses the send without touching the store.
    (manager.getSession("s-ui") as unknown as { process: unknown }).process = null;
    expect(await manager.sendUserMessage("s-ui", "hello", dir)).toBe(false);

    const rejected = events("first_instruction_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("reason=provider_rejected");
    expect(events("first_instruction_accepted")).toHaveLength(0);
  });

  it("names the discard outcome: discarded for an empty session, retained_has_entries once a turn exists", async () => {
    await manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "s-empty" });
    expect(await manager.discardSessionIfEmpty("s-empty")).toBe(true);
    expect(events("discard")).toEqual([
      `${SESSION_LIFECYCLE_LOG_PREFIX} event=discard sessionId=s-empty outcome=discarded`,
    ]);

    await manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "s-used" });
    expect(await manager.sendUserMessage("s-used", "hello", dir)).toBe(true);
    expect(await manager.discardSessionIfEmpty("s-used")).toBe(false);
    expect(events("discard").at(-1)).toBe(
      `${SESSION_LIFECYCLE_LOG_PREFIX} event=discard sessionId=s-used outcome=retained_has_entries`,
    );
  });

  it("recovering a stored zero-entry identity logs recovered=true and still awaits its first instruction", async () => {
    await storage.agentSessions.create({ id: "stored", project_id: "p1", branch: "", permission_mode: "edit", agent_type: "claude-code" });
    await storage.agentSessions.updateStatus("stored", "stopped");
    await manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false, { sessionId: "stored" });
    expect(events("created")[0]).toContain("recovered=true");
    expect(await manager.sendUserMessage("stored", "hello", dir)).toBe(true);
    expect(events("first_instruction_accepted")).toHaveLength(1);
  });

  it("reports the zero-entry row count as a boot baseline", async () => {
    await storage.agentSessions.create({ id: "z1", project_id: "p1", branch: "", permission_mode: "edit", agent_type: "claude-code" });
    await storage.agentSessions.create({ id: "z2", project_id: "p1", branch: "", permission_mode: "edit", agent_type: "claude-code" });
    const booted = new AgentSessionManager(storage);
    try {
      await booted.restoreSessionsFromDb();
      expect(events("boot_zero_entry_rows")).toEqual([
        `${SESSION_LIFECYCLE_LOG_PREFIX} event=boot_zero_entry_rows count=2`,
      ]);
    } finally {
      await booted.shutdown();
    }
  });
});
