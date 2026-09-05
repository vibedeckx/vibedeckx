import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { CrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
import { derivedEntryMeta } from "./__fixtures__/entry-meta-mock.js";

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
  // Entries actually written per session. branchSession's exact-ID replay
  // compares the branch's stored rows against the source's, and a cold branch
  // has nowhere else to read them from.
  const entriesBySession = new Map<string, Array<{ session_id: string; entry_index: number; data: string }>>([
    [SOURCE_ID, HISTORY],
  ]);
  const getEntries = async (id: string) => entriesBySession.get(id) ?? [];
  const upsertEntry = vi.fn(async (id: string, entry_index: number, data: string) => {
    const rows = entriesBySession.get(id) ?? [];
    const at = rows.findIndex((r) => r.entry_index === entry_index);
    const next = { session_id: id, entry_index, data };
    if (at >= 0) rows[at] = next; else rows.push(next);
    entriesBySession.set(id, rows);
  });
  const checkout = {
    id: "checkout-feat", workspace_id: "workspace-feat", target_id: "local",
    worktree_path: "/tmp/p1-feat", expected_branch: "feat", status: "ready" as const,
    error: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };

  // Writes through to the created row so the idempotent-replay repair sees an
  // already-set pointer, exactly like the real repository.
  const setBranchedFrom = vi.fn(async (id: string, sourceSessionId: string, entryIndex: number | null) => {
    const row = created.find((r) => r.id === id);
    if (row) {
      row.branched_from_session_id = sourceSessionId;
      row.branched_from_entry_index = entryIndex;
    }
  });

  const storage = {
    agentSessions: {
      getAll: async () => [sourceRow],
      getById: async (id: string) => (id === SOURCE_ID ? sourceRow : created.find((r) => r.id === id) ?? null),
      getEntries,
      ...derivedEntryMeta(SOURCE_ID, getEntries),
      create: async (row: AgentSession) => { created.push({ ...sourceRow, ...row }); },
      createBound: async (row: AgentSession) => {
        const session = { ...sourceRow, ...row, workspace_checkout_id: checkout.id };
        created.push(session);
        return { session, checkout };
      },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      upsertEntry,
      updateTitle: vi.fn(async () => undefined),
      setBranchedFrom,
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

  return { storage, created, setBranchedFrom };
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

    expect(result).toMatchObject({ ok: true, sessionId: preSessionId });
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

    expect(first).toMatchObject({ ok: true, sessionId: "durable-branch" });
    expect(replay).toEqual(first);
    expect(created).toHaveLength(1);
    expect(manager.getSession("durable-branch")?.crossRemoteMcp).toEqual(freshCrossRemoteMcp);
  });
});

describe("branchSession send-back pointer", () => {
  it("records the source session and the cutoff turn_end on the branch", async () => {
    const { storage, setBranchedFrom } = makeHarness();
    const manager = new AgentSessionManager(storage);
    await manager.branchSession(SOURCE_ID, undefined, { sessionId: "sb1", upToEntryIndex: 2 });
    expect(setBranchedFrom).toHaveBeenCalledWith("sb1", SOURCE_ID, 2);
    expect(manager.getSession("sb1")?.branchedFromSessionId).toBe(SOURCE_ID);
    expect(manager.getSession("sb1")?.branchedFromEntryIndex).toBe(2);
  });

  it("records the source tail turn_end for a legacy full copy", async () => {
    const { storage, setBranchedFrom } = makeHarness();
    const manager = new AgentSessionManager(storage);
    await manager.branchSession(SOURCE_ID, undefined, { sessionId: "sb2" });
    expect(setBranchedFrom).toHaveBeenCalledWith("sb2", SOURCE_ID, 5);
  });

  it("replay backfills a missing pointer in BOTH db and runtime (crash-before-pointer window)", async () => {
    const { storage, created, setBranchedFrom } = makeHarness();
    const manager = new AgentSessionManager(storage);
    await manager.branchSession(SOURCE_ID, undefined, { sessionId: "sb3" });
    // Simulate the crash window the pointer write is ordered to leave behind:
    // entries fully copied, pointer never persisted — and the post-restart
    // runtime restored from that row carries null pointers too. (Also the
    // shape of a branch created before the pointer feature existed.)
    const row = created.find((r) => r.id === "sb3")!;
    row.branched_from_session_id = null;
    const runtime = manager.getSession("sb3")!;
    runtime.branchedFromSessionId = null;
    runtime.branchedFromEntryIndex = null;
    setBranchedFrom.mockClear();

    const replay = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "sb3" });
    expect(replay).toMatchObject({ ok: true, sessionId: "sb3" });
    expect(setBranchedFrom).toHaveBeenCalledWith("sb3", SOURCE_ID, 5);
    // Session payloads read the runtime — a DB-only repair would keep the
    // send-back button hidden for the rest of the process lifetime.
    expect(manager.getSession("sb3")?.branchedFromSessionId).toBe(SOURCE_ID);
    expect(manager.getSession("sb3")?.branchedFromEntryIndex).toBe(5);
  });
});

describe("branchSession cutoff", () => {
  it("copies exactly the prefix up to a turn_end cutoff", async () => {
    const { storage } = makeHarness();
    const manager = new AgentSessionManager(storage);
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b1", upToEntryIndex: 2 });
    expect(result).toMatchObject({ ok: true, sessionId: "b1" });
    // The branch is born cold (no process), so the copied transcript comes
    // back on the result rather than out of an in-memory store.
    const msgs = (result as { messages: unknown[] }).messages;
    expect(msgs).toHaveLength(3);
    expect((msgs[2] as { type: string }).type).toBe("turn_end");
    expect(manager.getSession("b1")?.hot).toBe(false);
    expect(manager.getSession("b1")?.historyMeta).toEqual({ entryCount: 3, maxEntryIndex: 2 });
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
    expect(result).toMatchObject({ ok: true, sessionId: "b4" });
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it("running without a cutoff is rejected (no half-turn copies)", async () => {
    const { manager } = await runningManager();
    const result = await manager.branchSession(SOURCE_ID, undefined, { sessionId: "b5" });
    expect(result).toEqual({ ok: false, reason: "running-needs-cutoff" });
  });
});
