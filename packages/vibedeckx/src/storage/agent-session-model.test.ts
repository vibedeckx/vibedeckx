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

  it("updateModel sets, overwrites, and clears the model", async () => {
    // The one post-create writer is switchAgentType, which must be able to
    // clear an inherited (now agent-incompatible) name back to the CLI default.
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });

    await storage.agentSessions.updateModel("s1", "opus");
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("opus");

    await storage.agentSessions.updateModel("s1", "gpt-5.6-sol");
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("gpt-5.6-sol");

    await storage.agentSessions.updateModel("s1", null);
    expect((await storage.agentSessions.getById("s1"))?.model ?? null).toBeNull();
  });

  it("updateModel touches updated_at, like updateAgentType", async () => {
    // Mirrors updateAgentType: a model change is a real user-facing edit, so
    // it must move the session in the recency ordering getLatestByBranch uses.
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    const before = (await storage.agentSessions.getById("s1"))!.updated_at;

    await new Promise((r) => setTimeout(r, 5));
    await storage.agentSessions.updateModel("s1", "opus");

    expect((await storage.agentSessions.getById("s1"))!.updated_at).not.toBe(before);
  });

  it("listByBranch carries the model through to session summaries", async () => {
    // The two list routes serialize DB rows with `...s`, so this mapping is
    // what makes the model appear in the session-history dropdown (Task 9).
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev", model: "opus" });
    const rows = await storage.agentSessions.listByBranch("p1", "dev");
    expect(rows.find((r) => r.id === "s1")?.model).toBe("opus");
  });
});
