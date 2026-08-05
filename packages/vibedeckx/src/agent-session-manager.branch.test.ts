import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { CrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";

/**
 * branchSession must carry a cross-remote MCP config onto the branched
 * RunningSession, exactly like createNewSession does — otherwise the dormant
 * branch wakes and spawns its agent process with no --mcp-config, and the
 * cross-remote gateway silently never appears (unlike New Conversation).
 */

const SOURCE_ID = "source-session";

const HISTORY = [
  { session_id: SOURCE_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "hello", timestamp: 1 }) },
  { session_id: SOURCE_ID, entry_index: 1, data: JSON.stringify({ type: "assistant", content: "hi", timestamp: 2 }) },
  { session_id: SOURCE_ID, entry_index: 2, data: JSON.stringify({ type: "turn_end", timestamp: 3, durationMs: 2, outcome: "completed" }) },
  { session_id: SOURCE_ID, entry_index: 3, data: JSON.stringify({ type: "user", content: "more", timestamp: 4 }) },
  { session_id: SOURCE_ID, entry_index: 4, data: JSON.stringify({ type: "assistant", content: "again", timestamp: 5 }) },
  { session_id: SOURCE_ID, entry_index: 5, data: JSON.stringify({ type: "turn_end", timestamp: 6, durationMs: 2, outcome: "completed" }) },
];

function makeHarness() {
  const sourceRow: AgentSession = {
    id: SOURCE_ID,
    project_id: "p1",
    branch: "feat",
    workspace_checkout_id: "checkout-feat",
    status: "stopped",
    permission_mode: "edit",
    agent_type: "claude-code",
    title: "Original",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1,
    last_completed_at: null,
  };

  const created: AgentSession[] = [];
  const checkout = {
    id: "checkout-feat", workspace_id: "workspace-feat", target_id: "local",
    worktree_path: "/tmp/p1-feat", expected_branch: "feat", status: "ready" as const,
    error: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };

  const storage = {
    agentSessions: {
      getAll: async () => [sourceRow],
      getById: async (id: string) => (id === SOURCE_ID ? sourceRow : created.find((r) => r.id === id) ?? null),
      getEntries: async () => HISTORY,
      create: async (row: AgentSession) => { created.push({ ...sourceRow, ...row }); },
      createBound: async (row: AgentSession) => {
        const session = { ...sourceRow, ...row, workspace_checkout_id: checkout.id };
        created.push(session);
        return { session, checkout };
      },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => created,
    },
    workspaceRegistry: {
      getCheckoutById: async () => ({
        workspace: { id: "workspace-feat", project_id: "p1", branch: "feat", status: "ready", error: null,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        checkout,
      }),
    },
  } as unknown as Storage;

  return { storage, created };
}

describe("branchSession cross-remote MCP", () => {
  it("stores the provided crossRemoteMcp config on the branched session", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);

    const crossRemoteMcp: CrossRemoteMcpConfig = {
      url: "https://app.example.com/api/cross-remote/mcp",
      token: "signed.token",
    };
    const preSessionId = "branch-session-id";

    const result = await manager.branchSession(SOURCE_ID, undefined, {
      sessionId: preSessionId,
      crossRemoteMcp,
    });

    expect(result).toEqual({ ok: true, sessionId: preSessionId });
    expect(manager.getSession(preSessionId)?.crossRemoteMcp).toEqual(crossRemoteMcp);
  });

  it("replays an exact preallocated branch identity without copying it twice", async () => {
    const { storage, created } = makeHarness();
    const manager = new AgentSessionManager(storage);

    const first = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "durable-branch" });
    const freshCrossRemoteMcp = { url: "https://new.example.test/mcp", token: "fresh-token" };
    const replay = await manager.branchSession(SOURCE_ID, undefined, {
      sessionId: "durable-branch", crossRemoteMcp: freshCrossRemoteMcp,
    });

    expect(first).toEqual({ ok: true, sessionId: "durable-branch" });
    expect(replay).toEqual(first);
    expect(created).toHaveLength(1);
    expect(manager.getSession("durable-branch")?.crossRemoteMcp).toEqual(freshCrossRemoteMcp);
  });
});

describe("branchSession cutoff", () => {
  it("copies exactly the prefix up to a turn_end cutoff", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b1", upToEntryIndex: 2 });
    expect(result).toEqual({ ok: true, sessionId: "b1" });
    const msgs = manager.getMessages("b1");
    expect(msgs.filter(Boolean)).toHaveLength(3);
    expect(msgs[2]?.type).toBe("turn_end");
    expect(msgs[3]).toBeUndefined();
  });

  it("rejects a cutoff that is not a turn_end entry", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b2", upToEntryIndex: 1 });
    expect(result).toEqual({ ok: false, reason: "invalid-cutoff" });
  });

  it("rejects a missing cutoff index", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b3", upToEntryIndex: 99 });
    expect(result).toEqual({ ok: false, reason: "invalid-cutoff" });
  });
});

describe("branchSession while running", () => {
  async function runningManager() {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    const internals = manager as unknown as {
      sessions: Map<string, { status: string; dormant: boolean }>;
      finalizeStreamingEntry: (s: unknown) => Promise<void>;
    };
    const s = internals.sessions.get(SOURCE_ID)!;
    s.status = "running";
    s.dormant = false;
    return { manager, internals };
  }

  it("historical branch with cutoff works while running and never touches the source", async () => {
    const { manager, internals } = await runningManager();
    const finalizeSpy = vi.spyOn(internals as never, "finalizeStreamingEntry" as never);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b4", upToEntryIndex: 2 });
    expect(result).toEqual({ ok: true, sessionId: "b4" });
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it("running without a cutoff is rejected (no half-turn copies)", async () => {
    const { manager } = await runningManager();
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b5" });
    expect(result).toEqual({ ok: false, reason: "running-needs-cutoff" });
  });
});
