import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createSqliteStorage } from "./storage/sqlite.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { Storage } from "./storage/types.js";

describe("AgentSessionManager explicit durable identity", () => {
  let dir: string; let storage: Storage; let manager: AgentSessionManager; let spawn: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-explicit-session-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    spawn = vi.fn(async (session: { process: unknown }) => {
      session.process = { exitCode: null, kill: vi.fn(), stdin: { write: vi.fn() } };
    });
    (manager as unknown as { spawnAgent: typeof spawn }).spawnAgent = spawn;
  });
  afterEach(async () => { await manager.shutdown(); await storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("reuses an exact active explicit id and rejects changed settings", async () => {
    const args = ["p1", null, dir, false, "edit", "claude-code", false, false,
      { sessionId: "stable", model: null }] as const;
    await expect(manager.createNewSession(...args)).resolves.toBe("stable");
    await expect(manager.createNewSession(...args)).resolves.toBe("stable");
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(manager.createNewSession("p1", "other", dir, false, "edit", "claude-code", false, false,
      { sessionId: "stable", model: null })).rejects.toThrow("already in use");
  });

  it("registers and spawns a stopped zero-entry row under the same id", async () => {
    await storage.agentSessions.create({ id: "stored", project_id: "p1", branch: "", permission_mode: "edit", agent_type: "claude-code" });
    await storage.agentSessions.updateStatus("stored", "stopped");
    await expect(manager.createNewSession("p1", null, dir, false, "edit", "claude-code", false, false,
      { sessionId: "stored", model: null })).resolves.toBe("stored");
    expect(manager.getSession("stored")).toMatchObject({ id: "stored", status: "running" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
