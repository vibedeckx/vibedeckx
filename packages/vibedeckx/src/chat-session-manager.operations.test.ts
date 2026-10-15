import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "./chat-session-manager.js";
import { EventBus } from "./event-bus.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteExecutorStarts, RemoteStartOutcome, RemoteStartRequest } from "./remote-executor-starts.js";
import type { Storage } from "./storage/types.js";
import type { AgentSessionLifecycleService } from "./agent-session-lifecycle.js";
import type { RemoteSessionLifecycleAdapter } from "./remote-session-lifecycle.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { ProxyResult } from "./utils/remote-proxy.js";

const proxy = vi.hoisted(() => ({
  handler: null as null | ((method: string, path: string) => Promise<ProxyResult>),
}));
vi.mock("./utils/remote-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/remote-proxy.js")>()),
  proxyToRemoteAuto: vi.fn((_server: string, method: string, path: string) => proxy.handler!(method, path)),
}));
vi.mock("./remote-agent-sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-agent-sessions.js")>()),
  ensureRemoteAgentStream: vi.fn(),
  generateAndPushRemoteSessionTitle: vi.fn(async () => {}),
}));

/**
 * Commander operation identity (P1): a run's result goes back to the chat that
 * started it, exactly once, and nothing else is attributed to it.
 */
const executor = { id: "e1", name: "build", command: "pnpm build", workspace_id: "w1", executor_type: "command", prompt_provider: null, cwd: null, pty: true };

type ToolResult = Record<string, unknown>;

function setup(opts: {
  remote?: boolean;
  /** Called inside processManager.start, before it returns (e.g. an instant exit). */
  onLocalStart?: (processId: string) => void;
  running?: Array<{ processId: string; isRunning: boolean }>;
  remoteStart?: (request: RemoteStartRequest) => Promise<RemoteStartOutcome>;
  /** The local agent session on the branch, for sendToAgentSession. */
  agent?: { id: string; status: string; entries: number; send?: () => Promise<boolean> };
  /** Run the coding agent on a remote: the branch's remote session. */
  remoteAgent?: boolean;
  /** Commander spawn: the lifecycle start, given the bus. */
  spawn?: (bus: EventBus) => Promise<unknown>;
} = {}) {
  const bus = new EventBus();
  const storage = {
    projects: { getById: vi.fn(async () => ({
      id: "p1", path: "/repo", executor_mode: opts.remote ? "srv" : "local", agent_mode: opts.remoteAgent ? "srv" : "local",
    })) },
    searchCache: { updateRemoteSessionActivity: vi.fn(async () => true) },
    workspaceRegistry: {
      getWorkspaceByProjectBranch: vi.fn(async () => ({ id: "w1" })),
      getWorkspaceById: vi.fn(async () => ({ id: "w1", branch: "dev" })),
    },
    executors: {
      getByWorkspaceId: vi.fn(async () => [executor]),
      getById: vi.fn(async () => executor),
    },
    remoteServers: { getById: vi.fn(async () => ({ id: "srv" })), getAll: vi.fn(async () => []) },
    projectRemotes: {
      getByProjectAndServer: vi.fn(async () => ({ remote_path: "/remote/repo" })),
      getByProject: vi.fn(async () => []),
    },
  } as unknown as Storage;
  const start = vi.fn(async (_executor: unknown, _base: string, _skipDb: boolean, processId: string) => {
    opts.onLocalStart?.(processId);
    return processId;
  });
  const processManager = {
    start,
    getProcessesByExecutorId: vi.fn(() => opts.running ?? []),
  } as unknown as ProcessManager;
  const sendUserMessage = vi.fn(opts.agent?.send ?? (async () => true));
  const agentSessionManager = {
    emitBranchActivityIfChanged: vi.fn(),
    getSessionByBranch: vi.fn(() => opts.agent
      ? { id: opts.agent.id, status: opts.agent.status, store: { entries: new Array(opts.agent.entries) } }
      : null),
    sendUserMessage,
  } as unknown as AgentSessionManager;
  const remoteSessionMap = new Map<string, RemoteSessionInfo>(opts.remoteAgent
    ? [["remote-srv-p1-rs1", { remoteServerId: "srv", remoteSessionId: "rs1", branch: "dev" }]]
    : []);
  const manager = new ChatSessionManager(storage, processManager, agentSessionManager, remoteSessionMap, new Map(), {} as RemotePatchCache);
  const lifecycleStart = vi.fn(async () => opts.spawn?.(bus));
  manager.setSessionLifecycle(
    { start: lifecycleStart } as unknown as AgentSessionLifecycleService,
    { start: lifecycleStart } as unknown as RemoteSessionLifecycleAdapter,
  );
  manager.setEventBus(bus);
  const remoteStart = vi.fn(opts.remoteStart ?? (async () => ({ kind: "unknown", error: "unset" }) as RemoteStartOutcome));
  manager.setRemoteExecutorStarts({ start: remoteStart, reconcile: vi.fn() } as unknown as RemoteExecutorStarts);

  const chatId = manager.getOrCreateSession("p1", "dev", "u1");
  const delivered: string[] = [];
  vi.spyOn(manager as unknown as { enqueueOrSend: (id: string, content: string) => void }, "enqueueOrSend")
    .mockImplementation((id, content) => { if (id === chatId) delivered.push(content); });

  const tools = (manager as unknown as {
    createTools: (projectId: string, branch: string | null, sessionId?: string) => Record<string, {
      execute?: (input: unknown, options: unknown) => Promise<unknown>;
    }>;
  }).createTools("p1", "dev", chatId);
  const run = (toolCallId: string, input: Record<string, unknown> = {}) => tools.runExecutor.execute?.(
    { executorName: "build", ...input },
    { toolCallId, messages: [], abortSignal: new AbortController().signal },
  ) as Promise<ToolResult>;
  const stop = (processId: string, exitCode = 0) => bus.emit({
    type: "executor:stopped", projectId: "p1", executorId: "e1", processId, exitCode, tailOutput: "done",
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const send = (toolCallId: string) => tools.sendToAgentSession.execute?.(
    { message: "next task" },
    { toolCallId, messages: [], abortSignal: new AbortController().signal },
  ) as Promise<ToolResult>;
  const spawnAgent = (toolCallId: string) => tools.spawnAgentSession.execute?.(
    { prompt: "do it", agentType: "claude-code" },
    { toolCallId, messages: [], abortSignal: new AbortController().signal },
  ) as Promise<ToolResult>;
  return { manager, chatId, bus, run, send, spawnAgent, stop, settle, delivered, start, remoteStart, sendUserMessage };
}

describe("commander executor operations", () => {
  it("does not deliver a run the commander did not start while listening is off", async () => {
    const { stop, settle, delivered } = setup();
    stop("manual-process");
    await settle();
    expect(delivered).toEqual([]);
  });

  it("delivers an unlinked run only after the user opts in, marked as unable to settle a step", async () => {
    const { manager, chatId, stop, settle, delivered } = setup();
    manager.setEventListening(chatId, true);
    stop("manual-process");
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^\[Executor Event: Process Finished\]/);
    expect(delivered[0]).toMatch(/Not started by you/);
    expect(delivered[0]).not.toMatch(/Operation:/);
  });

  it("starting a run does not turn listening on, yet its own result still comes back", async () => {
    const { manager, chatId, run, stop, settle, delivered } = setup();
    const result = await run("call-1");
    expect(result).toMatchObject({ success: true, operationId: "call-1" });
    expect(manager.getEventListening(chatId)).toBe(false);

    stop("manual-process");
    stop(result.processId as string, 1);
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-1/);
    expect(delivered[0]).toMatch(/Exit Code: 1 \(failed\)/);
  });

  it("correlates a process that exits before start() returns", async () => {
    let bus: EventBus | undefined;
    const ctx = setup({
      onLocalStart: (processId) => bus?.emit({ type: "executor:stopped", projectId: "p1", executorId: "e1", processId, exitCode: 0 }),
    });
    bus = ctx.bus;
    await ctx.run("call-1");
    await ctx.settle();
    expect(ctx.delivered).toHaveLength(1);
    expect(ctx.delivered[0]).toMatch(/Operation: call-1/);
  });

  it("drops duplicate stop events", async () => {
    const { run, stop, settle, delivered } = setup();
    const result = await run("call-1");
    stop(result.processId as string);
    stop(result.processId as string);
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it("re-delivering the same call starts once; a real retry is a new operation", async () => {
    const { run, start, stop, settle, delivered } = setup();
    const [first, again] = await Promise.all([run("call-1"), run("call-1")]);
    const replay = await run("call-1");
    expect(start).toHaveBeenCalledTimes(1);
    expect(again.processId).toBe(first.processId);
    expect(replay).toMatchObject({ processId: first.processId, replayed: true });

    const retry = await run("call-2");
    expect(start).toHaveBeenCalledTimes(2);
    expect(retry.processId).not.toBe(first.processId);

    // The retry finishes first; the first run's late result is still its own.
    stop(retry.processId as string, 0);
    stop(first.processId as string, 1);
    await settle();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatch(/Operation: call-2[\s\S]*/);
    expect(delivered[0]).toMatch(/Exit Code: 0/);
    expect(delivered[1]).toMatch(/Operation: call-1/);
    expect(delivered[1]).toMatch(/Exit Code: 1/);
  });

  it("does not adopt an executor that is already running", async () => {
    const { run, start, stop, settle, delivered } = setup({ running: [{ processId: "manual-process", isRunning: true }] });
    const result = await run("call-1");
    expect(result).toMatchObject({ success: false, processId: "manual-process" });
    expect(start).not.toHaveBeenCalled();
    stop("manual-process");
    await settle();
    expect(delivered).toEqual([]);
  });

  it("replays a refusal: the same call never becomes a start once the blocker is gone", async () => {
    const running = [{ processId: "manual-process", isRunning: true }];
    const { run, start } = setup({ running });
    expect(await run("call-1")).toMatchObject({ success: false, processId: "manual-process" });
    running.length = 0;
    expect(await run("call-1")).toMatchObject({ success: false, processId: "manual-process", replayed: true });
    expect(start).not.toHaveBeenCalled();
    expect(await run("call-2")).toMatchObject({ success: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("links a run to a plan step and rejects unknown steps", async () => {
    const { manager, chatId, run, stop, settle, delivered } = setup();
    const session = manager.getSession(chatId)!;
    session.planState.apply({
      goal: "Ship", completionCriteria: ["Build passes"], requireConfirmation: false,
      steps: [{ id: "build", title: "Build", status: "pending" }],
    });
    expect(await run("call-0", { stepId: "nope" })).toMatchObject({ success: false });
    const result = await run("call-1", { stepId: "build" });
    expect(result).toMatchObject({ success: true, stepId: "build" });
    stop(result.processId as string);
    await settle();
    expect(delivered[0]).toMatch(`Plan step: build (plan ${session.planState.current!.planId})`);
    expect(delivered[0]).toMatch(/not acceptance/);
  });

  it("a conversation reset detaches its operations", async () => {
    const { manager, chatId, run, stop, settle, delivered } = setup();
    const result = await run("call-1");
    manager.resetSession(chatId);
    stop(result.processId as string);
    await settle();
    expect(delivered).toEqual([]);
  });

  describe("remote", () => {
    it("asks the worker for the identity it registered, and correlates by it", async () => {
      const { run, remoteStart, stop, settle, delivered } = setup({
        remote: true,
        remoteStart: async (request) => ({ kind: "started", processId: `remote-e1-${request.processId}` }),
      });
      const result = await run("call-1");
      const requested = remoteStart.mock.calls[0][0].processId;
      expect(requested).toBeTruthy();
      expect(result).toMatchObject({ success: true, processId: `remote-e1-${requested}` });
      stop(`remote-e1-${requested}`);
      await settle();
      expect(delivered[0]).toMatch(/Operation: call-1/);
    });

    it("follows the identity an old worker actually used", async () => {
      const { run, stop, settle, delivered } = setup({
        remote: true,
        remoteStart: async () => ({ kind: "started", processId: "remote-e1-worker-chosen" }),
      });
      await run("call-1");
      stop("remote-e1-worker-chosen");
      await settle();
      expect(delivered[0]).toMatch(/Operation: call-1/);
    });

    it("an unknown start is not success, and a later confirmation still reaches this operation", async () => {
      const { bus, run, remoteStart, stop, settle, delivered } = setup({
        remote: true,
        remoteStart: async () => ({ kind: "unknown", error: "Remote server unreachable" }),
      });
      const result = await run("call-1");
      expect(result).toMatchObject({ success: false, startUnknown: true, operationId: "call-1" });
      const processId = `remote-e1-${remoteStart.mock.calls[0][0].processId}`;
      bus.emit({ type: "executor:started", projectId: "p1", executorId: "e1", processId, target: "srv" });
      stop(processId);
      await settle();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/Operation: call-1/);
    });

    it("a new call resumes this chat's unknown start under the same identity", async () => {
      const outcomes: RemoteStartOutcome["kind"][] = ["unknown", "started"];
      const { run, remoteStart, stop, settle, delivered } = setup({
        remote: true,
        remoteStart: async (request) => outcomes.shift() === "unknown"
          ? { kind: "unknown", error: "Remote server unreachable" }
          : { kind: "started", processId: `remote-e1-${request.processId}` },
      });
      expect(await run("call-1")).toMatchObject({ startUnknown: true });
      const resumed = await run("call-2");
      const [first, second] = remoteStart.mock.calls.map(([request]) => request.processId);
      expect(second).toBe(first);
      expect(resumed).toMatchObject({ success: true, operationId: "call-2", processId: `remote-e1-${first}` });
      // The original call still answers what it saw; the process is the resumer's.
      expect(await run("call-1")).toMatchObject({ startUnknown: true, replayed: true });
      stop(`remote-e1-${first}`);
      await settle();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/Operation: call-2/);
    });

    it("does not adopt a process already running on the target", async () => {
      const { run, stop, settle, delivered } = setup({
        remote: true,
        remoteStart: async () => ({ kind: "already_running", processId: "remote-e1-manual" }),
      });
      expect(await run("call-1")).toMatchObject({ success: false, processId: "remote-e1-manual" });
      stop("remote-e1-manual");
      await settle();
      expect(delivered).toEqual([]);
    });
  });
});

describe("agent task completion provenance", () => {
  const completed = (sessionId: string, turnEndEntryIndex?: number) => ({
    type: "session:taskCompleted" as const, projectId: "p1", branch: "dev", sessionId, summaryText: "done", turnEndEntryIndex,
  });

  it("drops an agent-window task while listening is off, delivers a dispatched one", async () => {
    const { bus, send, settle, delivered } = setup({ agent: { id: "agent-1", status: "stopped", entries: 4 } });
    bus.emit(completed("agent-1", 3));
    await send("call-1");
    bus.emit(completed("agent-1", 7));
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-1/);
  });

  it("a repeated completion of the previous task does not take the next task's place", async () => {
    const { bus, send, settle, delivered } = setup({ agent: { id: "agent-1", status: "stopped", entries: 2 } });
    await send("call-1");
    bus.emit(completed("agent-1", 5));
    await send("call-2");
    bus.emit(completed("agent-1", 5));
    bus.emit(completed("agent-1", 9));
    await settle();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatch(/Operation: call-1/);
    expect(delivered[1]).toMatch(/Operation: call-2/);
  });

  it("is registered before delivery, so a completion during the send still belongs to it", async () => {
    let bus: EventBus | undefined;
    const ctx = setup({
      agent: {
        id: "agent-1", status: "stopped", entries: 2,
        send: async () => { bus?.emit(completed("agent-1", 4)); return true; },
      },
    });
    bus = ctx.bus;
    await ctx.send("call-1");
    await ctx.settle();
    expect(ctx.delivered[0]).toMatch(/Operation: call-1/);
  });

  it("a failed delivery claims nothing", async () => {
    const { bus, send, settle, delivered } = setup({
      agent: { id: "agent-1", status: "stopped", entries: 2, send: async () => false },
    });
    expect(await send("call-1")).toMatchObject({ success: false });
    bus.emit(completed("agent-1", 5));
    await settle();
    expect(delivered).toEqual([]);
  });

  it("marks an agent-window task as unlinked when the user listens", async () => {
    const { manager, chatId, bus, settle, delivered } = setup();
    manager.setEventListening(chatId, true);
    bus.emit(completed("user-agent", 3));
    await settle();
    expect(delivered[0]).toMatch(/Not started by you/);
  });
});

describe("remote agent dispatch boundary", () => {
  const completed = (turnEndEntryIndex: number) => ({
    type: "session:taskCompleted" as const, projectId: "p1", branch: "dev", sessionId: "remote-srv-p1-rs1",
    summaryText: "done", turnEndEntryIndex,
  });
  const ok = (data: unknown): ProxyResult => ({ ok: true, status: 200, data });

  it("a previous task's completion still in flight is not credited to the new dispatch", async () => {
    // The worker is idle with its last turn ending at 10; the hub has not seen that completion yet.
    proxy.handler = async (method, path) => path.endsWith("/history-head")
      ? ok({ status: "stopped", latestEntryIndex: 10, lastTurnEndEntryIndex: 10 })
      : ok({});
    const { bus, send, settle, delivered } = setup({ remoteAgent: true });
    expect(await send("call-2")).toMatchObject({ success: true });
    bus.emit(completed(10));
    bus.emit(completed(14));
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-2/);
  });

  it("falls back to the legacy detail route on workers without history-head", async () => {
    proxy.handler = async (method, path) => {
      if (path.endsWith("/history-head")) return { ok: false, status: 404, data: {} };
      if (method === "GET") {
        return ok({ session: { status: "stopped" }, messages: [
          { type: "user", content: "a", timestamp: 1 },
          { type: "assistant", content: "b", timestamp: 2 },
          { type: "turn_end", timestamp: 3 },
        ] });
      }
      return ok({});
    };
    const { bus, send, settle, delivered } = setup({ remoteAgent: true });
    expect(await send("call-2")).toMatchObject({ success: true });
    bus.emit(completed(2));
    bus.emit(completed(5));
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-2/);
  });

  it("does not send when the worker's state cannot be confirmed", async () => {
    proxy.handler = async (method) => method === "GET"
      ? { ok: false, status: 0, data: { error: "unreachable" }, errorCode: "network_error" }
      : ok({});
    const { proxyToRemoteAuto } = await import("./utils/remote-proxy.js");
    vi.mocked(proxyToRemoteAuto).mockClear();
    const { send } = setup({ remoteAgent: true });
    expect(await send("call-2")).toMatchObject({ success: false });
    expect(vi.mocked(proxyToRemoteAuto).mock.calls.some(([, method]) => method === "POST")).toBe(false);
  });
});

describe("spawn completion that outruns registration", () => {
  const completed = (sessionId: string, turnEndEntryIndex: number) => ({
    type: "session:taskCompleted" as const, projectId: "p1", branch: "dev", sessionId, summaryText: "done", turnEndEntryIndex,
  });
  const activated = { kind: "activated", view: { sessionId: "new-agent", userEntryIndex: 0 } };

  it("reaches a listening chat once, as the spawned task", async () => {
    const { manager, chatId, spawnAgent, settle, delivered } = setup({
      spawn: async (bus) => { bus.emit(completed("new-agent", 3)); return activated; },
    });
    manager.setEventListening(chatId, true);
    expect(await spawnAgent("call-1")).toMatchObject({ success: true });
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-1/);
  });

  it("two copies of the same early completion still reach a listening chat once", async () => {
    const { manager, chatId, spawnAgent, settle, delivered } = setup({
      spawn: async (bus) => {
        bus.emit(completed("new-agent", 3));
        bus.emit(completed("new-agent", 3));
        return activated;
      },
    });
    manager.setEventListening(chatId, true);
    await spawnAgent("call-1");
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Operation: call-1/);
  });

  it("two copies of an unrelated completion held during the spawn are released once", async () => {
    const { manager, chatId, spawnAgent, settle, delivered } = setup({
      spawn: async (bus) => {
        bus.emit(completed("user-agent", 3));
        bus.emit(completed("user-agent", 3));
        return activated;
      },
    });
    manager.setEventListening(chatId, true);
    await spawnAgent("call-1");
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Not started by you/);
  });

  it("an unrelated completion held during the spawn is released unlinked, once", async () => {
    const { manager, chatId, spawnAgent, settle, delivered } = setup({
      spawn: async (bus) => { bus.emit(completed("user-agent", 3)); return activated; },
    });
    manager.setEventListening(chatId, true);
    await spawnAgent("call-1");
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Not started by you/);
  });

  it("a failed spawn releases what it held", async () => {
    const { manager, chatId, spawnAgent, settle, delivered } = setup({
      spawn: async (bus) => { bus.emit(completed("new-agent", 3)); throw new Error("boom"); },
    });
    manager.setEventListening(chatId, true);
    expect(await spawnAgent("call-1")).toMatchObject({ success: false });
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/Not started by you/);
  });
});
