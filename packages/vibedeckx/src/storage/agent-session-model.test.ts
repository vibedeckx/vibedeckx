import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("agent_sessions.model", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-model-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to null when not supplied", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    expect((await storage.agentSessions.getById("s1"))?.model ?? null).toBeNull();
  });

  it("round-trips a model string", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "", model: "opus" });
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("opus");
  });

  it("stores an arbitrary unvalidated string", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "", model: "not-a-real-model" });
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("not-a-real-model");
  });

  it("listByBranch carries the model through to session summaries", async () => {
    // The two list routes serialize DB rows with `...s`, so this mapping is
    // what makes the model appear in the session-history dropdown (Task 9).
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev", model: "opus" });
    const rows = await storage.agentSessions.listByBranch("p1", "dev");
    expect(rows.find((r) => r.id === "s1")?.model).toBe("opus");
  });
});
