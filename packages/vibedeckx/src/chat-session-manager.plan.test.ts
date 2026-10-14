import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { chatPlanSchema, type ChatPlan } from "./chat-plan.js";
import { resolveChatModel } from "./utils/chat-model.js";
import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";

vi.mock("./utils/chat-model.js", () => ({ resolveChatModel: vi.fn() }));

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
const draft = () => chatPlanSchema.parse({
  goal: "Verify the change", completionCriteria: ["Tests pass"],
  steps: [{ id: "test", title: "Run tests" }],
});

function setup(doStream: MockLanguageModelV3["doStream"]) {
  const model = new MockLanguageModelV3({ doStream });
  vi.mocked(resolveChatModel).mockResolvedValue(model);
  const manager = new ChatSessionManager(
    {} as Storage, {} as ProcessManager,
    {
      emitBranchActivityIfChanged: vi.fn(),
      getCurrentBranchActivity: vi.fn(() => "main-running"),
    } as unknown as AgentSessionManager,
    new Map(), new Map(), {} as RemotePatchCache,
  );
  vi.spyOn(manager as unknown as { getSystemPrompt: () => Promise<string> }, "getSystemPrompt").mockResolvedValue("Commander");
  const id = manager.getOrCreateSession("project", "dev", "user");
  return { manager, id, model };
}

function currentPlan(options: CallOptions): ChatPlan | null {
  const system = options.prompt.find((message) => message.role === "system");
  const json = system?.content.match(/<current-plan>\n(.*?)\n<\/current-plan>/s)?.[1];
  return json ? JSON.parse(json) : null;
}

describe("Commander plans across real SDK turns", () => {
  it("keeps an approved plan in later user and event turns, then clears it after completion", async () => {
    let phase = 0;
    let approvedId = "";
    const seen: ChatPlan[] = [];
    const { manager, id } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("create", "setPlan", draft());
        case 1: {
          // The approval-resume pass receives the executed setPlan result.
          const plan = manager.getSession(id)!.planState.current!;
          approvedId = plan.planId;
          return call("progress", "setPlan", { ...plan, steps: [{ ...plan.steps[0], status: "in_progress" }] });
        }
        case 2: return text("Tests are running.");
        case 3: {
          const plan = currentPlan(options)!;
          seen.push(plan);
          return call("still-running", "setPlan", plan);
        }
        case 4: return text("Waiting for the test result.");
        case 5: {
          const plan = currentPlan(options)!;
          seen.push(plan);
          return call("finish-step", "setPlan", {
            ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Test process exited with code 0" }],
          });
        }
        case 6: return call("finish-task", "complete_task", { summary: "Tests passed" });
        case 7: return text("Tests passed.");
        case 8:
          expect(currentPlan(options)).toBeNull();
          return call("unrelated", "complete_task", { summary: "Answered the question" });
        case 9: return text("Here is the answer.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });

    await manager.sendMessage(id, "Verify the change");
    const approval = manager.getMessages(id).find((message) => message.type === "tool_approval_request");
    expect(approval?.type).toBe("tool_approval_request");
    if (approval?.type !== "tool_approval_request") throw new Error("Missing approval");
    expect(manager.resolveToolApproval(id, approval.approvalId, true)).toBe(true);
    await vi.waitFor(() => expect(manager.getSession(id)!.abortController).toBeNull());
    expect(manager.getSession(id)!.planState.current?.steps[0].status).toBe("in_progress");

    await manager.sendMessage(id, "How is the task progressing?");
    await manager.sendMessage(id, "[Agent Event: Task Completed]\nTests exited with code 0");
    expect(seen).toHaveLength(2);
    for (const snapshot of seen) {
      expect(snapshot.planId).toBe(approvedId);
      expect(snapshot.steps[0]).toMatchObject({ id: "test", status: "in_progress" });
      expect(snapshot.completionCriteria).toEqual(["Tests pass"]);
    }
    expect(manager.getMessages(id).filter((message) => message.type === "tool_approval_request")).toHaveLength(1);
    expect(manager.getSession(id)!.taskCompleted).toBe(true);
    expect(manager.getSession(id)!.planState.current).toBeNull();
    await manager.sendMessage(id, "An unrelated question");
    expect(manager.getSession(id)!.taskCompleted).toBe(true);
    expect(manager.getMessages(id).filter((message) => message.type === "error")).toEqual([]);
    const completions = manager.getMessages(id).filter((message) => message.type === "tool_result" && message.tool === "complete_task");
    expect(completions).toHaveLength(2);
    for (const message of completions) {
      if (message.type === "tool_result") expect(JSON.parse(message.output).completed).toBe(true);
    }
  });

  it("returns an unknown ID as a visible tool result and lets the model recover in the same turn", async () => {
    let phase = 0;
    const { manager, id } = setup(async (options) => {
      switch (phase++) {
        case 0: return call("bad-id", "setPlan", { ...draft(), planId: "plan-1" });
        case 1:
          expect(JSON.stringify(options.prompt)).toContain("Unknown plan ID");
          return call("corrected", "setPlan", { ...draft(), requireConfirmation: false });
        case 2: return text("Plan created.");
        default: throw new Error(`Unexpected model call ${phase}`);
      }
    });
    await manager.sendMessage(id, "Run the tests");
    const result = manager.getMessages(id).find((message) => message.type === "tool_result" && message.toolUseId === "bad-id");
    expect(result?.type).toBe("tool_result");
    if (result?.type === "tool_result") expect(JSON.parse(result.output)).toMatchObject({ success: false, message: expect.stringContaining("Unknown plan ID") });
    expect(manager.getSession(id)!.planState.current?.goal).toBe("Verify the change");
    expect(manager.getSession(id)!.abortController).toBeNull();
    expect(manager.getMessages(id).filter((message) => message.type === "tool_approval_request" || message.type === "error")).toEqual([]);
  });
});
