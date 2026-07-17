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
  extractLatestTurnEndIndex,
  extractLastAssistantBefore,
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
    getRawMessages: vi.fn((sessionId: string) => (sessionId === "s-rev" ? reviewerEntries : entries)),
  };
  const project = { id: "p1", path: "/tmp/does-not-exist-vdx" }; // non-git → null review target, still fine

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-eng-"));
    storage = await createSqliteStorage(path.join(dir, "t.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: project.path });
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

  it("startAdhocReview creates run, spawns reviewer, sends prompt", async () => {
    const run = await start();
    expect(run.status).toBe("waiting_reviewer");
    expect(run.reviewer_session_id).toBe("s-rev");
    expect(run.source_turn_end_index).toBe(4); // derived from entries
    expect(agentOps.createNewSession).toHaveBeenCalledWith("p1", "dev", project.path, false, "edit", "claude-code", true);
    const prompt = agentOps.sendUserMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("please fix the bug");   // task context
    expect(prompt).toContain("focus on tests");        // review focus
  });

  it("rejects when a participant session is already in an active run", async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: "session-busy" });
  });

  it("rejects a source session with no completed turn", async () => {
    agentOps.getRawMessages.mockReturnValueOnce([]);
    await expect(start()).rejects.toMatchObject({ code: "no-completed-turn" });
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

  it("handleExternalUserMessage ends the run (human takeover)", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("cancelled");
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(false);
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
