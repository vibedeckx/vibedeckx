import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { Storage } from "./storage/types.js";

describe("commander spawnAgentSession", () => {
  it("reports failure and conditionally discards when the initial task is rejected", async () => {
    const discardSessionIfEmpty = vi.fn(async () => true);
    const agentSessionManager = {
      getSessionByBranch: vi.fn(() => null),
      createNewSession: vi.fn(async () => "new-agent"),
      sendUserMessage: vi.fn(async () => false),
      discardSessionIfEmpty,
    } as unknown as AgentSessionManager;
    const storage = {
      projects: {
        getById: vi.fn(async () => ({
          id: "p1", path: "/repo", agent_mode: "local",
        })),
      },
    } as unknown as Storage;
    const manager = new ChatSessionManager(
      storage,
      {} as ProcessManager,
      agentSessionManager,
      new Map(),
      new Map(),
      {} as RemotePatchCache,
    );
    const tools = (manager as unknown as {
      createTools: (projectId: string, branch: string | null, sessionId?: string) => Record<string, {
        execute?: (input: unknown, options: unknown) => Promise<unknown>;
      }>;
    }).createTools("p1", "dev", "chat-1");

    const result = await tools.spawnAgentSession.execute?.(
      { prompt: "Implement the change", agentType: "claude-code" },
      { toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal },
    ) as { success: boolean; agentSessionId?: string };

    expect(result.success).toBe(false);
    expect(result.agentSessionId).toBeUndefined();
    expect(discardSessionIfEmpty).toHaveBeenCalledWith("new-agent");
  });
});
