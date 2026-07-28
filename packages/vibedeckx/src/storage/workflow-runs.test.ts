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

  it("discussing runs count as active in all three active queries", async () => {
    await storage.workflowRuns.create(baseRun);
    await storage.workflowRuns.update("r1", { reviewer_session_id: "s-rev", status: "discussing" });
    expect((await storage.workflowRuns.getActive("p1", "dev")).map((r) => r.id)).toEqual(["r1"]);
    expect((await storage.workflowRuns.getAllActive()).map((r) => r.id)).toEqual(["r1"]);
    expect((await storage.workflowRuns.getActiveBySession("s-rev"))?.id).toBe("r1");
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

  /**
   * A workflow attention milestone has to be tied to the state transition that
   * proves it. Writing the outbox row next to the CAS instead of inside it
   * would let a lost CAS still notify ("review ready" for a run someone else
   * already advanced), or a won CAS notify nothing.
   */
  describe("transitionWithOutbox", () => {
    const outbox = {
      id: "workflow:r1:review-ready",
      kind: "review_ready" as const,
      project_id: "p1",
      branch: "dev",
      session_id: "s-rev",
      workflow_run_id: "r1",
      created_at: 500,
    };

    it("inserts the outbox row when the guarded update applies", async () => {
      await storage.workflowRuns.create(baseRun);
      const ok = await storage.workflowRuns.transitionWithOutbox(
        "r1", "waiting_reviewer", "waiting_feedback", { feedback_snapshot: "looks wrong" }, outbox,
      );
      expect(ok).toBe(true);
      expect((await storage.workflowRuns.getById("r1"))?.status).toBe("waiting_feedback");
      expect((await storage.workflowRuns.getById("r1"))?.feedback_snapshot).toBe("looks wrong");
      const rows = await storage.notificationOutbox.listAfter(0, 100);
      expect(rows.map((r) => r.id)).toEqual(["workflow:r1:review-ready"]);
      expect(rows[0].session_id).toBe("s-rev");
      expect(rows[0].workflow_run_id).toBe("r1");
    });

    it("a lost compare-and-set writes no outbox row", async () => {
      await storage.workflowRuns.create(baseRun);
      // Someone else already advanced the run.
      await storage.workflowRuns.transition("r1", "waiting_reviewer", "waiting_feedback");

      const ok = await storage.workflowRuns.transitionWithOutbox(
        "r1", "waiting_reviewer", "waiting_feedback", undefined, outbox,
      );
      expect(ok).toBe(false);
      expect(await storage.notificationOutbox.listAfter(0, 100)).toEqual([]);
    });

    it("a retried transition cannot produce a second notification", async () => {
      await storage.workflowRuns.create(baseRun);
      await storage.workflowRuns.transitionWithOutbox(
        "r1", "waiting_reviewer", "waiting_feedback", undefined, outbox,
      );
      // Force the same id through a second winning CAS (round-trip the status).
      await storage.workflowRuns.transition("r1", "waiting_feedback", "waiting_reviewer");
      await storage.workflowRuns.transitionWithOutbox(
        "r1", "waiting_reviewer", "waiting_feedback", undefined, outbox,
      );
      expect(await storage.notificationOutbox.listAfter(0, 100)).toHaveLength(1);
    });
  });

  it("defaults review_span to this_turn and round-trips an explicit span", async () => {
    const run = await storage.workflowRuns.create(baseRun);
    expect(run.review_span).toBe("this_turn");
    const run2 = await storage.workflowRuns.create({ ...baseRun, id: "r2", review_span: "session_start" });
    expect(run2.review_span).toBe("session_start");
  });
});
