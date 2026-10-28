import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { chatPlanSchema, type ChatPlan } from "./chat-plan.js";
import { EventBus } from "./event-bus.js";
import { resolveChatModel } from "./utils/chat-model.js";
import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";

vi.mock("./utils/chat-model.js", () => ({ resolveChatModel: vi.fn() }));

/**
 * The turn layer: a result of the chat's own work never opens a turn of its
 * own — it joins (and wakes) the turn that started the work. A turn ends once
 * it owes nothing, with one divider however many streams it took.
 * Design: docs/commander-turn-model-design.md.
 */

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type CallOptions = Parameters<MockLanguageModelV3["doStream"]>[0];

function response(parts: StreamPart[], toolCalls = false): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.enqueue({
          type: "finish", finishReason: { unified: toolCalls ? "tool-calls" : "stop", raw: toolCalls ? "tool-calls" : "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

const call = (id: string, toolName: string, input: unknown) => response([
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
], true);
const text = (value: string) => response([
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: value },
  { type: "text-end", id: "text" },
]);
/** An explicit, user-specified plan: no confirmation card. */
const explicitPlan = () => chatPlanSchema.parse({
  goal: "Build and verify", completionCriteria: ["Build exits 0"], requireConfirmation: false,
  steps: [{ id: "build", title: "Run the build" }],
});

const executor = { id: "e1", name: "build", command: "pnpm build", workspace_id: "w1", executor_type: "command", prompt_provider: null, cwd: null, pty: true };

function setup(doStream: MockLanguageModelV3["doStream"], opts: { running?: boolean; lastRow?: Record<string, unknown> } = {}) {
  const model = new MockLanguageModelV3({ doStream });
  vi.mocked(resolveChatModel).mockResolvedValue(model);
  const bus = new EventBus();
  const outboxInsert = vi.fn(async () => ({ inserted: true, seq: 1 }));
  const processRow = { id: "", executor_id: "e1", status: "running", exit_code: null, started_at: "2026-01-01 00:00:00", finished_at: null };
  const storage = {
    projects: { getById: vi.fn(async () => ({ id: "p1", path: "/repo", executor_mode: "local" })) },
    workspaceRegistry: {
      getWorkspaceByProjectBranch: vi.fn(async () => ({ id: "w1" })),
      getWorkspaceById: vi.fn(async () => ({ id: "w1", branch: "dev" })),
    },
    executors: { getByWorkspaceId: vi.fn(async () => [executor]), getById: vi.fn(async () => executor) },
    executorProcesses: {
      getLastByExecutorId: vi.fn(async () => opts.lastRow ?? processRow),
      getById: vi.fn(async (id: string) => ({ ...(opts.lastRow ?? processRow), id })),
    },
    remoteServers: { getById: vi.fn(async () => null), getAll: vi.fn(async () => []) },
    projectRemotes: { getByProject: vi.fn(async () => []) },
    notificationOutbox: { insert: outboxInsert },
  } as unknown as Storage;
  const start = vi.fn(async (_executor: unknown, _base: string, _skipDb: boolean, processId: string) => processId);
  const processManager = {
    start,
    getProcessesByExecutorId: vi.fn(() => []),
    isRunning: vi.fn(() => opts.running ?? true),
  } as unknown as ProcessManager;
  const emitBranchActivityIfChanged = vi.fn();
  const manager = new ChatSessionManager(
    storage, processManager,
    { emitBranchActivityIfChanged, getCurrentBranchActivity: vi.fn(() => "main-running") } as unknown as AgentSessionManager,
    new Map(), new Map(), {} as RemotePatchCache,
  );
  manager.setEventBus(bus);
  managers.push(manager);
  const milestones = vi.fn();
  manager.setMilestoneListener(milestones);
  manager.stallRetryDelayMs = 1;
  vi.spyOn(manager as unknown as { getSystemPrompt: () => Promise<string> }, "getSystemPrompt").mockResolvedValue("Commander");
  const id = manager.getOrCreateSession("p1", "dev", "u1");
  const idle = () => vi.waitFor(() => expect(manager.getSession(id)!.abortController).toBeNull());
  const userMessages = () => manager.getMessages(id).filter((m): m is Extract<typeof m, { type: "user" }> => m.type === "user").map((m) => m.content);
  const continuations = () => userMessages().filter((content) => content.startsWith("[Plan Continuation]"));
  const stop = (processId: string, exitCode = 0) => bus.emit({
    type: "executor:stopped", projectId: "p1", executorId: "e1", processId, exitCode, tailOutput: "done",
  });
  return { manager, id, bus, idle, userMessages, continuations, stop, start, outboxInsert, milestones, emitBranchActivityIfChanged };
}

const managers: ChatSessionManager[] = [];
// A test must leave nothing running: a background turn would call the next
// test's mocked model and corrupt its script.
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

type Internal = {
  deliver: (id: string, arrival: { source: "user" | "result" | "notice" | "browser" | "nudge"; content: string }) => void;
  createTools: (projectId: string, branch: string | null, sessionId?: string) => Record<string, { needsApproval?: unknown }>;
};

const turnEnds = (manager: ChatSessionManager, id: string) => manager.getMessages(id).filter((m) => m.type === "turn_end").length;

describe("commander turns", () => {
  it("a run's result wakes the waiting turn instead of opening a new one", async () => {
    let phase = 0;
    const { manager, id, idle, userMessages, stop, start } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("finish", "complete_task", { summary: "Built" });
        case 2: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    const turn = manager.getSession(id)!.turn;
    expect(turn).toMatchObject({ status: "waiting", openedBy: "user", streams: 1 });
    expect(turnEnds(manager, id)).toBe(0);

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(phase).toBe(3);
    expect(turn!.streams).toBe(2);
    expect(turnEnds(manager, id)).toBe(1);
    expect(userMessages()).toHaveLength(2);
    expect(userMessages()[1]).toMatch(/^\[Executor Event: Process Finished\]/);
  });

  it("a user message during a stream joins the turn instead of starting a second stream", async () => {
    let phase = 0;
    let live = 0;
    let maxLive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, id, idle, userMessages } = setup(async (options) => {
      live++;
      maxLive = Math.max(maxLive, live);
      try {
        switch (phase++) {
          case 0: await gate; return text("Looking.");
          case 1:
            expect(JSON.stringify(options.prompt)).toContain("also check the tests");
            return call("status", "getExecutorStatus", { tailLines: 5 });
          case 2: return text("Both checked.");
          default: throw new Error(`Unexpected model call ${phase}`);
        }
      } finally {
        live--;
      }
    });
    const first = manager.sendMessage(id, "check the build");
    await vi.waitFor(() => expect(phase).toBe(1));
    await manager.sendMessage(id, "also check the tests");
    release();
    await first;
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    await idle();
    expect(maxLive).toBe(1);
    expect(userMessages()).toEqual(["check the build", "also check the tests"]);
    expect(turnEnds(manager, id)).toBe(1);
  });

  it("the user speaking into a waiting turn wakes it", async () => {
    let phase = 0;
    const { manager, id, idle } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return text("Still building; I'll report when it finishes.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    const turn = manager.getSession(id)!.turn!;
    await manager.sendMessage(id, "How is it going?");
    await idle();
    expect(phase).toBe(2);
    // The run is still owed: the same turn waits on.
    expect(manager.getSession(id)!.turn).toBe(turn);
    expect(turn.status).toBe("waiting");
    expect(turnEnds(manager, id)).toBe(0);
  });

  it("a stream woken by a result needs approval for outbound agent actions; the user's own does not", async () => {
    let phase = 0;
    const { manager, id, idle, stop, start } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("run2", "runExecutor", { executorName: "build" });
        default: return text("ok");
      }
    });
    const internal = manager as unknown as Internal;
    const approvalNeeded = () => internal.createTools("p1", "dev", id).sendToAgentSession.needsApproval;
    await manager.sendMessage(id, "Build it");
    await idle();
    expect(manager.getSession(id)!.turn!.userPresent).toBe(true);
    expect(approvalNeeded()).toBe(false);

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(phase).toBe(2));
    await idle();
    expect(manager.getSession(id)!.turn!.userPresent).toBe(false);
    expect(approvalNeeded()).toBe(true);

    await manager.sendMessage(id, "carry on");
    await idle();
    expect(manager.getSession(id)!.turn!.userPresent).toBe(true);
  });

  it("a browser event waits for the next turn and is summarized without tools", async () => {
    let phase = 0;
    let browserTools: unknown;
    const { manager, id, idle, stop, start, userMessages } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("finish", "complete_task", { summary: "Built" });
        case 2: return text("Built.");
        case 3:
          browserTools = options.tools;
          return text("The page logged an error.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    const internal = manager as unknown as Internal;
    await manager.sendMessage(id, "Build it");
    await idle();
    internal.deliver(id, { source: "browser", content: "[Browser Event: Console Error]\nboom" });
    expect(manager.getSession(id)!.turn!.inbox).toEqual([]);

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(phase).toBe(4));
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(browserTools ?? []).toEqual([]);
    expect(userMessages().at(-1)).toMatch(/^\[Browser Event/);
    expect(turnEnds(manager, id)).toBe(2);
  });

  it("only a turn the user opened paints the orchestrator dot", async () => {
    const { manager, id, idle, emitBranchActivityIfChanged } = setup(async () => text("Noted."));
    const internal = manager as unknown as Internal;
    internal.deliver(id, { source: "notice", content: "[Executor Event: Process Finished]\nNot started by you" });
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    await idle();
    expect(emitBranchActivityIfChanged).not.toHaveBeenCalled();

    await manager.sendMessage(id, "hi");
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(emitBranchActivityIfChanged).toHaveBeenCalledWith("p1", "dev", expect.objectContaining({ activity: "main-running" }));
  });

  it("stopping a stream ends its turn as cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, id, idle } = setup(async () => { await gate; return text("late"); });
    const sent = manager.sendMessage(id, "do something long");
    await vi.waitFor(() => expect(manager.getSession(id)!.abortController).not.toBeNull());
    manager.stopGeneration(id);
    release();
    await sent;
    await idle();
    expect(manager.getSession(id)!.turn).toBeNull();
    expect(turnEnds(manager, id)).toBe(1);
  });
});
