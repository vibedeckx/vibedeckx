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

  it("deletes steps with their run", async () => {
    await open("a", "reviewer_prompt");
    await storage.projects.delete("p1");
    expect(await storage.workflowRunSteps.getById("a")).toBeUndefined();
  });
});
