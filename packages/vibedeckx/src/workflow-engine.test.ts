import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { EventBus } from "./event-bus.js";
import {
  WorkflowEngine,
  WorkflowError,
  buildRereviewerPrompt,
  extractLatestTurnEndIndex,
  extractLastAssistantBefore,
  extractLastAssistantInTurn,
  extractTaskContextBefore,
} from "./workflow-engine.js";
import type { AgentMessage } from "./agent-types.js";

const entries: AgentMessage[] = [];
entries[0] = { type: "user", content: "please fix the bug", timestamp: 1 };
entries[1] = { type: "assistant", content: "working on it", timestamp: 2 };
entries[3] = { type: "assistant", content: "done — fixed in foo.ts", timestamp: 3 };
entries[4] = { type: "turn_end", timestamp: 4 };

describe("pure helpers", () => {
  it("extractLatestTurnEndIndex finds the last turn_end in a sparse array", () => {
    expect(extractLatestTurnEndIndex(entries)).toBe(4);
    expect(extractLatestTurnEndIndex([])).toBeNull();
  });

  it("extractLastAssistantBefore walks down past holes", () => {
    expect(extractLastAssistantBefore(entries, 4)).toBe("done — fixed in foo.ts");
    expect(extractLastAssistantBefore(entries, 3)).toBe("working on it");
    expect(extractLastAssistantBefore(entries, 0)).toBeNull();
  });

  it("extractTaskContextBefore finds the turn's user message", () => {
    expect(extractTaskContextBefore(entries, 4)).toBe("please fix the bug");
  });

  it("extractLastAssistantInTurn never falls back to an older review", () => {
    const turns: AgentMessage[] = [
      { type: "assistant", content: "old feedback", timestamp: 1 },
      { type: "turn_end", timestamp: 2 },
      { type: "user", content: "review again", timestamp: 3 },
      { type: "tool_result", tool: "Read", output: "ok", timestamp: 4 },
      { type: "turn_end", timestamp: 5 },
    ];
    expect(extractLastAssistantInTurn(turns, 4)).toBeNull();
    turns.splice(4, 0, { type: "assistant", content: "new feedback", timestamp: 5 });
    expect(extractLastAssistantInTurn(turns, 5)).toBe("new feedback");
  });

  it("buildRereviewerPrompt anchors the latest source turn and workspace target", () => {
    const prompt = buildRereviewerPrompt({
      taskContext: "also cover the new API requirement",
      reviewFocus: "tests",
      target: { baseHead: "abc123", diffDigest: "digest", diffStat: "2 files changed", capturedAt: 1 },
    });
    expect(prompt).toContain("also cover the new API requirement");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("2 files changed");
    expect(prompt).toContain("read-only review mode");
  });
});

describe("WorkflowEngine", () => {
  let dir: string;
  let storage: Storage;
  let engine: WorkflowEngine;
  let bus: EventBus;
  const reviewerEntries: AgentMessage[] = [];
  const agentOps = {
    createNewSession: vi.fn(async () => "s-rev"),
    sendUserMessage: vi.fn(async () => true),
    switchMode: vi.fn(async () => true),
    setFinalSessionTitle: vi.fn(async () => undefined),
    getRawMessages: vi.fn((sessionId: string) => (sessionId === "s-rev" ? reviewerEntries : entries)),
    broadcastRawToSession: vi.fn(),
  };
  const project = { id: "p1", path: "/tmp/does-not-exist-vdx" }; // non-git → null review target, still fine

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-eng-"));
    storage = await createSqliteStorage(path.join(dir, "t.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: project.path });
    // Represents the source session having already finished its turn — most
    // tests exercise the "ready to review" state, so default to "stopped"
    // and let the running-source-guard test flip it back to "running".
    await storage.agentSessions.create({ id: "s-src", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus("s-src", "stopped");
    bus = new EventBus();
    engine = new WorkflowEngine(storage, agentOps);
    engine.setEventBus(bus);
    await engine.init();
    reviewerEntries.length = 0;
    reviewerEntries[0] = { type: "assistant", content: "Feedback: rename X; add test for Y", timestamp: 1 };
    reviewerEntries[1] = { type: "turn_end", timestamp: 2 };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    return engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewFocus: "focus on tests",
    });
  }

  async function createReviewer(opts: {
    id?: string;
    projectId?: string;
    branch?: string;
    status?: "running" | "stopped" | "error";
    permissionMode?: "plan" | "edit";
    agentType?: "claude-code" | "codex";
    title?: string;
  } = {}) {
    const id = opts.id ?? "s-rev";
    const projectId = opts.projectId ?? "p1";
    if (projectId !== "p1" && !(await storage.projects.getById(projectId))) {
      await storage.projects.create({ id: projectId, name: projectId, path: project.path });
    }
    await storage.agentSessions.create({
      id,
      project_id: projectId,
      branch: opts.branch ?? "dev",
      permission_mode: opts.permissionMode ?? "plan",
      agent_type: opts.agentType ?? "codex",
    });
    await storage.agentSessions.updateStatus(id, opts.status ?? "stopped");
    if (opts.title) await storage.agentSessions.updateTitle(id, opts.title);
    return id;
  }

  async function seedCompletedReview(reviewerId = "s-rev") {
    const run = await storage.workflowRuns.create({
      id: `past-${reviewerId}`,
      project_id: "p1",
      branch: "dev",
      source_session_id: "s-src",
      source_turn_end_index: 4,
      review_focus: null,
      review_target: null,
    });
    await storage.workflowRuns.update(run.id, {
      reviewer_session_id: reviewerId,
      status: "completed",
    });
    return run;
  }

  it("startAdhocReview creates run, spawns reviewer, sends prompt", async () => {
    const run = await start();
    expect(run.status).toBe("waiting_reviewer");
    expect(run.reviewer_session_id).toBe("s-rev");
    expect(run.source_turn_end_index).toBe(4); // derived from entries
    expect(agentOps.createNewSession).toHaveBeenCalledWith("p1", "dev", project.path, false, "plan", "claude-code", true);
    const prompt = agentOps.sendUserMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("please fix the bug");   // task context
    expect(prompt).toContain("focus on tests");        // review focus
    expect(prompt).toContain("read-only review mode"); // reviewer must not edit
    // Deterministic title, set before the prompt goes out (no AI generation).
    // Source has no title here → falls back to the task-context snippet.
    expect(agentOps.setFinalSessionTitle).toHaveBeenCalledWith("s-rev", "Review - please fix the bug");
    expect(agentOps.setFinalSessionTitle.mock.invocationCallOrder[0])
      .toBeLessThan(agentOps.sendUserMessage.mock.invocationCallOrder[0]);
  });

  it("spawns the reviewer with the requested agent type", async () => {
    await engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerAgentType: "codex",
    });
    expect(agentOps.createNewSession).toHaveBeenCalledWith("p1", "dev", project.path, false, "plan", "codex", true);
  });

  it("reviewer title prefers the source session's own title", async () => {
    await storage.agentSessions.updateTitle("s-src", "Fix login bug");
    await start();
    expect(agentOps.setFinalSessionTitle).toHaveBeenCalledWith("s-rev", "Review - Fix login bug");
  });

  it("returns the most recent compatible reviewer candidate", async () => {
    await createReviewer({ title: "Review - Fix login bug" });
    await seedCompletedReview();

    await expect(engine.getReviewerCandidate("s-src")).resolves.toEqual({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login bug",
      agentType: "codex",
      reason: null,
    });
  });

  it("classifies a deleted previous reviewer as unavailable without falling back", async () => {
    await seedCompletedReview("missing-reviewer");
    await expect(engine.getReviewerCandidate("s-src")).resolves.toEqual({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason: "deleted",
    });
  });

  it("reuses an existing reviewer session instead of creating one", async () => {
    await createReviewer();
    const run = await engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
      reviewFocus: "focus on tests",
    });

    expect(run.reviewer_session_id).toBe("s-rev");
    expect(agentOps.createNewSession).not.toHaveBeenCalled();
    expect(agentOps.sendUserMessage).toHaveBeenCalledWith(
      "s-rev",
      expect.stringContaining("previous review"),
      project.path,
    );
    const prompt = agentOps.sendUserMessage.mock.calls.at(-1)?.[1] as string;
    expect(prompt).toContain("please fix the bug");
    expect(prompt).toContain("focus on tests");
  });

  it("switches a stopped edit-mode reviewer back to plan before reuse", async () => {
    await createReviewer({ permissionMode: "edit" });
    await engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    });

    expect(agentOps.switchMode).toHaveBeenCalledWith("s-rev", project.path, "plan");
    expect(agentOps.switchMode.mock.invocationCallOrder[0])
      .toBeLessThan(agentOps.sendUserMessage.mock.invocationCallOrder[0]);
  });

  it("fails the run and releases both sessions when plan-mode restoration fails", async () => {
    await createReviewer({ permissionMode: "edit" });
    agentOps.switchMode.mockResolvedValueOnce(false);

    await expect(engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "reviewer-unavailable" });

    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
    expect(await storage.workflowRuns.getActive("p1", "dev")).toEqual([]);
  });

  it("rejects an incompatible or running reviewer and releases reservations", async () => {
    await createReviewer({ branch: "other" });
    await expect(engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "reviewer-unavailable" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
  });

  it("allows exactly one concurrent run to reserve a reused reviewer", async () => {
    await storage.agentSessions.create({ id: "s-src-2", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus("s-src-2", "stopped");
    await createReviewer();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    agentOps.sendUserMessage.mockImplementationOnce(async () => {
      await sendGate;
      return true;
    });

    const first = engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerSessionId: "s-rev",
    });
    const second = engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src-2", reviewerSessionId: "s-rev",
    });
    await expect(second).rejects.toMatchObject({ code: "session-busy" });
    releaseSend();
    await expect(first).resolves.toMatchObject({ reviewer_session_id: "s-rev" });
  });

  it("marks the run failed and releases both sessions when reused-reviewer delivery fails", async () => {
    await createReviewer();
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "send-failed" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
    expect((await storage.workflowRuns.getActive("p1", "dev"))).toHaveLength(0);
  });

  it("mirrors run updates onto participant session streams", async () => {
    await start();
    const frames = agentOps.broadcastRawToSession.mock.calls.map(
      ([sid, frame]: [string, Record<string, unknown>]) => [sid, Object.keys(frame)[0]],
    );
    expect(frames).toContainEqual(["s-src", "workflowRunUpdated"]);
    expect(frames).toContainEqual(["s-rev", "workflowRunUpdated"]);
  });

  it("rejects when a participant session is already in an active run", async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: "session-busy" });
  });

  it("rejects a source session with no completed turn", async () => {
    agentOps.getRawMessages.mockReturnValueOnce([]);
    await expect(start()).rejects.toMatchObject({ code: "no-completed-turn" });
  });

  it("rejects a source session that is currently running", async () => {
    await storage.agentSessions.updateStatus("s-src", "running");
    await expect(start()).rejects.toMatchObject({ code: "source-running" });
    // The reservation from the failed attempt must not linger.
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("two concurrent startAdhocReview calls for the same session: exactly one succeeds", async () => {
    // Force interleaving: the first call's createNewSession hangs on a
    // deferred promise (simulating a slow reviewer spawn), so the second
    // call is issued while the first is still deep inside its awaits —
    // not just back-to-back before either has started.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    agentOps.createNewSession.mockImplementationOnce(async () => {
      await gate;
      return "s-rev";
    });

    const first = start();
    const second = start(); // issued while `first` is in-flight

    await expect(second).rejects.toMatchObject({ code: "session-busy" });
    // The lock is still held by the in-flight first call, not released by
    // the second call's rejection.
    expect(engine.isSessionInActiveRun("s-src")).toBe(true);

    releaseFirst();
    const run = await first;
    expect(run.status).toBe("waiting_reviewer");
  });

  it("run fails and releases the source lock when the reviewer prompt send fails", async () => {
    const updateSpy = vi.spyOn(storage.workflowRuns, "update");
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(start()).rejects.toMatchObject({ code: "spawn-failed" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);

    const runs = await storage.workflowRuns.getActive("p1", "dev");
    expect(runs).toHaveLength(0); // not "active" — status flipped to failed

    const failedCall = updateSpy.mock.calls.find(([, patch]) => patch.status === "failed");
    expect(failedCall?.[1]).toMatchObject({ status: "failed", error: "向 reviewer 投递任务失败" });
  });

  it("claims reviewer completion: suppresses, snapshots full feedback, waits for gate", async () => {
    const run = await start();
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(true);
    expect(engine.shouldSuppressAgentEvent("s-src")).toBe(false);
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const updated = await storage.workflowRuns.getById(run.id);
    expect(updated?.feedback_snapshot).toBe("Feedback: rename X; add test for Y");
  });

  it("approveFeedback CAS-sends edited payload back to source and completes", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const done = await engine.approveFeedback(run.id, "edited feedback");
    expect(done.status).toBe("completed");
    const sent = agentOps.sendUserMessage.mock.calls.at(-1)!;
    expect(sent[0]).toBe("s-src");
    expect(sent[1]).toContain("edited feedback");
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("failed send returns run to waiting_feedback with error, no auto-retry", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.approveFeedback(run.id)).rejects.toMatchObject({ code: "send-failed" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("未运行");
  });

  it("cancelRun cancels a run in waiting_feedback", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const cancelled = await engine.cancelRun(run.id, "user cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe("user cancelled");
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("cancelRun is a CAS: rejects with bad-state while a send is in flight (sending_feedback)", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    // Simulate approveFeedback having claimed the run (mid-send, still
    // awaiting agentOps.sendUserMessage) via its own CAS.
    const claimed = await storage.workflowRuns.transition(run.id, "waiting_feedback", "sending_feedback");
    expect(claimed).toBe(true);

    await expect(engine.cancelRun(run.id)).rejects.toMatchObject({ code: "bad-state" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("sending_feedback"); // untouched by the failed cancel
  });

  it("handleExternalUserMessage ends the run (human takeover)", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("cancelled");
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(false);
  });

  it("handleExternalUserMessage never throws when the run is mid-send (sending_feedback bad-state race)", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    // Simulate approveFeedback having claimed the run (mid-send, still
    // awaiting agentOps.sendUserMessage) via its own CAS — same setup as the
    // cancelRun CAS test above, but here we drive the takeover path, which
    // must swallow cancelRun's bad-state throw rather than propagate it (it
    // runs inline before the user's own message is delivered).
    const claimed = await storage.workflowRuns.transition(run.id, "waiting_feedback", "sending_feedback");
    expect(claimed).toBe(true);

    await expect(engine.handleExternalUserMessage("s-rev")).resolves.toBeUndefined();
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("sending_feedback"); // unchanged — takeover cancel was skipped
  });

  it("boot recovery: sending_feedback → waiting_feedback with unknown-send warning", async () => {
    const run = await start();
    await storage.workflowRuns.update(run.id, { status: "sending_feedback", feedback_snapshot: "fb" });
    const engine2 = new WorkflowEngine(storage, agentOps);
    await engine2.init();
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("发送状态未知");
    expect(engine2.isSessionInActiveRun("s-src")).toBe(true);
  });
});
