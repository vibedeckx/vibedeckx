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
 * The plan drives the commander: a turn that ends with steps still owed and
 * nothing in flight is re-driven, a run in flight ends the turn and silences
 * the watchdog, and a model that only talks is eventually declared stalled.
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

function currentPlan(options: CallOptions): ChatPlan | null {
  const system = options.prompt.find((message) => message.role === "system");
  const json = system?.content.match(/<current-plan>\n(.*?)\n<\/current-plan>/s)?.[1];
  return json ? JSON.parse(json) : null;
}

describe("plan continuation watchdog", () => {
  it("re-drives a plan the model left idle, then declares it stalled and notifies", async () => {
    let phase = 0;
    const { manager, id, idle, continuations, outboxInsert, milestones, emitBranchActivityIfChanged } = setup(async () => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        // Four text-only turns in a row: three nudges, then the watchdog gives up.
        case 1: case 2: case 3: case 4: return text("Now I'll start the build.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await vi.waitFor(() => expect(manager.getSession(id)!.planState.stalled).toBe(true));
    await idle();

    expect(phase).toBe(5);
    expect(continuations()).toHaveLength(3);
    expect(continuations()[0]).toContain("build: Run the build (pending)");
    const stalled = manager.getMessages(id).find((m) => m.type === "system");
    expect(stalled?.type).toBe("system");
    if (stalled?.type === "system") expect(stalled.content).toMatch(/^\[Plan Stalled\] .*Run the build/);
    expect(outboxInsert).toHaveBeenCalledTimes(1);
    expect(outboxInsert.mock.calls[0][0]).toMatchObject({ kind: "commander_stalled", project_id: "p1", branch: "dev", session_id: id });
    expect(milestones).toHaveBeenCalledTimes(1);
    expect(emitBranchActivityIfChanged).toHaveBeenLastCalledWith("p1", "dev", expect.objectContaining({ activity: "stopped" }));
    expect(manager.getMessages(id).filter((m) => m.type === "error")).toEqual([]);
  });

  it("a stalled plan is quiet until the user speaks, which restores the budget", async () => {
    let phase = 0;
    const { manager, id, idle, continuations } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: case 2: case 3: case 4: return text("Thinking.");
        // After the user's nudge: one more idle turn earns a fresh nudge, then
        // the model parks the plan on a question and the watchdog stays quiet.
        case 5: return text("Still thinking.");
        case 6: {
          const plan = currentPlan(options)!;
          return call("ask", "setPlan", { ...plan, waitingOn: "Which target?" });
        }
        case 7: return text("Which target should I build?");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await vi.waitFor(() => expect(manager.getSession(id)!.planState.stalled).toBe(true));
    await idle();
    expect(continuations()).toHaveLength(3);
    expect(phase).toBe(5);

    await manager.sendMessage(id, "Go on");
    expect(manager.getSession(id)!.planState.stalled).toBe(false);
    await vi.waitFor(() => expect(phase).toBe(8));
    await idle();
    expect(continuations()).toHaveLength(4);
    expect(manager.getSession(id)!.planState.current?.waitingOn).toBe("Which target?");
    expect(manager.getSession(id)!.planState.stalled).toBe(false);
  });

  it("ends the turn once a run is in flight and stays quiet until its event arrives", async () => {
    let phase = 0;
    let processId = "";
    const { manager, id, idle, continuations, stop, start } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: {
          const plan = currentPlan(options) ?? manager.getSession(id)!.planState.current!;
          return call("run", "runExecutor", { executorName: "build", stepId: plan.steps[0].id });
        }
        // Only the Process Finished event may open the next turn.
        case 2: {
          expect(JSON.stringify(options.prompt)).toContain("[Executor Event: Process Finished]");
          expect(JSON.stringify(options.prompt)).toContain("Plan step: build");
          const plan = currentPlan(options)!;
          return call("done", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Exit code 0" }] });
        }
        case 3: return call("finish", "complete_task", { summary: "Built" });
        case 4: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    expect(phase).toBe(2);
    expect(start).toHaveBeenCalledTimes(1);
    processId = start.mock.calls[0][3];
    expect(continuations()).toEqual([]);
    expect(manager.getSession(id)!.planState.nudges).toBe(0);

    stop(processId);
    await vi.waitFor(() => expect(manager.getSession(id)!.taskCompleted).toBe(true));
    await idle();
    expect(continuations()).toEqual([]);
    expect(manager.getSession(id)!.planState.current).toBeNull();
  });

  it("refuses to complete a step whose run has not finished", async () => {
    let phase = 0;
    let refusal: string | undefined;
    const { manager, id, idle, stop, start } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        case 2: {
          const plan = currentPlan(options)!;
          return call("too-early", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Surely fine" }] });
        }
        case 3: {
          refusal = JSON.stringify(options.prompt);
          return text("I will wait for the event.");
        }
        // Once the run has finished, the same update goes through.
        case 4: {
          const plan = currentPlan(options)!;
          return call("now", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Exit code 0" }] });
        }
        case 5: return call("finish", "complete_task", { summary: "Built" });
        case 6: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await idle();
    // Any wake-up the model gets (here: a user message) is still before the run finished.
    await manager.sendMessage(id, "Is it done?");
    await idle();
    expect(refusal).toContain("cannot be completed yet");
    expect(manager.getSession(id)!.planState.current?.steps[0].status).toBe("pending");

    stop(start.mock.calls[0][3]);
    await vi.waitFor(() => expect(manager.getSession(id)!.taskCompleted).toBe(true));
    await idle();
    expect(phase).toBe(7);
  });

  it("continues after the step limit cut off a lookup result, carrying that result along", async () => {
    let phase = 0;
    let continuation: string | undefined;
    const { manager, id, idle, continuations } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: case 2: case 3: case 4: case 5: return call(`look-${phase}`, "getExecutorStatus", { tailLines: 5 });
        case 6: {
          continuation = JSON.stringify(options.prompt);
          const plan = currentPlan(options)!;
          return call("wait", "setPlan", { ...plan, waitingOn: "Should I retry the build?" });
        }
        case 7: return text("Should I retry the build?");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await vi.waitFor(() => expect(phase).toBe(8));
    await idle();
    expect(continuations()).toHaveLength(1);
    expect(continuations()[0]).toContain("6-step limit");
    expect(continuations()[0]).toContain("getExecutorStatus:");
    expect(continuations()[0]).toContain("observedAt");
    expect(continuation).toContain("[Plan Continuation]");
  });

  it("re-drives the plan after the model stream itself fails", async () => {
    let phase = 0;
    let continuation: string | undefined;
    const { manager, id, idle, continuations } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: throw new Error("rate limited");
        case 2: {
          continuation = JSON.stringify(options.prompt);
          const plan = currentPlan(options)!;
          return call("wait", "setPlan", { ...plan, waitingOn: "The model API failed; retry?" });
        }
        case 3: return text("The model API failed; retry?");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Build it");
    await vi.waitFor(() => expect(phase).toBe(4));
    await idle();
    expect(continuations()).toHaveLength(1);
    expect(continuations()[0]).toMatch(/ended with an error: .*rate limited/);
    expect(continuation).toContain("[Plan Continuation]");
    expect(manager.getMessages(id).filter((m) => m.type === "error")).toHaveLength(1);
  });

  it("does not touch sessions without a plan", async () => {
    let phase = 0;
    const { manager, id, idle, continuations } = setup(async () => {
      switch (phase++) {
        case 0: return call("status", "getExecutorStatus", { tailLines: 5 });
        case 1: return text("The build is idle.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "What is running?");
    await idle();
    expect(continuations()).toEqual([]);
    expect(phase).toBe(2);
  });
});

describe("in-flight reconciliation", () => {
  it("settles a run whose finish event never arrived from the process record", async () => {
    let phase = 0;
    const { manager, id, idle, userMessages, start } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        case 2: {
          const plan = currentPlan(options)!;
          return call("done", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Exit code 0" }] });
        }
        case 3: return call("finish", "complete_task", { summary: "Built" });
        case 4: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    }, { running: false, lastRow: { status: "completed", exit_code: 0, started_at: "2026-01-01 00:00:00", finished_at: "2026-01-01 00:00:05" } });
    await manager.sendMessage(id, "Build it");
    await idle();
    expect(start).toHaveBeenCalledTimes(1);

    // Too young: the started event may still be on its way.
    await manager.reconcileInFlight(Date.now());
    expect(userMessages().some((content) => content.startsWith("[Executor Event"))).toBe(false);

    await manager.reconcileInFlight(Date.now() + 60_000);
    await vi.waitFor(() => expect(userMessages().some((content) => content.startsWith("[Executor Event: Process Finished]"))).toBe(true));
    const event = userMessages().find((content) => content.startsWith("[Executor Event: Process Finished]"))!;
    expect(event).toContain("Exit Code: 0 (success)");
    expect(event).toContain("Reconciled: the finish event was not observed");
    expect(event).toContain("Plan step: build");
    await idle();
    // Settled once: a second pass finds nothing in flight.
    await manager.reconcileInFlight(Date.now() + 120_000);
    expect(userMessages().filter((content) => content.startsWith("[Executor Event")).length).toBe(1);
  });

  it("reports an unconfirmed start once, keeps its identity, and lets the plan be re-driven", async () => {
    let phase = 0;
    const { manager, id, idle, userMessages, continuations } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        // Woken by the unconfirmed report; the model only talks, so the plan
        // watchdog — no longer silenced by that start — re-drives it.
        case 2: return text("Hmm.");
        case 3: {
          expect(JSON.stringify(options.prompt)).toContain("[Plan Continuation]");
          const plan = currentPlan(options)!;
          return call("ask", "setPlan", { ...plan, waitingOn: "The build start is unconfirmed; check the worker?" });
        }
        case 4: return text("Please check the worker.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    }, { running: false });
    // The worker never answered the start: outcome unknown, identity kept.
    const internal = manager as unknown as { operations: { allInFlight(): Array<{ id: string; status: string; unconfirmedReportedAt?: number }> } };
    await manager.sendMessage(id, "Build it");
    await idle();
    const operation = internal.operations.allInFlight()[0];
    expect(operation.status).toBe("started");
    (operation as { status: string }).status = "start_unknown";

    await manager.reconcileInFlight(Date.now() + 60_000);
    expect(userMessages().some((content) => content.startsWith("[Executor Event: Start Unconfirmed]"))).toBe(false);
    await manager.reconcileInFlight(Date.now() + 11 * 60_000);
    const report = userMessages().find((content) => content.startsWith("[Executor Event: Start Unconfirmed]"));
    expect(report).toContain("Plan step: build");
    expect(report).toContain("may have run and already exited");
    expect(report).not.toContain("not started:");
    // Never settled: a runExecutor retry can still resume this exact start.
    expect(internal.operations.allInFlight().map((entry) => entry.status)).toEqual(["start_unknown"]);
    await vi.waitFor(() => expect(phase).toBe(5));
    await idle();
    expect(continuations()).toHaveLength(1);
    // Reported once only.
    await manager.reconcileInFlight(Date.now() + 30 * 60_000);
    expect(userMessages().filter((content) => content.startsWith("[Executor Event: Start Unconfirmed]"))).toHaveLength(1);
    expect(manager.getMessages(id).filter((m) => m.type === "error")).toEqual([]);
  });

  it("a start confirmed after the unconfirmed report counts as in flight again", async () => {
    let phase = 0;
    let processId = "";
    const liveness = { running: false };
    const { manager, id, bus, idle, userMessages, continuations, stop } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        // Woken by the unconfirmed report; the worker reconnects meanwhile and
        // confirms the start. The run is alive, so the turn may end on talk.
        case 2: {
          liveness.running = true;
          bus.emit({ type: "executor:started", projectId: "p1", executorId: "e1", processId });
          return text("The build is running after all.");
        }
        case 3: {
          const plan = currentPlan(options)!;
          return call("done", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Exit code 0" }] });
        }
        case 4: return call("finish", "complete_task", { summary: "Built" });
        case 5: return text("Built.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    }, liveness);
    const internal = manager as unknown as { operations: { allInFlight(): Array<{ processId: string; status: string; unconfirmedReportedAt?: number }> } };
    await manager.sendMessage(id, "Build it");
    await idle();
    const operation = internal.operations.allInFlight()[0];
    processId = operation.processId;
    (operation as { status: string }).status = "start_unknown";

    await manager.reconcileInFlight(Date.now() + 11 * 60_000);
    expect(userMessages().some((content) => content.startsWith("[Executor Event: Start Unconfirmed]"))).toBe(true);
    await vi.waitFor(() => expect(phase).toBe(3));
    await idle();
    expect(operation.status).toBe("started");
    expect(operation.unconfirmedReportedAt).toBeUndefined();
    expect(continuations()).toEqual([]);
    expect(manager.getSession(id)!.planState.stalled).toBe(false);

    stop(processId);
    await vi.waitFor(() => expect(manager.getSession(id)!.taskCompleted).toBe(true));
    await idle();
    expect(continuations()).toEqual([]);
    expect(manager.getMessages(id).filter((m) => m.type === "error")).toEqual([]);
  });

  it("drops the error re-drive when the user's reply parked the plan on a question", async () => {
    let phase = 0;
    const { manager, id, idle, continuations } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: throw new Error("rate limited");
        // The user's reply arrives during the backoff.
        case 2: {
          const plan = currentPlan(options)!;
          return call("ask", "setPlan", { ...plan, waitingOn: "Which target?" });
        }
        case 3: return text("Which target?");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    manager.stallRetryDelayMs = 200;
    await manager.sendMessage(id, "Build it");
    await idle();
    expect(continuations()).toEqual([]);
    await manager.sendMessage(id, "Actually, hold on");
    await idle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(continuations()).toEqual([]);
    expect(phase).toBe(4);
    expect(manager.getSession(id)!.planState.current?.waitingOn).toBe("Which target?");
  });

  it("drops the error re-drive when work started meanwhile, and re-checks before sending otherwise", async () => {
    let phase = 0;
    const { manager, id, idle, continuations, start } = setup(async () => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: throw new Error("rate limited");
        case 2: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    manager.stallRetryDelayMs = 200;
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.sendMessage(id, "Go");
    await idle();
    expect(start).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    // A run is in flight: no stale "nothing is running, act now" message.
    expect(continuations()).toEqual([]);
    expect(phase).toBe(3);
  });

  it("leaves a run alone while its process is still alive", async () => {
    let phase = 0;
    const { manager, id, idle, userMessages } = setup(async () => {
      switch (phase++) {
        case 0: return call("plan", "setPlan", explicitPlan());
        case 1: return call("run", "runExecutor", { executorName: "build", stepId: "build" });
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    }, { running: true });
    await manager.sendMessage(id, "Build it");
    await idle();
    await manager.reconcileInFlight(Date.now() + 60_000);
    expect(userMessages().some((content) => content.startsWith("[Executor Event"))).toBe(false);
  });
});
