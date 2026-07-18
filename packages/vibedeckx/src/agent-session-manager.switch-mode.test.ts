import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * switchMode × Codex provider state, and load-path mode neutrality.
 *
 * Regression (2026-07-18): switchMode killed + respawned the codex
 * app-server without resetting the provider's per-session state, so the
 * fresh process never received initialize/thread-start and the context
 * replay fast-pathed a turn/start with the dead process's threadId —
 * "Codex turn/start failed: Not initialized" rendered right under the
 * turn_end divider. The trigger was the second bug: the workspace load
 * path (findExistingSession) coerced the session's permission mode to the
 * request's default ("edit"), silently mode-switching a plan-mode workflow
 * reviewer as a side effect of a read.
 */

const SESSION_ID = "s1";

function makeHarness(permissionMode: "plan" | "edit") {
  const row: AgentSession = {
    id: SESSION_ID, project_id: "p1", branch: "main", status: "stopped",
    permission_mode: permissionMode, agent_type: "codex", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };
  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getEntries: async () => [
        { session_id: SESSION_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "go", timestamp: 1 }) },
      ],
      getById: async () => row,
      getLatestByBranch: async () => row,
      listByBranch: async () => [row],
      markCompleted: vi.fn(async () => undefined),
      updateStatus: vi.fn(async (_id: string, status: AgentSession["status"]) => { row.status = status; }),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updatePermissionMode: vi.fn(async (_id: string, mode: "plan" | "edit") => { row.permission_mode = mode; }),
      markUserMessage: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      touchUpdatedAt: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
    },
    tasks: { completeIfAssigned: vi.fn(async () => undefined) },
    settings: { get: vi.fn(async () => null) },
  } as unknown as Storage;
  return { storage, row };
}

type FakeProcess = { stdin: { write: (s: string) => boolean }; exitCode: null; pid: number; kill: () => void };

function fakeProcess(writes: string[]): FakeProcess {
  return {
    stdin: { write: (s: string) => { writes.push(s); return true; } },
    exitCode: null, pid: 1234, kill: () => undefined,
  };
}

/**
 * Restore the session, attach a fake live process, and put the codex
 * provider into the "one turn already completed" state that a live session
 * has between turns: initialized, threadId known.
 */
async function betweenTurnsCodexSession(manager: AgentSessionManager, writes: string[]) {
  await manager.restoreSessionsFromDb();
  const internals = manager as unknown as {
    sessions: Map<string, {
      dormant: boolean; status: string; process: FakeProcess | null; permissionMode: "plan" | "edit";
    }>;
    handleStdout: (session: unknown, data: string) => Promise<void>;
    spawnAgent: (session: unknown, cwd: string) => Promise<void>;
  };
  const session = internals.sessions.get(SESSION_ID)!;
  session.dormant = false;
  session.status = "stopped"; // between turns, process alive
  session.process = fakeProcess(writes);

  const provider = getProvider("codex");
  provider.onSessionDestroyed?.(SESSION_ID);
  provider.onSessionCreated?.(SESSION_ID, session.permissionMode);
  const init = provider.getInitializationMessages!(SESSION_ID)!;
  const threadStartId = init.trim().split("\n").map((l) => JSON.parse(l) as { id: number; method: string })
    .find((m) => m.method === "thread/start")!.id;
  await internals.handleStdout(session, JSON.stringify({ jsonrpc: "2.0", id: threadStartId, result: { thread: { id: "th-old" } } }) + "\n");

  return { internals, session };
}

describe("switchMode resets codex provider state", () => {
  it("re-runs the initialize/thread-start handshake on the fresh process instead of reusing the dead one's threadId", async () => {
    const { storage } = makeHarness("plan");
    const manager = new AgentSessionManager(storage, { completionGraceMs: 40 });
    const oldWrites: string[] = [];
    const { internals, session } = await betweenTurnsCodexSession(manager, oldWrites);

    // Stub spawnAgent like the real one: attach a process and send the
    // provider's initialization messages (null when state is stale — the bug).
    const newWrites: string[] = [];
    internals.spawnAgent = async (s: unknown) => {
      const sess = s as { process: FakeProcess | null; dormant: boolean };
      sess.process = fakeProcess(newWrites);
      sess.dormant = false;
      const init = getProvider("codex").getInitializationMessages!(SESSION_ID);
      if (init) sess.process.stdin.write(init);
    };

    const ok = await manager.switchMode(SESSION_ID, "/tmp/p", "edit");
    expect(ok).toBe(true);

    // Fresh process must get the full handshake (stale state returned null here).
    expect(newWrites.some((w) => w.includes('"initialize"'))).toBe(true);
    expect(newWrites.some((w) => w.includes("thread/start"))).toBe(true);

    // The dead process's threadId is gone: a user input now buffers until the
    // new thread/start responds, instead of fast-pathing turn/start to th-old.
    const formatted = getProvider("codex").formatUserInput("hi", SESSION_ID);
    expect(formatted).toBe("");
    expect(session.permissionMode).toBe("edit");
  });
});

describe("findExistingSession is mode-neutral", () => {
  it("returns a between-turns session untouched: no respawn, no status flip, mode preserved", async () => {
    const { storage, row } = makeHarness("plan");
    const manager = new AgentSessionManager(storage, { completionGraceMs: 40 });
    const writes: string[] = [];
    const { internals, session } = await betweenTurnsCodexSession(manager, writes);
    const processBefore = session.process;
    internals.spawnAgent = vi.fn(async () => { throw new Error("load path must not respawn"); });

    const id = await manager.findExistingSession("p1", "main", "/tmp/p", false);

    expect(id).toBe(SESSION_ID);
    expect(session.process).toBe(processBefore); // same live process, not killed
    expect(session.status).toBe("stopped"); // no fake "running" broadcast
    expect(session.permissionMode).toBe("plan"); // reviewer stays read-only
    expect(row.permission_mode).toBe("plan");
  });

  it("returns a dormant session without flipping its persisted mode", async () => {
    const { storage, row } = makeHarness("plan");
    const manager = new AgentSessionManager(storage, { completionGraceMs: 40 });
    await manager.restoreSessionsFromDb();

    const id = await manager.findExistingSession("p1", "main", "/tmp/p", false);

    expect(id).toBe(SESSION_ID);
    expect(row.permission_mode).toBe("plan");
    const internals = manager as unknown as { sessions: Map<string, { dormant: boolean; permissionMode: string }> };
    expect(internals.sessions.get(SESSION_ID)!.dormant).toBe(true);
    expect(internals.sessions.get(SESSION_ID)!.permissionMode).toBe("plan");
  });
});
