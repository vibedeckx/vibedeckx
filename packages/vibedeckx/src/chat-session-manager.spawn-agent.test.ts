import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSessionLifecycleService, SessionLifecycleView } from "./agent-session-lifecycle.js";
import type { RemoteSessionLifecycleAdapter } from "./remote-session-lifecycle.js";
import type { ProcessManager } from "./process-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { Storage } from "./storage/types.js";

/**
 * Commander `spawnAgentSession` (design §10.2): one lifecycle `start` under
 * the tool call's key; success only for a confirmed activation; no
 * create-then-send compensation of its own.
 */
describe("commander spawnAgentSession", () => {
  const view = (over: Partial<SessionLifecycleView> = {}): SessionLifecycleView => ({
    sessionId: "new-agent", projectId: "p1", branch: "dev", state: "active", purpose: "commander",
    leaseHeld: false, activationKey: "call-1", activationAttempt: 1, activatedAt: 1, activationErrorCode: null,
    userEntryIndex: 0, expiredReason: null, expiredAt: null, pendingExpiresAt: null, ...over,
  });

  function makeTools(startResult: unknown, opts: {
    agentMode?: string;
    /** A session already occupying the branch slot, and the prepare key its row carries. */
    branchSession?: { id: string; prepareOperationId: string | null; dormant?: boolean };
  } = {}) {
    const start = vi.fn(async () => startResult);
    const deleteSession = vi.fn(async () => true);
    const agentSessionManager = {
      getSessionByBranch: vi.fn(() => (opts.branchSession
        ? { id: opts.branchSession.id, dormant: opts.branchSession.dormant ?? true }
        : null)),
      deleteSession,
    } as unknown as AgentSessionManager;
    const storage = {
      projects: {
        getById: vi.fn(async () => ({
          id: "p1", path: "/repo", agent_mode: opts.agentMode ?? "local",
        })),
      },
      projectRemotes: {
        getByProjectAndServer: vi.fn(async () => ({ remote_path: "/remote/repo" })),
      },
      agentSessions: {
        getLifecycleById: vi.fn(async () => (opts.branchSession
          ? { id: opts.branchSession.id, prepare_operation_id: opts.branchSession.prepareOperationId }
          : undefined)),
      },
      remoteSessionMappings: { delete: vi.fn(async () => {}) },
    } as unknown as Storage;
    const manager = new ChatSessionManager(
      storage,
      {} as ProcessManager,
      agentSessionManager,
      new Map(),
      new Map(),
      {} as RemotePatchCache,
    );
    manager.setSessionLifecycle(
      { start } as unknown as AgentSessionLifecycleService,
      { start } as unknown as RemoteSessionLifecycleAdapter,
    );
    const tools = (manager as unknown as {
      createTools: (projectId: string, branch: string | null, sessionId?: string) => Record<string, {
        execute?: (input: unknown, options: unknown) => Promise<unknown>;
      }>;
    }).createTools("p1", "dev", "chat-1");
    const run = async () => tools.spawnAgentSession.execute?.(
      { prompt: "Implement the change", agentType: "claude-code" },
      { toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal },
    ) as Promise<{ success: boolean; agentSessionId?: string; message: string }>;
    return { start, run, agentSessionManager, deleteSession };
  }

  it("starts under the tool call's key and reports success only once activated", async () => {
    const { start, run } = makeTools({ kind: "activated", view: view() });
    const result = await run();
    expect(result).toMatchObject({ success: true, agentSessionId: "new-agent" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "call-1", projectId: "p1", branch: "dev", permissionMode: "edit", agentType: "claude-code",
      purpose: "commander", owner: { kind: "commander_request", id: "chat-1" },
      instruction: "Implement the change", announceRunning: true,
    }));
  });

  it("reports failure without a session id when the first instruction is rejected", async () => {
    const { run } = makeTools({ kind: "retryable_failure", view: view({ state: "pending_first_turn" }), errorCode: "provider_rejected" });
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.agentSessionId).toBeUndefined();
    expect(result.message).toMatch(/did not accept its initial task/);
  });

  it("never claims success for an uncertain delivery, but names the session to inspect", async () => {
    const { run } = makeTools({ kind: "uncertain", view: view({ state: "activation_uncertain" }) });
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.agentSessionId).toBe("new-agent");
    expect(result.message).toMatch(/could not be confirmed/);
  });

  it("surfaces the resident limit instead of a generic failure", async () => {
    const { run } = makeTools({
      kind: "resident_limit", view: view({ state: "pending_first_turn" }),
      error: { message: "Resident agent process limit reached (2/2)." },
    });
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/limit reached \(2\/2\)/);
  });

  it("restart replay: a dormant session owned by this tool call is the idempotency anchor and is NOT deleted", async () => {
    // After a restart, the session the original call created is restored
    // dormant. Deleting it would destroy the prepare_operation_id anchor, so
    // the replayed toolCallId would create and prompt a second session.
    const { start, run, deleteSession } = makeTools(
      { kind: "replayed", view: view() },
      { branchSession: { id: "s-original", prepareOperationId: "call-1" } },
    );
    const result = await run();
    expect(result).toMatchObject({ success: true, agentSessionId: "new-agent" });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "call-1" }));
  });

  it("live replay: a RUNNING session owned by this tool call replays instead of 'already active'", async () => {
    // The original call succeeded but its response was lost; the retry with
    // the same toolCallId must reach lifecycle.start (which returns
    // `replayed`), not be rejected by the generic busy check.
    const { start, run, deleteSession } = makeTools(
      { kind: "replayed", view: view() },
      { branchSession: { id: "s-live", prepareOperationId: "call-1", dormant: false } },
    );
    const result = await run();
    expect(result).toMatchObject({ success: true, agentSessionId: "new-agent" });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "call-1" }));
  });

  it("a RUNNING session from some other origin still gets the busy rejection", async () => {
    const { start, run, deleteSession } = makeTools(
      { kind: "activated", view: view() },
      { branchSession: { id: "s-busy", prepareOperationId: "some-other-op", dormant: false } },
    );
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already has an active coding agent/);
    expect(start).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("a dormant session from some other origin is removed before starting fresh", async () => {
    const { run, deleteSession } = makeTools(
      { kind: "activated", view: view() },
      { branchSession: { id: "s-stale", prepareOperationId: "some-other-op" } },
    );
    const result = await run();
    expect(result.success).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith("s-stale");
  });

  it("routes a remote workspace through the hub adapter with the association's path", async () => {
    const { start, run } = makeTools({ kind: "activated", view: view({ sessionId: "remote-srv-p1-x", remoteSessionId: "x" }) }, { agentMode: "srv" });
    const result = await run();
    expect(result).toMatchObject({ success: true, agentSessionId: "remote-srv-p1-x" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "call-1", remoteServerId: "srv", remotePath: "/remote/repo", purpose: "commander",
      owner: { kind: "commander_request", id: "chat-1" }, instruction: "Implement the change",
    }));
  });
});
