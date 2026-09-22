import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage, WorkflowRun } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";
import { EventBus } from "./event-bus.js";
import { WorkflowEngine, type AgentOps } from "./workflow-engine.js";
import { parseRepeatParams } from "./workflow-repeat-loop.js";

// Repeat-until-done loop (docs/superpowers/specs/2026-09-20-workflow-repeat-until-done-design.md).
describe("repeat-until-done loop", () => {
  let dir: string;
  let storage: Storage;
  let engine: WorkflowEngine;
  let bus: EventBus;
  const project = { id: "p1", name: "p", path: "/tmp/p" } as never;
  const transcripts = new Map<string, AgentMessage[]>();
  const stopped: string[] = [];
  const check = vi.fn(async () => ({ ok: true, output: "" }));

  const view = (sessionId: string, userEntryIndex: number | null) => ({
    sessionId, projectId: "p1", branch: "dev", state: "active", purpose: "workflow_task", leaseHeld: false,
    activationKey: null, activationAttempt: 0, activatedAt: null, activationErrorCode: null, userEntryIndex,
    expiredReason: null, expiredAt: null, pendingExpiresAt: null,
  });
  /**
   * Stand-in runtime with the real contract: prepare reserves an identity,
   * activate writes the opening user entry (the index attribution runs on)
   * and the session starts running.
   */
  const agentOps = {
    prepareReviewer: vi.fn(async (input: { sessionId?: string }) => {
      const id = input.sessionId!;
      if (!(await storage.agentSessions.getById(id))) await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
      transcripts.set(id, []);
      return { kind: "prepared" as const, view: view(id, null) };
    }),
    activateReviewer: vi.fn(async (input: { sessionId: string; instruction: string }) => {
      const list = transcripts.get(input.sessionId)!;
      list.push({ type: "user", content: input.instruction, timestamp: Date.now(), origin: "workflow" });
      await storage.agentSessions.updateStatus(input.sessionId, "running");
      return { kind: "activated" as const, view: view(input.sessionId, list.length - 1) };
    }),
    cancelReviewer: vi.fn(async () => ({ kind: "not_found" as const })),
    sendUserMessage: vi.fn(async () => true),
    setFinalSessionTitle: vi.fn(async () => undefined),
    switchMode: vi.fn(async () => true),
    getRawMessages: vi.fn(async (sessionId: string) => transcripts.get(sessionId) ?? []),
    broadcastRawToSession: vi.fn(),
    stopSession: vi.fn(async (sessionId: string, opts?: { note?: string }) => {
      // Every stop the loop performs says so; the runtime default claims the user did it.
      expect(opts?.note).toMatch(/^Loop/);
      stopped.push(sessionId);
      await storage.agentSessions.updateStatus(sessionId, "stopped");
      return true;
    }),
  };

  function newEngine() {
    const e = new WorkflowEngine(storage, agentOps as unknown as AgentOps, { runCheckCommand: check });
    e.setEventBus(bus);
    return e;
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-loop-"));
    storage = await createSqliteStorage(path.join(dir, "t.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    bus = new EventBus();
    engine = newEngine();
    await engine.init();
    transcripts.clear();
    stopped.length = 0;
    vi.clearAllMocks();
    check.mockResolvedValue({ ok: true, output: "" });
  });

  afterEach(async () => {
    engine.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const startLoop = (extra: Partial<Parameters<WorkflowEngine["startRepeatLoop"]>[0]> = {}) =>
    engine.startRepeatLoop({ project, branch: "dev", name: "Orders", prompt: "Process the next unhandled order.", ...extra });
  const active = async () => (await storage.workflowRuns.getActive("p1", "dev")).filter((r) => r.kind === "repeat");
  const onlyActive = async () => { const runs = await active(); expect(runs).toHaveLength(1); return runs[0]; };
  const outbox = () => storage.notificationOutbox.listAfter(0, 50);

  /** The iteration's session ends its turn with `reply`. */
  async function finish(run: WorkflowRun, reply: string, outcome: "completed" | "stopped" | "failed" = "completed") {
    const list = transcripts.get(run.source_session_id)!;
    list.push({ type: "assistant", content: reply, timestamp: 1 }, { type: "turn_end", timestamp: 2, outcome } as AgentMessage);
    await storage.agentSessions.updateStatus(run.source_session_id, "stopped");
    if (outcome === "completed") {
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: run.source_session_id, turnEndEntryIndex: list.length - 1 });
    }
    bus.emit({ type: "session:status", projectId: "p1", branch: "dev", sessionId: run.source_session_id, status: "stopped" });
    await vi.waitFor(async () => expect((await storage.workflowRuns.getById(run.id))?.status).not.toBe("running_task"));
  }
  /** Settled AND the follow-up (next dispatch) has landed. */
  async function finishAndAdvance(run: WorkflowRun, reply: string) {
    await finish(run, reply);
    await vi.waitFor(async () => expect((await onlyActive()).status).toBe("running_task"));
    return onlyActive();
  }

  it("starts the first iteration in a fresh edit-mode session, with the closing-status contract appended", async () => {
    const run = await startLoop();
    expect(run).toMatchObject({ kind: "repeat", status: "running_task", round: 1, max_rounds: 20, loop_id: run.id, source_turn_end_index: -1 });
    expect(agentOps.prepareReviewer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: run.source_session_id, permissionMode: "edit", purpose: "workflow_task", owner: { kind: "workflow_run", id: run.id },
    }));
    expect(agentOps.setFinalSessionTitle).toHaveBeenCalledWith(run.source_session_id, "Orders #1");
    const sent = agentOps.activateReviewer.mock.calls[0][0] as { instruction: string; notificationDisposition: string };
    expect(sent.instruction).toContain("Process the next unhandled order.");
    expect(sent.instruction).toContain("Status: <exactly one of: continue / done / blocked>");
    // Fifty iterations must not ring fifty bells or wake the commander fifty times.
    expect(sent.notificationDisposition).toBe("milestone-managed");
    expect(engine.shouldSuppressAgentEvent(run.source_session_id)).toBe(true);
    expect(parseRepeatParams(run)?.anchorSessionId).toBe(run.source_session_id);
  });

  it("continue: settles the iteration, stops its session and runs the next one in a NEW session", async () => {
    const first = await startLoop();
    const second = await finishAndAdvance(first, "Refunded.\n\nStatus: continue\nItem: order 17\nRemaining: 4");

    expect(await storage.workflowRuns.getById(first.id)).toMatchObject({ status: "completed", outcome_status: "continue" });
    expect(stopped).toEqual([first.source_session_id]);
    expect(second).toMatchObject({ round: 2, loop_id: first.id, kind: "repeat" });
    expect(second.source_session_id).not.toBe(first.source_session_id);
    expect(agentOps.setFinalSessionTitle).toHaveBeenLastCalledWith(second.source_session_id, "Orders #2");
    expect(parseRepeatParams(second)).toMatchObject({ prevItem: "order 17", remaining: "4", prevSessionId: first.source_session_id });
    expect(engine.shouldSuppressAgentEvent(first.source_session_id)).toBe(false);
    expect(await outbox()).toHaveLength(0);
  });

  it("done: the loop finishes, and says so on the ANCHOR session's outbox", async () => {
    const first = await startLoop();
    const second = await finishAndAdvance(first, "Status: continue\nItem: a");
    await finish(second, "Nothing left.\n\nStatus: done");

    expect(await active()).toHaveLength(0);
    expect(stopped).toEqual([first.source_session_id, second.source_session_id]);
    // The transcript says what happens next: more items, or the end.
    const notes = agentOps.stopSession.mock.calls.map(([, o]) => (o as { note: string }).note);
    expect(notes[0]).toContain("next item runs in a fresh session");
    expect(notes[1]).toMatch(/^Loop finished/);
    expect(notes[1]).not.toContain("next item");
    expect(await outbox()).toEqual([expect.objectContaining({
      kind: "loop_done", session_id: first.source_session_id, workflow_run_id: second.id,
      id: `workflow:${first.id}:round:2:done`,
    })]);
  });

  it.each([
    ["blocked", "Status: blocked", "blocked"],
    ["an unrecognised status", "Status: not done yet", "无法识别"],
    ["no status at all", "All finished I think.", "无法识别"],
  ])("%s: stops at a resume gate, keeps the session up, rings the bell", async (_label, reply, reason) => {
    const first = await startLoop();
    await finish(first, reply);
    const gate = await onlyActive();
    expect(gate).toMatchObject({ status: "waiting_resume", round: 2, loop_id: first.id });
    expect(gate.error).toContain(reason);
    expect(stopped).toEqual([]);
    expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
    expect(await outbox()).toEqual([expect.objectContaining({ kind: "workflow_failed", session_id: first.source_session_id, workflow_run_id: first.id })]);
    // The reserved session id of a gate is not a participant: nothing exists under it.
    expect(engine.isSessionInActiveRun(gate.source_session_id)).toBe(false);
  });

  describe("brakes", () => {
    it("iteration cap → gate; resume adds the original cap again and continues", async () => {
      const first = await startLoop({ maxIterations: 1 });
      await finish(first, "Status: continue\nItem: a");
      const gate = await onlyActive();
      expect(gate).toMatchObject({ status: "waiting_resume", round: 2, max_rounds: 1 });
      expect(gate.error).toContain("迭代上限");

      const resumed = await engine.resumeLoop(first.id); // a stale id addresses the loop
      expect(resumed).toMatchObject({ id: gate.id, status: "running_task", max_rounds: 2, error: null });
      expect(resumed.source_session_id).not.toBe(gate.source_session_id);
    });

    it("the same Item twice in a row → gate (no progress)", async () => {
      const second = await finishAndAdvance(await startLoop(), "Status: continue\nItem: order 17");
      await finish(second, "Status: continue\nItem: order 17");
      expect((await onlyActive()).error).toContain("同一项");
    });

    it("time cap → gate; resume restarts the clock", async () => {
      const first = await startLoop({ maxMinutes: 10 });
      const params = parseRepeatParams(first)!;
      await storage.workflowRuns.update(first.id, { params: JSON.stringify({ ...params, startedAt: Date.now() - 11 * 60_000 }) });
      await finish(first, "Status: continue\nItem: a");
      expect((await onlyActive()).error).toContain("时长上限");
      const resumed = await engine.resumeLoop(first.id);
      expect(Date.now() - parseRepeatParams(resumed)!.startedAt).toBeLessThan(5_000);
    });

    it("soft stop: the current item finishes, then a gate — and no bell, the user is right there", async () => {
      const first = await startLoop();
      await engine.pauseLoop(first.id);
      await finish(first, "Status: continue\nItem: a");
      const gate = await onlyActive();
      expect(gate.status).toBe("waiting_resume");
      expect(gate.error).toContain("暂停");
      expect(stopped).toEqual([first.source_session_id]);
      expect(agentOps.stopSession.mock.calls[0][1]).toEqual({ note: expect.stringMatching(/^Loop paused/) });
      expect(await outbox()).toHaveLength(0);
      expect(parseRepeatParams(gate)?.stopAfterCurrent).toBe(false);
    });

    it("a failing check command stops the loop even though the agent said continue", async () => {
      check.mockResolvedValueOnce({ ok: false, output: "2 tests failed" });
      const first = await startLoop({ checkCommand: "npm test" });
      await finish(first, "Status: continue\nItem: a");
      expect(check).toHaveBeenCalledWith("npm test", expect.any(String));
      const gate = await onlyActive();
      expect(gate.error).toContain("2 tests failed");
      expect(stopped).toEqual([]);
    });
  });

  describe("a turn that does not complete (no taskCompleted event exists for it)", () => {
    it("stopped by the user → cancelled iteration + resume gate, no bell", async () => {
      const first = await startLoop();
      await finish(first, "partial", "stopped");
      expect(await storage.workflowRuns.getById(first.id)).toMatchObject({ status: "cancelled" });
      const gate = await vi.waitFor(async () => onlyActive());
      expect(gate).toMatchObject({ status: "waiting_resume", round: 2 });
      expect(gate.error).toContain("由你停止");
      expect(await outbox()).toHaveLength(0);
    });

    it("failed → failed iteration + resume gate + bell on the anchor", async () => {
      const first = await startLoop();
      await finish(first, "boom", "failed");
      expect((await storage.workflowRuns.getById(first.id))?.status).toBe("failed");
      const gate = await vi.waitFor(async () => onlyActive());
      expect(gate.status).toBe("waiting_resume");
      expect(await outbox()).toEqual([expect.objectContaining({ kind: "workflow_failed", session_id: first.source_session_id })]);
    });
  });

  describe("stopping", () => {
    it("cancel — even with a stale iteration id — ends the loop and stops the running session; no gate", async () => {
      const first = await startLoop();
      const second = await finishAndAdvance(first, "Status: continue\nItem: a");
      stopped.length = 0;
      const cancelled = await engine.cancelRun(first.id);
      expect(cancelled).toMatchObject({ id: second.id, status: "cancelled" });
      expect(stopped).toEqual([second.source_session_id]);
      expect(await active()).toHaveLength(0);

      // The stop makes the session go idle; that must not resurrect anything.
      await finish(second, "cut off", "stopped").catch(() => undefined);
      expect(await active()).toHaveLength(0);
    });

    it("a completion that lands after cancel moves nothing", async () => {
      const first = await startLoop();
      await engine.cancelRun(first.id);
      const list = transcripts.get(first.source_session_id)!;
      list.push({ type: "assistant", content: "Status: continue", timestamp: 1 }, { type: "turn_end", timestamp: 2, outcome: "completed" } as AgentMessage);
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: first.source_session_id, turnEndEntryIndex: list.length - 1 });
      await new Promise((r) => setTimeout(r, 60));
      expect(await active()).toHaveLength(0);
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
    });

    it("resume refuses while the previous iteration's session is still running", async () => {
      const first = await startLoop();
      await finish(first, "Status: blocked");
      await storage.agentSessions.updateStatus(first.source_session_id, "running"); // the user is talking to it
      await expect(engine.resumeLoop(first.id)).rejects.toMatchObject({ code: "session-busy" });
      await storage.agentSessions.updateStatus(first.source_session_id, "stopped");
      expect((await engine.resumeLoop(first.id)).status).toBe("running_task");
      expect(stopped).toContain(first.source_session_id);
    });
  });

  it("one loop per workspace", async () => {
    await startLoop();
    await expect(startLoop()).rejects.toMatchObject({ code: "session-busy" });
  });

  it("a dispatch that cannot start becomes a gate on the same run, with the bell; resume uses a fresh session id", async () => {
    agentOps.activateReviewer.mockResolvedValueOnce({ kind: "resident_limit" } as never);
    const run = await startLoop();
    expect(run).toMatchObject({ status: "waiting_resume", round: 1 });
    expect(run.error).toContain("resident_limit");
    // Tells the panel this round never started — unlike a gate that succeeds an ended iteration.
    expect(parseRepeatParams(run)?.dispatchFailed).toBe(true);
    expect(await outbox()).toEqual([expect.objectContaining({ kind: "workflow_failed" })]);
    const resumed = await engine.resumeLoop(run.id);
    expect(resumed).toMatchObject({ id: run.id, status: "running_task" });
    expect(resumed.source_session_id).not.toBe(run.source_session_id);
    expect(parseRepeatParams(resumed)?.dispatchFailed).toBe(false);
  });

  describe("restart", () => {
    async function restart() {
      engine = newEngine();
      await engine.init();
    }

    it("an iteration inserted but never dispatched is dispatched on boot", async () => {
      const first = await startLoop();
      agentOps.prepareReviewer.mockImplementationOnce(() => new Promise(() => undefined)); // crash mid-dispatch
      await finish(first, "Status: continue\nItem: a");
      const stuck = await vi.waitFor(async () => { const r = await onlyActive(); expect(r.round).toBe(2); return r; });
      expect(stuck.status).toBe("preparing");

      await restart();
      await vi.waitFor(async () => expect((await storage.workflowRuns.getById(stuck.id))?.status).toBe("running_task"));
    });

    it("an iteration interrupted by the restart is NOT re-run: gate + bell", async () => {
      const first = await startLoop();
      transcripts.get(first.source_session_id)!.push({ type: "turn_end", timestamp: 2, outcome: "server_restart" } as AgentMessage);
      await restart();
      expect((await storage.workflowRuns.getById(first.id))?.status).toBe("failed");
      const gate = await onlyActive();
      expect(gate.status).toBe("waiting_resume");
      expect(gate.error).toContain("重启");
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
      expect(await outbox()).toEqual([expect.objectContaining({ kind: "workflow_failed" })]);
    });

    it("a turn that completed while the server was down is claimed late, and the loop goes on", async () => {
      const first = await startLoop();
      transcripts.get(first.source_session_id)!.push(
        { type: "assistant", content: "Status: continue\nItem: a", timestamp: 1 },
        { type: "turn_end", timestamp: 2, outcome: "completed" } as AgentMessage,
      );
      await restart();
      await vi.waitFor(async () => expect(await onlyActive()).toMatchObject({ round: 2, status: "running_task" }));
      expect((await storage.workflowRuns.getById(first.id))?.outcome_status).toBe("continue");
    });
  });

  // Review round 1 (2026-09-20): stopping, concurrency and crash windows.
  describe("stop / concurrency / crash windows", () => {
    async function restart() {
      engine = newEngine();
      await engine.init();
    }
    const noActiveLoop = () => vi.waitFor(async () => expect(await active()).toHaveLength(0));

    it("cancel that races the iteration being settled still ends the loop", async () => {
      const first = await startLoop();
      const real = storage.workflowRuns.getActiveInLoop.bind(storage.workflowRuns);
      // The iteration settles (and the next one is inserted) between cancel's
      // read of "the active run" and its CAS.
      vi.spyOn(storage.workflowRuns, "getActiveInLoop").mockImplementationOnce(async (loopId) => {
        const stale = await real(loopId);
        await finishAndAdvance(first, "Status: continue\nItem: a");
        return stale;
      });
      await engine.cancelRun(first.id);
      await noActiveLoop();
      const runs = await storage.workflowRuns.getActive("p1", "dev");
      expect(runs).toHaveLength(0);
      // The session of the iteration that slipped in is stopped too.
      const second = (await storage.workflowRuns.getLoopRound(first.id, 2))!;
      expect(second.status).toBe("cancelled");
      expect(stopped).toContain(second.source_session_id);
    });

    // No crash is injected here. What this pins is the SHAPE: an abnormal end is
    // one storage call carrying all three writes — never `abandon` / `transition`
    // / `create` in sequence, where a crash in between strands a `running_task`
    // run that restart reconciliation (which walks open steps) never sees again.
    // That the one call is all-or-nothing is pinned in
    // storage/workflow-run-steps.test.ts ("…or does none of it").
    it("an abnormal end is a single transactional write: step abandoned + run ended + gate inserted", async () => {
      const first = await startLoop();
      const claim = vi.spyOn(storage.workflowRuns, "claimStepAndTransition");
      const abandon = vi.spyOn(storage.workflowRunSteps, "abandon");
      const create = vi.spyOn(storage.workflowRuns, "create");
      await finish(first, "", "failed");

      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0][0]).toMatchObject({
        abandonStep: expect.stringContaining("failed"),
        run: { id: first.id, to: "failed", outbox: expect.objectContaining({ kind: "workflow_failed" }) },
        insertRun: { status: "waiting_resume", round: 2, loop_id: first.id },
      });
      expect(abandon).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect((await storage.workflowRuns.getById(first.id))?.status).toBe("failed");
      expect(await onlyActive()).toMatchObject({ status: "waiting_resume", round: 2 });
    });

    describe("crash after the instruction was delivered, before the run reached running_task", () => {
      async function startAndCrashBeforeRunningTask() {
        const realTransition = storage.workflowRuns.transition.bind(storage.workflowRuns);
        vi.spyOn(storage.workflowRuns, "transition").mockImplementationOnce(async (id, from, to, patch) => {
          if (from === "preparing" && to === "running_task") throw new Error("crash");
          return realTransition(id, from, to, patch);
        });
        await startLoop().catch(() => undefined);
        const run = await onlyActive();
        expect(run.status).toBe("preparing");
        return run;
      }

      it("the turn completed meanwhile → settled from the evidence, and the loop goes on", async () => {
        const first = await startAndCrashBeforeRunningTask();
        transcripts.get(first.source_session_id)!.push(
          { type: "assistant", content: "Status: done", timestamp: 1 },
          { type: "turn_end", timestamp: 2, outcome: "completed" } as AgentMessage,
        );
        await restart();
        await vi.waitFor(async () => expect((await storage.workflowRuns.getById(first.id))?.status).toBe("completed"));
        expect(await active()).toHaveLength(0);
        expect(await outbox()).toEqual([expect.objectContaining({ kind: "loop_done" })]);
        expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
      });

      it("the turn was interrupted → gate + bell, never a silent re-dispatch", async () => {
        const first = await startAndCrashBeforeRunningTask();
        transcripts.get(first.source_session_id)!.push({ type: "turn_end", timestamp: 2, outcome: "server_restart" } as AgentMessage);
        await restart();
        expect((await storage.workflowRuns.getById(first.id))?.status).toBe("failed");
        expect(await onlyActive()).toMatchObject({ status: "waiting_resume", round: 2 });
        expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
      });
    });

    // Review round 2: the settlement's view of the run is a snapshot, and two
    // legitimate writers can move the row between that snapshot and the commit.
    it("a completion read at `preparing` still settles after the dispatch path records running_task", async () => {
      const realTransition = storage.workflowRuns.transition.bind(storage.workflowRuns);
      let held: (() => Promise<boolean>) | null = null;
      // Hold the dispatch path's `preparing → running_task` back…
      vi.spyOn(storage.workflowRuns, "transition").mockImplementationOnce(async (id, from, to, patch) => {
        held = () => realTransition(id, from, to, patch);
        throw new Error("held");
      });
      await startLoop({ checkCommand: "npm test" }).catch(() => undefined);
      const first = await onlyActive();
      expect(first.status).toBe("preparing");
      // …and let it land while the settlement (which already read `preparing`) awaits the check.
      check.mockImplementationOnce(async () => { expect(await held!()).toBe(true); return { ok: true, output: "" }; });

      const list = transcripts.get(first.source_session_id)!;
      list.push({ type: "assistant", content: "Status: done", timestamp: 1 }, { type: "turn_end", timestamp: 2, outcome: "completed" } as AgentMessage);
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: first.source_session_id, turnEndEntryIndex: list.length - 1 });
      await vi.waitFor(async () => expect((await storage.workflowRuns.getById(first.id))?.status).toBe("completed"));
      expect(await outbox()).toEqual([expect.objectContaining({ kind: "loop_done" })]);
    });

    it("a soft stop that lands after the settlement's last read of params is still honoured", async () => {
      const first = await startLoop();
      const realClaim = storage.workflowRuns.claimStepAndTransition.bind(storage.workflowRuns);
      let paused: WorkflowRun | undefined;
      vi.spyOn(storage.workflowRuns, "claimStepAndTransition").mockImplementationOnce(async (input) => {
        paused = await engine.pauseLoop(first.id); // returns success: the run is still active
        return realClaim(input);
      });
      await finish(first, "Status: continue\nItem: a");
      expect(paused?.status).toBe("running_task");
      const gate = await vi.waitFor(async () => { const r = await onlyActive(); expect(r.round).toBe(2); return r; });
      expect(gate.status).toBe("waiting_resume");
      expect(gate.error).toContain("暂停");
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
    });

    it("two concurrent starts on one workspace: exactly one loop", async () => {
      const results = await Promise.allSettled([startLoop(), startLoop()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "session-busy" });
      expect(await active()).toHaveLength(1);
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
    });

    it("a replayed runId returns the same loop only for the same workspace and instruction", async () => {
      await storage.projects.create({ id: "p2", name: "q", path: "/tmp/q" });
      const first = await startLoop({ runId: "fixed-run-id" });
      expect((await startLoop({ runId: "fixed-run-id" })).id).toBe(first.id);
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);

      const other = { id: "p2", name: "q", path: "/tmp/q" } as never;
      await expect(engine.startRepeatLoop({ project: other, branch: "dev", prompt: "Process the next unhandled order.", runId: "fixed-run-id" }))
        .rejects.toMatchObject({ code: "bad-state" });
      await expect(startLoop({ runId: "fixed-run-id", prompt: "something else" })).rejects.toMatchObject({ code: "bad-state" });
    });

    it("the time cap stops an iteration that never finishes: session stopped, gate + bell", async () => {
      const first = await startLoop({ maxMinutes: 1 });
      await engine.checkLoopDeadlines(Date.now() + 30_000);
      expect((await storage.workflowRuns.getById(first.id))?.status).toBe("running_task");

      await engine.checkLoopDeadlines(Date.now() + 2 * 60_000);
      expect((await storage.workflowRuns.getById(first.id))?.status).toBe("failed");
      expect(stopped).toEqual([first.source_session_id]);
      const gate = await onlyActive();
      expect(gate).toMatchObject({ status: "waiting_resume", round: 2 });
      expect(gate.error).toContain("时长上限");
      expect(await outbox()).toEqual([expect.objectContaining({ kind: "workflow_failed", session_id: first.source_session_id })]);
      // The stop we issued must not be read as "stopped by the user".
      bus.emit({ type: "session:status", projectId: "p1", branch: "dev", sessionId: first.source_session_id, status: "stopped" });
      await new Promise((r) => setTimeout(r, 50));
      expect(await active()).toHaveLength(1);
    });

    it("a soft stop requested while the check command runs is honoured", async () => {
      const first = await startLoop({ checkCommand: "npm test" });
      check.mockImplementationOnce(async () => {
        await engine.pauseLoop(first.id);
        return { ok: true, output: "" };
      });
      await finish(first, "Status: continue\nItem: a");
      const gate = await vi.waitFor(async () => { const r = await onlyActive(); expect(r.round).toBe(2); return r; });
      expect(gate.status).toBe("waiting_resume");
      expect(gate.error).toContain("暂停");
      expect(agentOps.activateReviewer).toHaveBeenCalledTimes(1);
    });
  });
});
