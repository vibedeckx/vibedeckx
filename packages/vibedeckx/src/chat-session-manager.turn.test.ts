import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { openTurn } from "./commander-turn.js";
import { chatPlanSchema, type ChatPlan } from "./chat-plan.js";
import { EventBus } from "./event-bus.js";
import { resolveChatModel } from "./utils/chat-model.js";
import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { AgentSessionLifecycleService } from "./agent-session-lifecycle.js";
import type { RemoteSessionLifecycleAdapter } from "./remote-session-lifecycle.js";

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
    subscribe: vi.fn(() => () => {}),
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
  return { manager, id, bus, idle, userMessages, continuations, stop, start, outboxInsert, milestones, emitBranchActivityIfChanged, storage };
}

const managers: ChatSessionManager[] = [];
// A test must leave nothing running: a background turn would call the next
// test's mocked model and corrupt its script.
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

type Internal = {
  deliver: (id: string, arrival: { source: "user" | "result" | "notice" | "browser" | "nudge"; content: string }) => void;
  startTerminalWatcher: (sessionId: string, terminalId: string) => void;
  startRemoteTerminalWatcher: (sessionId: string, terminalId: string, info: { remoteServerId: string; remoteProcessId: string }) => void;
  reverseConnectManager: unknown;
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

  it("a finish whose lookups outlast the stream it arrived in still joins that turn", async () => {
    let phase = 0;
    let releaseLookup!: () => void;
    const lookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const ctx = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1:
          // The finish lands mid-stream; its executor lookup is still pending when the stream ends.
          ctx.stop(ctx.start.mock.calls[0][3]);
          return text("Checking.");
        case 2: return call("finish", "complete_task", { summary: "Built" });
        case 3: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    const { manager, id, idle, storage, userMessages } = ctx;
    await manager.sendMessage(id, "Build it");
    await idle();
    const getById = vi.mocked(storage.executors.getById);
    const original = getById.getMockImplementation()!;
    getById.mockImplementation(async (executorId: string) => { await lookup; return original(executorId); });

    await manager.sendMessage(id, "How is it going?");
    await idle();
    expect(phase).toBe(2);
    const turn = manager.getSession(id)!.turn;
    expect(turn?.status).toBe("waiting");

    releaseLookup();
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(phase).toBe(4);
    expect(turnEnds(manager, id)).toBe(1);
    expect(userMessages().filter((content) => content.startsWith("[System Invariant Violation]"))).toEqual([]);
    expect(userMessages().at(-1)).toMatch(/^\[Executor Event: Process Finished\]/);
  });
});

describe("terminal watch that goes quiet", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a local watch with no output reports that instead of stopping silently", () => {
    vi.useFakeTimers();
    const { manager, id } = setup(async () => text("unused"));
    const internal = manager as unknown as Internal;
    const delivered: string[] = [];
    vi.spyOn(internal, "deliver").mockImplementation((_id, arrival) => { delivered.push(arrival.content); });
    manager.getSession(id)!.turn = openTurn({ source: "user", content: "watch it" }, "turn-1");
    internal.startTerminalWatcher(id, "t1");
    expect(manager.getSession(id)!.pending.isOpen("terminal_watch", "t1")).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(manager.getSession(id)!.pending.hasOpen()).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^\[Terminal Event: No New Output\]\nTerminal: t1/);
  });

  it("a remote watch with no output reports that too", () => {
    vi.useFakeTimers();
    const { manager, id } = setup(async () => text("unused"));
    const internal = manager as unknown as Internal;
    internal.reverseConnectManager = {
      isConnected: () => true, setChannelAdapter: vi.fn(), openVirtualChannel: vi.fn(), closeChannel: vi.fn(), sendChannelData: vi.fn(),
    };
    const delivered: string[] = [];
    vi.spyOn(internal, "deliver").mockImplementation((_id, arrival) => { delivered.push(arrival.content); });
    manager.getSession(id)!.turn = openTurn({ source: "user", content: "watch it" }, "turn-1");
    internal.startRemoteTerminalWatcher(id, "remote-t1", { remoteServerId: "srv", remoteProcessId: "rp1" });
    expect(manager.getSession(id)!.pending.isOpen("terminal_watch", "remote-t1")).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(manager.getSession(id)!.pending.hasOpen()).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^\[Terminal Event: No New Output\]\nTerminal: remote-t1/);
  });
});

describe("complete_task and wait", () => {
  const toolResults = (manager: ChatSessionManager, id: string, tool: string) => manager.getMessages(id)
    .filter((m): m is Extract<typeof m, { type: "tool_result" }> => m.type === "tool_result" && m.tool === tool)
    .map((m) => JSON.parse(m.output) as Record<string, unknown>);

  afterEach(() => { vi.useRealTimers(); });

  it("complete_task is refused while a run is in flight, and accepted once it reported back", async () => {
    let phase = 0;
    const { manager, id, idle, stop, start } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("early", "complete_task", { summary: "Done" });
        case 2: return text("The build is still running.");
        case 3: return call("finish", "complete_task", { summary: "Built" });
        case 4: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.sendMessage(id, "Done yet?");
    await idle();
    const [refused] = toolResults(manager, id, "complete_task");
    expect(refused).toMatchObject({ completed: false, stillRunning: [expect.objectContaining({ kind: "executor" })] });
    expect(manager.getSession(id)!.taskCompleted).toBe(false);
    expect(manager.getSession(id)!.turn?.status).toBe("waiting");

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(toolResults(manager, id, "complete_task")[1]).toMatchObject({ completed: true });
    expect(turnEnds(manager, id)).toBe(1);
  });

  it("a second complete_task in the same turn changes nothing", async () => {
    let phase = 0;
    const { manager, id, idle } = setup(async () => {
      switch (phase++) {
        case 0: return call("one", "complete_task", { summary: "Done" });
        case 1: return call("two", "complete_task", { summary: "Done again" });
        case 2: return text("Done.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Wrap up");
    await idle();
    expect(toolResults(manager, id, "complete_task")).toEqual([
      expect.objectContaining({ completed: true, message: "Task marked complete: Done" }),
      expect.objectContaining({ completed: true, message: "Task already marked complete." }),
    ]);
  });

  it("wait ends the response and its timeout wakes the turn, unattended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase = 0;
    let woken = "";
    const { manager, id, idle } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("wait", "wait", { timeoutSeconds: 30 });
        case 2:
          woken = JSON.stringify(options.prompt);
          return text("Still building.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.sendMessage(id, "Let me know");
    await idle();
    expect(phase).toBe(2);
    expect(toolResults(manager, id, "wait")[0]).toMatchObject({ success: true, timeoutSeconds: 30 });
    expect(manager.getSession(id)!.turn?.status).toBe("waiting");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(phase).toBe(3));
    await idle();
    expect(woken).toContain("[Wait Timeout]");
    expect(woken).toContain('executor \\"build\\" on local');
    expect(manager.getSession(id)!.turn).toMatchObject({ status: "waiting", userPresent: false });
  });

  it("a result wakes a waiting turn before its wait runs out, and the timeout is dropped", async () => {
    let phase = 0;
    const { manager, id, idle, stop, start } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1: return call("wait", "wait", {});
        case 2: return call("finish", "complete_task", { summary: "Built" });
        case 3: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.sendMessage(id, "Tell me when it is done");
    await idle();
    const timers = (manager as unknown as { waitTimers: Map<string, unknown> }).waitTimers;
    expect(timers.has(id)).toBe(true);

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(timers.has(id)).toBe(false);
    expect(phase).toBe(4);
  });

  it("wait is refused when nothing is running", async () => {
    let phase = 0;
    const { manager, id, idle } = setup(async () => {
      switch (phase++) {
        case 0: return call("wait", "wait", {});
        case 1: return text("Nothing to wait for; here is the answer.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Anything running?");
    await idle();
    expect(toolResults(manager, id, "wait")[0]).toMatchObject({ success: false });
    expect(manager.getSession(id)!.turn).toBeNull();
  });

  it("new work after complete_task withdraws the completion, even when its result returns mid-stream", async () => {
    let phase = 0;
    const ctx = setup(async () => {
      switch (phase++) {
        case 0: return call("done", "complete_task", { summary: "Done" });
        case 1: return call("run", "runExecutor", { executorName: "build" });
        case 2: return call("again", "complete_task", { summary: "Built after all" });
        case 3: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    const { manager, id, start, stop, emitBranchActivityIfChanged } = ctx;
    // The run finishes before runExecutor even returns: its result lands in the inbox mid-stream.
    start.mockImplementationOnce(async (_executor: unknown, _base: string, _skipDb: boolean, processId: string) => {
      stop(processId);
      return processId;
    });
    await manager.sendMessage(id, "Wrap up, then build");
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(phase).toBe(4);
    expect(toolResults(manager, id, "complete_task")[1]).toMatchObject({ completed: true, message: "Task marked complete: Built after all" });
    const dots = emitBranchActivityIfChanged.mock.calls.map((args) => (args[2] as { activity: string }).activity);
    expect(dots.slice(dots.indexOf("main-completed"))).toContain("main-running");
  });

  it("new work after complete_task that keeps running leaves the turn waiting, not complete", async () => {
    let phase = 0;
    const { manager, id, idle, emitBranchActivityIfChanged } = setup(async () => {
      switch (phase++) {
        case 0: return call("done", "complete_task", { summary: "Done" });
        case 1: return call("run", "runExecutor", { executorName: "build" });
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Wrap up, then build");
    await idle();
    expect(manager.getSession(id)!.taskCompleted).toBe(false);
    expect(manager.getSession(id)!.turn?.status).toBe("waiting");
    expect(emitBranchActivityIfChanged).toHaveBeenLastCalledWith("p1", "dev", expect.objectContaining({ activity: "main-running" }));
  });

  it.each(["wait", "complete_task"] as const)("%s sees a result that arrived mid-stream before the model did", async (tool) => {
    let phase = 0;
    let after = "";
    const ctx = setup(async (options) => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1:
          ctx.stop(ctx.start.mock.calls[0][3]);
          await vi.waitFor(() => expect(ctx.manager.getSession(ctx.id)!.turn!.inbox).toHaveLength(1));
          return call("t", tool, tool === "wait" ? {} : { summary: "Done" });
        // A refused complete_task leaves the rest of that stream to the model.
        case 2:
          if (tool === "complete_task") return text("Let me read that first.");
          after = JSON.stringify(options.prompt);
          return call("done", "complete_task", { summary: "Built" });
        case 3:
          if (tool === "wait") return text("Built.");
          after = JSON.stringify(options.prompt);
          return call("done", "complete_task", { summary: "Built" });
        case 4:
          if (tool === "complete_task") return text("Built.");
          throw new Error(`Unexpected model call ${phase}`);
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    const { manager, id, idle } = ctx;
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.sendMessage(id, "Status?");
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    await idle();
    const [result] = toolResults(manager, id, tool);
    if (tool === "wait") expect(result).toMatchObject({ success: true, arrived: 1 });
    else expect(result).toMatchObject({ completed: false });
    expect(after).toContain("[Executor Event: Process Finished]");
    expect(phase).toBe(tool === "wait" ? 4 : 5);
    expect(turnEnds(manager, id)).toBe(1);
  });

  it("a run whose finish was never observed and has no exit code on record is reported as unknown, not failed", async () => {
    let phase = 0;
    let woken = "";
    const { manager, id, idle } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1:
          woken = JSON.stringify(options.prompt);
          return call("done", "complete_task", { summary: "Reported" });
        case 2: return text("I could not tell whether the build succeeded.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    }, { running: false, lastRow: { status: "failed", exit_code: null, started_at: "2026-01-01 00:00:00", finished_at: "2026-01-01 00:00:05" } });
    await manager.sendMessage(id, "Build it");
    await idle();
    const turn = manager.getSession(id)!.turn!;
    await manager.reconcileInFlight(Date.now() + 60_000);
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(turn.streams).toBe(2);
    expect(woken).toContain("Exit Code: unknown (outcome unknown)");
    expect(woken).not.toContain("Exit Code: 1");
    expect(woken).toContain("whether this run succeeded is unknown");
  });

  it("a spawn that never comes up answers the model at its deadline, and the turn can end", async () => {
    let phase = 0;
    let spawnResult = "";
    const { manager, id } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("spawn", "spawnAgentSession", { prompt: "Refactor the login page" });
        case 1:
          spawnResult = JSON.stringify(options.prompt);
          return call("done", "complete_task", { summary: "Could not confirm the agent" });
        case 2: return text("The coding agent did not come up; check it before retrying.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    (manager as unknown as { agentSessionManager: Record<string, unknown> }).agentSessionManager.getSessionByBranch = vi.fn(() => null);
    const never = { start: () => new Promise(() => {}) };
    manager.setSessionLifecycle(never as unknown as AgentSessionLifecycleService, never as unknown as RemoteSessionLifecycleAdapter);
    manager.spawnDeadlineMs = 30;

    await manager.sendMessage(id, "Get an agent on the login page");
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(phase).toBe(3);
    expect(spawnResult).toContain("startUnconfirmed");
    expect(turnEnds(manager, id)).toBe(1);
  });
});

describe("stopping a turn", () => {
  it("Stop ends a waiting turn as cancelled without touching the run; its later finish is dropped while not listening", async () => {
    let phase = 0;
    const { manager, id, idle, stop, start, emitBranchActivityIfChanged } = setup(async () => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    expect(manager.getSession(id)!.turn?.status).toBe("waiting");

    expect(manager.stopGeneration(id)).toBe(true);
    expect(manager.getSession(id)!.turn).toBeNull();
    expect(manager.getSession(id)!.pending.outcomeOf("executor", "run")).toBe("cancelled");
    expect(turnEnds(manager, id)).toBe(1);
    expect(emitBranchActivityIfChanged).toHaveBeenLastCalledWith("p1", "dev", expect.objectContaining({ activity: "stopped" }));

    stop(start.mock.calls[0][3]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.getSession(id)!.turn).toBeNull();
    expect(phase).toBe(1);
  });

  it("with listening on, a stopped run's later finish arrives as an event in a turn of its own", async () => {
    let phase = 0;
    let woken = "";
    const { manager, id, idle, stop, start } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("run", "runExecutor", { executorName: "build" });
        case 1:
          woken = JSON.stringify(options.prompt);
          return call("noted", "complete_task", { summary: "Noted" });
        case 2: return text("The stopped build finished.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    manager.setEventListening(id, true);
    await manager.sendMessage(id, "Build it");
    await idle();
    manager.stopGeneration(id);

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(phase).toBe(3));
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    expect(woken).toContain("[Executor Event: Process Finished]");
    expect(turnEnds(manager, id)).toBe(2);
  });

  it("Stop mid-stream keeps the user's queued words for the next turn and drops unread results", async () => {
    let phase = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let next = "";
    const { manager, id, idle, userMessages } = setup(async (options) => {
      switch (phase++) {
        case 0: await gate; return text("late");
        case 1:
          next = JSON.stringify(options.prompt);
          return call("done", "complete_task", { summary: "Answered" });
        case 2: return text("Done.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    const first = manager.sendMessage(id, "do something long");
    await vi.waitFor(() => expect(phase).toBe(1));
    void manager.sendMessage(id, "actually, do this instead");
    (manager as unknown as Internal).deliver(id, { source: "result", content: "[Terminal Event: Output]\nstale" });
    manager.stopGeneration(id);
    release();
    await first;
    await vi.waitFor(() => expect(phase).toBe(3));
    await vi.waitFor(() => expect(manager.getSession(id)!.turn).toBeNull());
    await idle();
    expect(next).toContain("actually, do this instead");
    expect(userMessages().some((content) => content.includes("stale"))).toBe(false);
    expect(turnEnds(manager, id)).toBe(2);
  });

  it("Stop stops watching the turn's terminals", async () => {
    const { manager, id } = setup(async () => text("unused"));
    const internal = manager as unknown as Internal & { terminalWatchers: Map<string, unknown> };
    const session = manager.getSession(id)!;
    session.turn = openTurn({ source: "user", content: "watch it" }, "turn-1");
    session.turn.status = "waiting";
    internal.startTerminalWatcher(id, "t1");
    expect(internal.terminalWatchers.has("t1")).toBe(true);

    manager.stopGeneration(id);
    expect(internal.terminalWatchers.has("t1")).toBe(false);
    expect(session.pending.hasOpen()).toBe(false);
  });
});

