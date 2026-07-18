import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("workflowRuns repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-wfr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseRun = {
    id: "r1",
    project_id: "p1",
    branch: "dev",
    source_session_id: "s-src",
    source_turn_end_index: 42,
    review_focus: null,
    review_target: JSON.stringify({ baseHead: "abc", diffDigest: "d", capturedAt: 1 }),
  };

  it("creates a run with waiting_reviewer status", async () => {
    const run = await storage.workflowRuns.create(baseRun);
    expect(run.status).toBe("waiting_reviewer");
    expect(run.source_turn_end_index).toBe(42);
    expect(run.reviewer_session_id).toBeNull();
  });

  it("getActive filters by workspace and non-terminal status", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.create({ ...baseRun, id: "r2", branch: "other" });
    const active = await storage.workflowRuns.getActive("p1", "dev");
    expect(active.map((r) => r.id)).toEqual(["r1"]);
    await storage.workflowRuns.update("r1", { status: "completed" });
    expect(await storage.workflowRuns.getActive("p1", "dev")).toEqual([]);
  });

  it("getActiveBySession matches source and reviewer ids", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.update("r1", { reviewer_session_id: "s-rev" });
    expect((await storage.workflowRuns.getActiveBySession("s-src"))?.id).toBe("r1");
    expect((await storage.workflowRuns.getActiveBySession("s-rev"))?.id).toBe("r1");
    expect(await storage.workflowRuns.getActiveBySession("nope")).toBeUndefined();
  });

  it("getLatestCompletedBySource returns the newest completed run with a reviewer", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.update("r1", {
      reviewer_session_id: "rev-old",
      status: "completed",
    });
    await storage.workflowRuns.create({ ...baseRun, id: "r2" });
    await storage.workflowRuns.update("r2", {
      reviewer_session_id: "rev-new",
      status: "completed",
    });

    expect(
      (await storage.workflowRuns.getLatestCompletedBySource("s-src"))?.reviewer_session_id,
    ).toBe("rev-new");
  });

  it("getLatestCompletedBySource ignores non-completed and reviewer-less runs", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.update("r1", { status: "completed" });
    await storage.workflowRuns.create({ ...baseRun, id: "r2" });
    await storage.workflowRuns.update("r2", {
      reviewer_session_id: "rev-cancelled",
      status: "cancelled",
    });

    expect(await storage.workflowRuns.getLatestCompletedBySource("s-src")).toBeUndefined();
  });

  it("transition is an atomic CAS", async () => {
    await storage.workflowRuns.create(baseRun);
    const ok = await storage.workflowRuns.transition("r1", "waiting_reviewer", "waiting_feedback", {
      feedback_snapshot: "looks wrong",
    });
    expect(ok).toBe(true);
    const again = await storage.workflowRuns.transition("r1", "waiting_reviewer", "waiting_feedback");
    expect(again).toBe(false); // status no longer waiting_reviewer
    const run = await storage.workflowRuns.getById("r1");
    expect(run?.status).toBe("waiting_feedback");
    expect(run?.feedback_snapshot).toBe("looks wrong");
  });

  it("getAllActive returns non-terminal runs across workspaces", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.create({ ...baseRun, id: "r2", branch: "other" });
    await storage.workflowRuns.update("r2", { status: "cancelled" });
    expect((await storage.workflowRuns.getAllActive()).map((r) => r.id)).toEqual(["r1"]);
  });
});
