import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server.js";
import { createSqliteStorage } from "../../storage/sqlite.js";
import { parseRepeatParams } from "../../workflow-repeat-loop.js";

// Uses real product services, SQLite, fx and the current user's credentials.
// Deliberately opt-in: ordinary unit tests must not call a paid model.
describe.skipIf(process.env.FX_ORCHESTRATION_LIVE !== "1")("fx orchestration product paths", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    const dispose = cleanup;
    cleanup = undefined;
    await dispose?.();
  });

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "fx-orchestration-"));
    const dir = join(root, "workspace");
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    const storage = await createSqliteStorage(join(root, "db.sqlite"));
    const server = await createServer({ storage, uiRoot: null });
    const { instance } = await server.startLocal(0);
    instance.agentSessionManager.suppressTitleGeneration = true;
    const project = await storage.projects.create({ id: "p", name: "fx orchestration", path: dir });
    cleanup = async () => {
      for (const row of await storage.agentSessions.getAll()) await instance.agentSessionManager.stopSessionAndWait(row.id);
      await server.close();
      await storage.close();
      rmSync(root, { recursive: true, force: true });
    };
    return { dir, storage, instance, project };
  }

  it("runs two items in fresh fx sessions, then stops when the verification command fails", async () => {
    const { storage, instance, project } = await setup();
    const first = await instance.workflowEngine.startRepeatLoop({
      project, branch: null, agentType: "fx", model: process.env.FX_SMOKE_MODEL ?? "openai/gpt-5.4-mini",
      name: "FX two items", maxIterations: 3,
      prompt: "This is a protocol acceptance check; do not use tools or change files. There are exactly two items: alpha and beta. If the completed-items list contains alpha, reply exactly:\nStatus: done\nItem: beta\nRemaining: 0\nOtherwise reply exactly:\nStatus: continue\nItem: alpha\nRemaining: 1",
    });
    await vi.waitFor(async () => {
      expect(await storage.workflowRuns.getLoopRound(first.id, 2)).toMatchObject({ status: "completed", outcome_status: "done" });
    }, { timeout: 120_000, interval: 200 });
    const second = (await storage.workflowRuns.getLoopRound(first.id, 2))!;
    expect(second.source_session_id).not.toBe(first.source_session_id);
    expect(parseRepeatParams(second)).toMatchObject({ agentType: "fx", doneItems: ["alpha"] });
    for (const run of [first, second]) {
      expect(await storage.agentSessions.getById(run.source_session_id)).toMatchObject({ agent_type: "fx", permission_mode: "edit" });
      expect((await instance.agentSessionManager.loadRawMessages(run.source_session_id)).filter(e => e?.type === "turn_end")).toHaveLength(1);
    }
    expect(await storage.workflowRuns.getLoopRound(first.id, 3)).toBeUndefined();
    const failed = await instance.workflowEngine.startRepeatLoop({
      project, branch: null, agentType: "fx", model: process.env.FX_SMOKE_MODEL ?? "openai/gpt-5.4-mini",
      name: "FX failed check", maxIterations: 3, checkCommand: "exit 7",
      prompt: "Do not use tools. Reply exactly:\nStatus: continue\nItem: gamma\nRemaining: 1",
    });
    await vi.waitFor(async () => {
      expect(await storage.workflowRuns.getLoopRound(failed.id, 2)).toMatchObject({ status: "waiting_resume" });
    }, { timeout: 60_000, interval: 200 });
    expect(await storage.workflowRuns.getLoopRound(failed.id, 3)).toBeUndefined();
    console.log("FX_LOOP_PASS: two distinct sessions, done, failed verification stops next dispatch");
  }, 200_000);

  it("Main Chat spawns fx, sends a follow-up, receives both results and closes one commander turn", async () => {
    expect(process.env.DEEPSEEK_API_KEY, "Configure DEEPSEEK_API_KEY for the real Main Chat model").toBeTruthy();
    const { storage, instance } = await setup();
    const manager = instance.chatSessionManager;
    const id = manager.getOrCreateSession("p", null, "smoke-user");
    await manager.sendMessage(id,
      "This is an explicitly authorized integration test. Use spawnAgentSession with agentType fx " +
      "and prompt 'Do not use tools or modify files. Reply exactly FX_COMMANDER_FIRST'. " +
      "Wait for its actual completion event. Then use sendToAgentSession with message " +
      "'Do not use tools. Reply exactly FX_COMMANDER_SECOND'. Wait for that completion event too. " +
      "Finally call complete_task and report success. Do not use terminals, executors or any other agents.");
    await vi.waitFor(() => {
      // Exercise the normal Main Chat approval card for an event-driven
      // follow-up; only this fixed, harmless message is authorized by the test.
      for (const entry of manager.getMessages(id)) {
        if (entry.type !== "tool_approval_request" || entry.resolved) continue;
        expect(entry.tool).toBe("sendToAgentSession");
        expect(entry.input).toMatchObject({ message: "Do not use tools. Reply exactly FX_COMMANDER_SECOND" });
        expect(manager.resolveToolApproval(id, entry.approvalId, true)).toBe(true);
      }
      expect(manager.getMessages(id).filter(m => m.type === "turn_end")).toHaveLength(1);
      expect(manager.getSession(id)?.turn).toBeNull();
    }, { timeout: 180_000, interval: 200 });
    const sessions = (await storage.agentSessions.getAll()).filter(s => s.agent_type === "fx");
    expect(sessions).toHaveLength(1);
    const entries = await instance.agentSessionManager.loadRawMessages(sessions[0].id);
    const boundaries = entries.filter(e => e?.type === "turn_end");
    expect(boundaries).toHaveLength(2);
    for (const boundary of boundaries) expect(boundary).toMatchObject({ outcome: "completed" });
    const replies = entries.filter(e => e?.type === "assistant").map(e => e.content).join("\n");
    expect(replies).toContain("FX_COMMANDER_FIRST");
    expect(replies).toContain("FX_COMMANDER_SECOND");
    const messages = manager.getMessages(id);
    const completions = messages.filter(m => m.type === "user" && m.content.includes("[Agent Event: Task Completed]"));
    expect(completions).toHaveLength(2);
    expect(JSON.stringify(completions[0])).toContain("FX_COMMANDER_FIRST");
    expect(JSON.stringify(completions[1])).toContain("FX_COMMANDER_SECOND");
    console.log("FX_COMMANDER_PASS: real Main Chat model, fx spawn and follow-up, two completion events, one closed turn");
  }, 200_000);

  async function setupReview(author: "fx" | "claude-code") {
    const { storage, instance, project, dir } = await setup();
    const agents = instance.agentSessionManager;
    const engine = instance.workflowEngine;
    writeFileSync(join(dir, "sum.cjs"), "module.exports = (a, b) => a - b;\n");
    execFileSync("git", ["add", "sum.cjs"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.test", "commit", "-qm", "seed"], { cwd: dir });
    const source = await agents.createNewSession("p", null, dir, false, "edit", author, false, false,
      author === "fx" ? { model: process.env.FX_SMOKE_MODEL ?? "openai/gpt-5.4-mini" } : {});
    const waitTurns = async (sessionId: string, count: number) => vi.waitFor(async () => {
      const boundaries = (await agents.loadRawMessages(sessionId)).filter(e => e?.type === "turn_end");
      expect(boundaries).toHaveLength(count);
      for (const boundary of boundaries) expect(boundary).toMatchObject({ outcome: "completed" });
      expect((await storage.agentSessions.getById(sessionId))?.status).toBe("stopped");
    }, { timeout: 90_000, interval: 200 });
    await agents.sendUserMessage(source,
      "Read sum.cjs and explain what it currently computes. For this first turn only, do not change files. The acceptance criterion is that sum(2,3) equals 5. When reviewer feedback arrives, you are explicitly authorized and required to implement the fix and verify it; do not continue the first-turn restriction. Do not ask again whether to fix it or merely describe a proposed fix.", dir);
    await waitTurns(source, 1);
    return { storage, instance, project, dir, agents, engine, source, waitTurns };
  }

  for (const [author, reviewer] of [["fx", "claude-code"], ["claude-code", "fx"]] as const) {
    it(`${reviewer} reviews ${author} through prepare/activate, discussion, feedback and reviewer reuse`, async () => {
      const { storage, project, dir, agents, engine, source, waitTurns } = await setupReview(author);
      const run = await engine.prepareAdhocReview({ project, branch: null, sourceSessionId: source,
        reviewerAgentType: reviewer, reviewFocus: "Acceptance: sum(2,3) must equal 5. Identify the subtraction bug and request a concrete fix. This acceptance criterion overrides the earlier instruction to only explain." });
      expect(run.status).toBe("preparing");
      expect(await storage.agentSessions.getById(run.reviewer_session_id!)).toMatchObject({ agent_type: reviewer, permission_mode: "plan" });
      expect(agents.getSessionProcessAlive(run.reviewer_session_id!)).toBe(false);
      await engine.activateAdhocReview(run.id, { intentBrief: "The user requires sum(2,3) = 5; sum.cjs currently subtracts. The author has only explained it; the required implementation is missing." });
      await vi.waitFor(async () => expect(await storage.workflowRuns.getById(run.id)).toMatchObject({ status: "waiting_feedback", verdict: "needs-changes" }), { timeout: 90_000, interval: 200 });
      await waitTurns(run.reviewer_session_id!, 1);
      expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" })).toBe("");
      expect(readFileSync(join(dir, "sum.cjs"), "utf8")).toBe("module.exports = (a, b) => a - b;\n");
      await engine.handleExternalUserMessage(run.reviewer_session_id!);
      await agents.sendUserMessage(run.reviewer_session_id!, "Confirm the smallest fix is to replace subtraction with addition. Do not modify files.", dir);
      await waitTurns(run.reviewer_session_id!, 2);
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
      await engine.requestFinalVerdict(run.id);
      await waitTurns(run.reviewer_session_id!, 3);
      await vi.waitFor(async () => expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback"));
      expect(execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" })).toBe("");
      await engine.approveFeedback(run.id);
      await waitTurns(source, 2);
      await vi.waitFor(async () => expect((await storage.workflowRuns.getById(run.id))?.status).toBe("completed"));
      expect(execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('./sum.cjs')(2,3)))"], { cwd: dir, encoding: "utf8" })).toBe("5");
      const fixedContent = readFileSync(join(dir, "sum.cjs"), "utf8");
      const fixedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
      const fixedDiff = execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" });
      const rereview = await engine.startAdhocReview({ project, branch: null, sourceSessionId: source,
        reviewerSessionId: run.reviewer_session_id! });
      await vi.waitFor(async () => expect(await storage.workflowRuns.getById(rereview.id)).toMatchObject({ status: "waiting_feedback", verdict: "ship" }), { timeout: 90_000, interval: 200 });
      expect(rereview.reviewer_session_id).toBe(run.reviewer_session_id);
      await waitTurns(run.reviewer_session_id!, 4);
      expect(readFileSync(join(dir, "sum.cjs"), "utf8")).toBe(fixedContent);
      expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" })).toBe(fixedStatus);
      expect(execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe(fixedDiff);
      console.log(`FX_REVIEW_PASS: reviewer=${reviewer}, author=${author}, prepare/activate, discussion, final verdict, fix, reviewer reuse, unchanged reviewed files`);
    }, 400_000);

    it(`automatically relays ${reviewer} feedback to ${author} and re-reviews the fix`, async () => {
      const { storage, project, dir, engine, source, waitTurns } = await setupReview(author);
      const run = await engine.startAdhocReview({ project, branch: null, sourceSessionId: source,
        reviewerAgentType: reviewer, loop: { maxRounds: 2 },
        intentBrief: "Implement sum(2,3) = 5. The current sum.cjs subtracts; the author has only explained it and is authorized to fix it after feedback.",
        reviewFocus: "Acceptance: sum(2,3) must equal 5 in the actual workspace. Identify the subtraction bug and request a concrete fix if it is still present. This acceptance criterion overrides the earlier instruction to only explain; a correct explanation or proposed fix does not satisfy acceptance." });
      await vi.waitFor(async () => {
        expect(await storage.workflowRuns.getLoopRound(run.id, 2)).toMatchObject({ verdict: "ship", status: "waiting_feedback" });
      }, { timeout: 180_000, interval: 200 });
      const second = (await storage.workflowRuns.getLoopRound(run.id, 2))!;
      await waitTurns(source, 2);
      await waitTurns(run.reviewer_session_id!, 2);
      expect(await storage.agentSessions.getById(run.reviewer_session_id!)).toMatchObject({ agent_type: reviewer, permission_mode: "plan" });
      expect(second.reviewer_session_id).toBe(run.reviewer_session_id);
      expect(await storage.workflowRuns.getById(run.id)).toMatchObject({ status: "completed", verdict: "needs-changes" });
      expect(execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('./sum.cjs')(2,3)))"], { cwd: dir, encoding: "utf8" })).toBe("5");
      console.log(`FX_AUTO_REVIEW_PASS: reviewer=${reviewer}, author=${author}, automatic feedback, fix, same reviewer second round passes`);
    }, 300_000);
  }

});
