import { describe, expect, it, vi } from "vitest";
import { ChatPlanState, chatPlanSchema, type ChatPlanInput } from "./chat-plan.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { Storage } from "./storage/types.js";
import type { ProcessManager } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";

const input = (): ChatPlanInput => chatPlanSchema.parse({
  goal: "Verify the change", completionCriteria: ["Tests pass"],
  steps: [{ id: "test", title: "Run tests" }],
});

describe("Commander task plans", () => {
  it("requires confirmation for broad goals and allows progress updates after approval", () => {
    const state = new ChatPlanState();
    expect(state.needsConfirmation(input())).toBe(true);
    expect(state.blocked).toBe(true);
    const plan = state.apply(input());
    expect(state.blocked).toBe(false);
    expect(state.needsConfirmation({ ...plan, steps: [{ ...plan.steps[0], status: "completed", result: "Exit code 0" }] })).toBe(false);
    expect(state.needsConfirmation({ ...plan, goal: "Also deploy it", requireConfirmation: false })).toBe(true);
    expect(state.blocked).toBe(true);
  });

  it("does not let an unconfirmed plan bypass confirmation using a new explicit plan", () => {
    const state = new ChatPlanState();
    state.needsConfirmation(input());
    expect(state.needsConfirmation({ ...input(), requireConfirmation: false })).toBe(true);
    expect(state.blocked).toBe(true);
  });

  it("allows explicit instructions and keeps independent task IDs", () => {
    const state = new ChatPlanState();
    expect(state.needsConfirmation({ ...input(), requireConfirmation: false })).toBe(false);
    const first = state.apply(input());
    const second = state.apply(input());
    expect(second.planId).not.toBe(first.planId);
    expect(state.needsConfirmation(first)).toBe(false);
    expect(state.current).toEqual(second);
    expect(chatPlanSchema.safeParse({ ...input(), steps: [input().steps[0], input().steps[0]] }).success).toBe(false);
  });

  it("blocks execution tools before plan approval without calling the executor", async () => {
    const getWorkspaceByProjectBranch = vi.fn();
    const manager = new ChatSessionManager(
      { workspaceRegistry: { getWorkspaceByProjectBranch } } as unknown as Storage,
      {} as ProcessManager, {} as AgentSessionManager,
      new Map(), new Map(), {} as RemotePatchCache,
    );
    const planState = new ChatPlanState();
    const internal = manager as unknown as {
      sessions: Map<string, unknown>;
      createTools: (projectId: string, branch: string, sessionId: string) => Record<string, {
        needsApproval?: (input: ChatPlanInput, options: unknown) => boolean;
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      }>;
    };
    internal.sessions.set("chat", { planState });
    const tools = internal.createTools("project", "dev", "chat");
    const options = { toolCallId: "call", messages: [] };
    expect(tools.setPlan.needsApproval?.(input(), options)).toBe(true);
    expect(await tools.runExecutor.execute({ executorName: "test" }, options)).toMatchObject({ success: false });
    expect(getWorkspaceByProjectBranch).not.toHaveBeenCalled();
    const unknown = { ...input(), planId: "invented-id" };
    expect(tools.setPlan.needsApproval?.(unknown, options)).toBe(false);
    expect(await tools.setPlan.execute(unknown, options)).toMatchObject({ success: false, message: expect.stringContaining("Unknown plan ID") });
    expect(planState.blocked).toBe(true);
    expect(await tools.setPlan.execute(input(), options)).toMatchObject({ success: true, plan: { goal: "Verify the change" } });
    await tools.runExecutor.execute({ executorName: "test" }, options);
    expect(getWorkspaceByProjectBranch).toHaveBeenCalledOnce();
  });
});
