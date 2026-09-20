import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("workflowRunSteps repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-wfs-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.workflowRuns.create({
      id: "r1", project_id: "p1", branch: "dev", source_session_id: "s-src",
      source_turn_end_index: 4, review_focus: null, review_target: "{}",
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (id: string, kind: "reviewer_prompt" | "rereview_prompt" | "final_verdict" | "feedback", extra: Partial<{ payload_hash: string; session_id: string; role: "source" | "reviewer" }> = {}) =>
    storage.workflowRunSteps.open({
      id, run_id: "r1", kind, role: extra.role ?? (kind === "feedback" ? "source" : "reviewer"),
      session_id: extra.session_id ?? (kind === "feedback" ? "s-src" : "s-rev"),
      idempotency_key: `run:r1:step:${id}`, payload_hash: extra.payload_hash ?? "h",
    });

  it("opens a step at round 1 and reuses it — id, key and payload — while it stays dispatched", async () => {
    const first = await open("a", "reviewer_prompt");
    expect(first).toMatchObject({ reused: false, step: { id: "a", round: 1, status: "dispatched", user_entry_index: null } });
    const again = await open("b", "reviewer_prompt", { payload_hash: "edited" });
    expect(again.reused).toBe(true);
    expect(again.step).toMatchObject({ id: "a", idempotency_key: "run:r1:step:a", payload_hash: "h" });
    expect(await storage.workflowRunSteps.listByRun("r1")).toHaveLength(1);
  });

  it("advances the round per reviewer-side dispatch; feedback shares the round it answers; abandoned steps do not count", async () => {
    const review = await open("a", "reviewer_prompt");
    await storage.workflowRuns.claimStepAndTransition({ stepId: review.step.id, turnEndIndex: 9, outputSnapshot: "v1" });
    expect((await open("b", "final_verdict")).step.round).toBe(2);
    expect(await storage.workflowRunSteps.abandon("b", "never delivered")).toBe(true);
    // The abandoned round-2 attempt never happened: the retry is round 2 again, as a NEW row.
    const retry = await open("c", "final_verdict");
    expect(retry).toMatchObject({ reused: false, step: { id: "c", round: 2 } });
    expect((await open("d", "feedback")).step.round).toBe(2);
  });

  it("setUserEntryIndex overwrites while dispatched and is refused afterwards", async () => {
    await open("a", "final_verdict");
    expect(await storage.workflowRunSteps.setUserEntryIndex("a", 7)).toBe(true);
    expect(await storage.workflowRunSteps.setUserEntryIndex("a", 11)).toBe(true);
    expect((await storage.workflowRunSteps.getById("a"))?.user_entry_index).toBe(11);
    await storage.workflowRunSteps.abandon("a", "x");
    expect(await storage.workflowRunSteps.setUserEntryIndex("a", 12)).toBe(false);
  });

  it("claim and abandon are one-shot CASes that never overwrite each other", async () => {
    await open("a", "reviewer_prompt");
    expect(await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 5, outputSnapshot: "out" })).toBe(true);
    expect(await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 6, outputSnapshot: "other" })).toBe(false);
    expect(await storage.workflowRunSteps.abandon("a", "late")).toBe(false);
    expect(await storage.workflowRunSteps.getById("a")).toMatchObject({ status: "claimed", turn_end_index: 5, output_snapshot: "out", error: null });
  });

  it("claims the step, advances the run and writes the outbox row together", async () => {
    await open("a", "reviewer_prompt");
    const ok = await storage.workflowRuns.claimStepAndTransition({
      stepId: "a", turnEndIndex: 5, outputSnapshot: "needs-changes",
      run: {
        id: "r1", from: "waiting_reviewer", to: "waiting_feedback",
        patch: { feedback_snapshot: "needs-changes" },
        outbox: {
          id: "workflow:r1:review_ready:5", kind: "review_ready", project_id: "p1", branch: "dev",
          session_id: "s-rev", workflow_run_id: "r1", created_at: 1,
        },
      },
    });
    expect(ok).toBe(true);
    expect(await storage.workflowRuns.getById("r1")).toMatchObject({ status: "waiting_feedback", feedback_snapshot: "needs-changes" });
    expect((await storage.notificationOutbox.listAfter(0, 10)).map((e) => e.id)).toEqual(["workflow:r1:review_ready:5"]);
  });

  it("rolls the step claim back when the run CAS loses: nothing claimed, nothing notified", async () => {
    await open("a", "reviewer_prompt");
    await storage.workflowRuns.transition("r1", "waiting_reviewer", "discussing");
    const ok = await storage.workflowRuns.claimStepAndTransition({
      stepId: "a", turnEndIndex: 5, outputSnapshot: "x",
      run: {
        id: "r1", from: "waiting_reviewer", to: "waiting_feedback",
        outbox: {
          id: "workflow:r1:review_ready:5", kind: "review_ready", project_id: "p1", branch: "dev",
          session_id: "s-rev", workflow_run_id: "r1", created_at: 1,
        },
      },
    });
    expect(ok).toBe(false);
    expect(await storage.workflowRunSteps.getById("a")).toMatchObject({ status: "dispatched", turn_end_index: null });
    expect(await storage.notificationOutbox.listAfter(0, 10)).toHaveLength(0);
  });

  it("finds open steps by session and abandons a run's open steps by role", async () => {
    await open("a", "final_verdict");
    await open("b", "feedback");
    expect((await storage.workflowRunSteps.getOpenBySession("s-rev")).map((s) => s.id)).toEqual(["a"]);
    expect((await storage.workflowRunSteps.listAllOpen()).map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(await storage.workflowRunSteps.abandonOpenByRun("r1", "user took over", "reviewer")).toBe(1);
    expect((await storage.workflowRunSteps.listAllOpen()).map((s) => s.id)).toEqual(["b"]);
    expect(await storage.workflowRunSteps.hasAny("r1")).toBe(true);
    expect(await storage.workflowRunSteps.hasAny("nope")).toBe(false);
  });

  describe("next-round gate run (review loop)", () => {
    const nextRun = {
      id: "r2", project_id: "p1", branch: "dev", source_session_id: "s-src", source_turn_end_index: 9,
      review_focus: "tests", review_target: null, loop_id: "r1", round: 2, max_rounds: 3,
    };
    // The round that sent the feedback is over by the time its step is claimed.
    const finishRound = () => storage.workflowRuns.update("r1", { status: "completed" });

    it("is inserted in the claiming transaction, as a waiting_rereview run with no reviewer bound", async () => {
      await open("a", "feedback");
      await finishRound();
      expect(await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 9, outputSnapshot: "done", nextRun })).toBe(true);
      expect(await storage.workflowRuns.getById("r2")).toMatchObject({
        status: "waiting_rereview", loop_id: "r1", round: 2, max_rounds: 3, reviewer_session_id: null,
        source_session_id: "s-src", source_turn_end_index: 9, review_focus: "tests", review_span: "this_turn", verdict: null,
      });
      expect((await storage.workflowRuns.getActiveBySession("s-src"))?.id).toBe("r2");
    });

    it("counts the run being completed in the same transaction as already released", async () => {
      await storage.workflowRuns.update("r1", { status: "sending_feedback" });
      await open("a", "feedback");
      expect(await storage.workflowRuns.claimStepAndTransition({
        stepId: "a", turnEndIndex: 9, outputSnapshot: "done",
        run: { id: "r1", from: "sending_feedback", to: "completed" }, nextRun,
      })).toBe(true);
      expect((await storage.workflowRuns.getById("r2"))?.status).toBe("waiting_rereview");
    });

    it("is skipped — while the step is still claimed — when the source already joined another active run", async () => {
      await open("a", "feedback");
      await finishRound();
      await storage.workflowRuns.create({
        id: "other", project_id: "p1", branch: "dev", source_session_id: "s-src",
        source_turn_end_index: 9, review_focus: null, review_target: null,
      });
      expect(await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 9, outputSnapshot: "done", nextRun })).toBe(true);
      expect((await storage.workflowRunSteps.getById("a"))?.status).toBe("claimed");
      expect(await storage.workflowRuns.getById("r2")).toBeUndefined();
    });

    it("also yields to a run that uses the source AS a reviewer", async () => {
      await open("a", "feedback");
      await finishRound();
      const other = await storage.workflowRuns.create({
        id: "other", project_id: "p1", branch: "dev", source_session_id: "s-else",
        source_turn_end_index: 1, review_focus: null, review_target: null,
      });
      await storage.workflowRuns.update(other.id, { reviewer_session_id: "s-src" });
      await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 9, outputSnapshot: "done", nextRun });
      expect(await storage.workflowRuns.getById("r2")).toBeUndefined();
    });

    it("is not inserted when the step CAS loses", async () => {
      await open("a", "feedback");
      await finishRound();
      await storage.workflowRunSteps.abandon("a", "x");
      expect(await storage.workflowRuns.claimStepAndTransition({ stepId: "a", turnEndIndex: 9, outputSnapshot: "done", nextRun })).toBe(false);
      expect(await storage.workflowRuns.getById("r2")).toBeUndefined();
    });
  });

  it("stores loop identity on create and the verdict with the claim", async () => {
    const looped = await storage.workflowRuns.create({
      id: "loop1", project_id: "p1", branch: "dev", source_session_id: "s-loop",
      source_turn_end_index: 4, review_focus: null, review_target: null, loop_id: "loop1", max_rounds: 3,
    });
    expect(looped).toMatchObject({ loop_id: "loop1", round: 1, max_rounds: 3, verdict: null });
    expect(await storage.workflowRuns.getById("r1")).toMatchObject({ loop_id: null, round: 1, max_rounds: null });

    await open("a", "reviewer_prompt");
    await storage.workflowRuns.claimStepAndTransition({
      stepId: "a", turnEndIndex: 5, outputSnapshot: "x",
      run: { id: "r1", from: "waiting_reviewer", to: "waiting_feedback", patch: { feedback_snapshot: "x", verdict: "needs-changes" } },
    });
    expect((await storage.workflowRuns.getById("r1"))?.verdict).toBe("needs-changes");
  });

  describe("repeat-loop runs", () => {
    const createIteration = () => storage.workflowRuns.create({
      id: "it1", project_id: "p1", branch: "dev", source_session_id: "s-it1", source_turn_end_index: -1,
      review_focus: null, review_target: null, status: "preparing",
      kind: "repeat", params: '{"prompt":"p"}', loop_id: "it1", round: 1, max_rounds: 20,
    });
    const openTask = () => storage.workflowRunSteps.open({
      id: "t1", run_id: "it1", kind: "task_prompt", role: "source", session_id: "s-it1",
      idempotency_key: "task:it1", payload_hash: "h",
    });

    it("rows default to kind=review; a repeat run carries its params", async () => {
      expect(await storage.workflowRuns.getById("r1")).toMatchObject({ kind: "review", params: null, outcome_status: null });
      expect(await createIteration()).toMatchObject({ kind: "repeat", params: '{"prompt":"p"}', status: "preparing", round: 1 });
    });

    it("an abnormal end abandons the step, ends the run and inserts the gate together — or does none of it", async () => {
      await createIteration();
      await openTask();
      const end = (from: "running_task" | "preparing") => storage.workflowRuns.claimStepAndTransition({
        stepId: "t1", turnEndIndex: null, outputSnapshot: null, abandonStep: "turn ended: failed",
        run: { id: "it1", from, to: "failed", patch: { error: "boom" } },
        insertRun: {
          id: "gate", project_id: "p1", branch: "dev", source_session_id: "s-gate", loop_id: "it1", round: 2,
          max_rounds: 20, params: "{}", status: "waiting_resume", error: "boom",
        },
      });
      // Run CAS loses → the step stays dispatched and no gate appears.
      expect(await end("running_task")).toBe(false);
      expect((await storage.workflowRunSteps.getById("t1"))?.status).toBe("dispatched");
      expect(await storage.workflowRuns.getById("gate")).toBeUndefined();

      expect(await end("preparing")).toBe(true);
      expect(await storage.workflowRunSteps.getById("t1")).toMatchObject({ status: "abandoned", error: "turn ended: failed", turn_end_index: null });
      expect((await storage.workflowRuns.getById("it1"))?.status).toBe("failed");
      expect((await storage.workflowRuns.getById("gate"))?.status).toBe("waiting_resume");
    });

    it("the database refuses a second active loop on a workspace; an ended one frees it", async () => {
      await createIteration();
      const second = () => storage.workflowRuns.create({
        id: "other", project_id: "p1", branch: "dev", source_session_id: "s-o", source_turn_end_index: -1,
        review_focus: null, review_target: null, status: "preparing", kind: "repeat", params: "{}", loop_id: "other", round: 1, max_rounds: 5,
      });
      await expect(second()).rejects.toThrow(/UNIQUE constraint failed/);
      // A review on the same workspace is not a loop.
      await storage.workflowRuns.create({
        id: "rv", project_id: "p1", branch: "dev", source_session_id: "s-x", source_turn_end_index: 1, review_focus: null, review_target: "{}",
      });
      await storage.workflowRuns.update("it1", { status: "cancelled" });
      expect((await second()).id).toBe("other");
    });

    it("settles an iteration and inserts the next one — or its resume gate — in one transaction", async () => {
      await createIteration();
      await openTask();
      await storage.workflowRuns.update("it1", { status: "running_task" });
      expect(await storage.workflowRuns.claimStepAndTransition({
        stepId: "t1", turnEndIndex: 3, outputSnapshot: "Status: continue",
        run: { id: "it1", from: "running_task", to: "completed", patch: { outcome_status: "continue" } },
        insertRun: {
          id: "it2", project_id: "p1", branch: "dev", source_session_id: "s-it2", loop_id: "it1", round: 2,
          max_rounds: 20, params: '{"prompt":"p"}', status: "waiting_resume", error: "blocked",
        },
      })).toBe(true);
      expect(await storage.workflowRuns.getById("it1")).toMatchObject({ status: "completed", outcome_status: "continue" });
      const gate = await storage.workflowRuns.getById("it2");
      expect(gate).toMatchObject({ kind: "repeat", status: "waiting_resume", error: "blocked", round: 2, source_turn_end_index: -1 });
      // Both new statuses are active: the loop's one live run is findable, and listed.
      expect((await storage.workflowRuns.getActiveInLoop("it1"))?.id).toBe("it2");
      expect((await storage.workflowRuns.getActive("p1", "dev")).map((r) => r.id)).toContain("it2");
    });

    it("a lost run CAS inserts nothing", async () => {
      await createIteration();
      await openTask();
      expect(await storage.workflowRuns.claimStepAndTransition({
        stepId: "t1", turnEndIndex: 3, outputSnapshot: null,
        run: { id: "it1", from: "running_task", to: "completed" },
        insertRun: {
          id: "it2", project_id: "p1", branch: "dev", source_session_id: "s-it2", loop_id: "it1", round: 2,
          max_rounds: 20, params: null, status: "preparing", error: null,
        },
      })).toBe(false);
      expect(await storage.workflowRuns.getById("it2")).toBeUndefined();
      expect((await storage.workflowRunSteps.getById("t1"))?.status).toBe("dispatched");
    });

    it("a completed iteration does not make its session look reviewed", async () => {
      await createIteration();
      await storage.workflowRuns.update("it1", { status: "completed" });
      expect(await storage.workflowRuns.listReviewedSourceSessions("p1", "dev")).not.toContain("s-it1");
    });
  });

  it("deletes steps with their run", async () => {
    await open("a", "reviewer_prompt");
    await storage.projects.delete("p1");
    expect(await storage.workflowRunSteps.getById("a")).toBeUndefined();
  });
});
