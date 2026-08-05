import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import type { AgentSession, Storage } from "./storage/types.js";

// spawnAgent bails out before calling buildSpawnConfig if the cwd doesn't
// exist on disk — not in the brief's harness, but createNewSession resolves
// a null branch straight to this literal path, so it must be real.
mkdirSync("/tmp/p1", { recursive: true });

function makeStorage() {
  const rows = new Map<string, AgentSession>();
  const checkout = {
    id: "checkout-1", workspace_id: "workspace-1", target_id: "local",
    worktree_path: "/tmp/p1", expected_branch: "", status: "ready" as const,
    error: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const storage = {
    agentSessions: {
      updateModel: vi.fn(async (id: string, model: string | null) => {
        const row = rows.get(id);
        if (row) row.model = model;
      }),
      create: async (row: Partial<AgentSession> & { id: string }) => {
        const full = {
          status: "running",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          ...row,
        } as AgentSession;
        rows.set(row.id, full);
        return full;
      },
      createBound: async (row: Partial<AgentSession> & { id: string }) => {
        const full = await storage.agentSessions.create({ ...row, workspace_checkout_id: checkout.id });
        return { session: full, checkout };
      },
      getById: async (id: string) => rows.get(id) ?? null,
      getAll: async () => [...rows.values()],
      getEntries: async () => [],
      upsertEntry: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => [...rows.values()],
      touchUpdatedAt: vi.fn(async () => undefined),
    },
    // createNewSession consults settings.agentProcesses for resident-capacity
    // enforcement before it ever touches the model — not in the brief's
    // harness, but required or ensureResidentCapacity throws on a bare mock.
    settings: {
      get: async () => undefined,
    },
    workspaceRegistry: {
      getByProjectBranch: async () => ({
        workspace: { id: "workspace-1", project_id: "p1", branch: "", status: "ready", error: null,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        checkout,
      }),
      getCheckoutById: async () => ({
        workspace: { id: "workspace-1", project_id: "p1", branch: "", status: "ready", error: null,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        checkout,
      }),
    },
  } as unknown as Storage;
  const updateModel = (storage as unknown as {
    agentSessions: { updateModel: ReturnType<typeof vi.fn> };
  }).agentSessions.updateModel;
  return { storage, rows, updateModel };
}

/** Capture buildSpawnConfig args while spawning a process that exits at once. */
function stubSpawn() {
  const calls: unknown[][] = [];
  const spy = vi
    .spyOn(getProvider("claude-code"), "buildSpawnConfig")
    .mockImplementation((...args: unknown[]) => {
      calls.push(args);
      return { command: "true", args: [] };
    });
  return { calls, spy };
}

describe("session manager model wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists the model on create and hands it to the spawn builder", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "opus" },
    );

    expect(rows.get(sessionId)?.model).toBe("opus");
    expect(manager.getSession(sessionId)?.model).toBe("opus");
    expect(calls[0]?.[3]).toBe("opus");
  });

  it("passes null through when no model was chosen", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession("p1", null, "/tmp/p1", false, "edit", "claude-code");

    expect(rows.get(sessionId)?.model ?? null).toBeNull();
    expect(calls[0]?.[3] ?? null).toBeNull();
  });

  it("normalizes a whitespace-only model to null", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "   " },
    );

    expect(rows.get(sessionId)?.model ?? null).toBeNull();
    expect(calls[0]?.[3] ?? null).toBeNull();
  });

  it("rehydrates and spawns a matching stored-only preallocated session without reinserting it", async () => {
    const { storage, rows } = makeStorage();
    const create = vi.spyOn(storage.agentSessions, "create");
    rows.set("worker-id", {
      id: "worker-id", project_id: "p1", branch: "", status: "running",
      permission_mode: "edit", agent_type: "claude-code", model: "opus",
      title: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false,
      { sessionId: "worker-id", model: "opus" },
    );

    expect(sessionId).toBe("worker-id");
    expect(create).not.toHaveBeenCalled();
    expect(manager.getSession("worker-id")).toMatchObject({ projectId: "p1", model: "opus" });
    expect(calls).toHaveLength(1);
  });
});

const HISTORY = [
  { session_id: "s-src", entry_index: 0, data: JSON.stringify({ type: "user", content: "hi", timestamp: 1 }) },
  { session_id: "s-src", entry_index: 1, data: JSON.stringify({ type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" }) },
];

/** Storage seeded with one persisted source session that has history. */
function makeSeededStorage(sourceRow: Partial<AgentSession>) {
  const source = {
    id: "s-src",
    project_id: "p1",
    branch: "feat",
    workspace_checkout_id: "checkout-feat",
    status: "stopped",
    permission_mode: "edit",
    agent_type: "claude-code",
    title: "Original",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...sourceRow,
  } as AgentSession;

  const created: AgentSession[] = [];
  const checkout = {
    id: "checkout-feat", workspace_id: "workspace-feat", target_id: "local",
    worktree_path: "/tmp/p1", expected_branch: "feat", status: "ready" as const,
    error: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  // Records every persisted model write so a "cleared in memory only" bug —
  // which would silently come back on the next server restart, since
  // restoreSessionsFromDb re-reads the row — can't pass.
  const updateModel = vi.fn(async (id: string, model: string | null) => {
    if (id === "s-src") source.model = model;
    const row = created.find((r) => r.id === id);
    if (row) row.model = model;
  });
  const storage = {
    agentSessions: {
      getAll: async () => [source],
      getById: async (id: string) => (id === "s-src" ? source : created.find((r) => r.id === id) ?? null),
      getEntries: async () => HISTORY,
      create: async (row: Partial<AgentSession>) => { created.push({ ...source, ...row } as AgentSession); },
      createBound: async (row: Partial<AgentSession>) => {
        const session = { ...source, ...row, workspace_checkout_id: checkout.id } as AgentSession;
        created.push(session);
        return { session, checkout };
      },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      updateModel,
      upsertEntry: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => created,
      // switchAgentType's confirmation system entry goes through pushEntry →
      // persistEntry, which touches updated_at — not in the brief's harness,
      // but required or that path throws mid-test.
      touchUpdatedAt: vi.fn(async () => undefined),
      updateLastUserMessageAt: vi.fn(async () => undefined),
      // The woken process exits at once (stubSpawn runs `true`), which closes
      // the turn — these two are that path's writes, stubbed only to keep the
      // test output clean.
      upsertTurnEndWithOutbox: vi.fn(async () => undefined),
    },
    turnSnapshots: { getById: async () => null },
    // Waking a dormant session first checks the resident-process cap.
    settings: { get: async () => undefined },
    workspaceRegistry: {
      getByProjectBranch: async () => ({
        workspace: { id: "workspace-feat", project_id: "p1", branch: source.branch, status: "ready", error: null,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        checkout,
      }),
      getCheckoutById: async () => ({
        workspace: { id: "workspace-feat", project_id: "p1", branch: source.branch, status: "ready", error: null,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        checkout,
      }),
    },
  } as unknown as Storage;

  return { storage, created, source, updateModel };
}

describe("model survives every respawn path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restoreSessionsFromDb rehydrates the model from the row", async () => {
    const { storage } = makeSeededStorage({ model: "sonnet" });
    const manager = new AgentSessionManager(storage);

    await manager.restoreSessionsFromDb();

    expect(manager.getSession("s-src")?.model).toBe("sonnet");
  });

  it("restoreSessionsFromDb yields null for legacy rows with no model", async () => {
    const { storage } = makeSeededStorage({});
    const manager = new AgentSessionManager(storage);

    await manager.restoreSessionsFromDb();

    expect(manager.getSession("s-src")?.model ?? null).toBeNull();
  });

  it("branchSession inherits the source session's model", async () => {
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", undefined, { upToEntryIndex: 1 });
    expect(result.ok).toBe(true);
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    expect(created.find((r) => r.id === newId)?.model).toBe("opus");
    expect(manager.getSession(newId)?.model).toBe("opus");
  });

  it("branchSession clears the model when the agent type is overridden", async () => {
    // A model name is agent-specific: "opus" is meaningless to Codex, so
    // inheriting it would produce a branch that fails every turn with a locked
    // chip and no way to clear it. Falling back to the Codex default is the
    // only usable outcome. (This is not validation — nothing inspects the
    // string; only the fact that the agent changed matters.)
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", "codex", { upToEntryIndex: 1 });
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    expect(created.find((r) => r.id === newId)?.model ?? null).toBeNull();
    expect(manager.getSession(newId)?.model ?? null).toBeNull();
  });

  it("branchSession still inherits the model when the override names the same agent", async () => {
    // The override is only a signal that the agent *changed*; naming the agent
    // the session already uses is a no-op and must not cost the user's model.
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", "claude-code", { upToEntryIndex: 1 });
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    expect(created.find((r) => r.id === newId)?.model).toBe("opus");
    expect(manager.getSession(newId)?.model).toBe("opus");
  });

  it("switchAgentType clears the model, in memory and in the DB", async () => {
    // Same reason as the branch override: the session keeps its identity but
    // changes CLI, so the inherited name can only spawn a broken process.
    // Persisting matters — restoreSessionsFromDb re-reads the row, so a
    // memory-only clear would resurrect "opus" on the next server restart.
    const { storage, updateModel, source } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.switchAgentType("s-src", "codex")).toBe("ok");
    expect(manager.getSession("s-src")?.model ?? null).toBeNull();
    expect(updateModel).toHaveBeenCalledWith("s-src", null);
    expect(source.model ?? null).toBeNull();
  });

  it("switchAgentType says so in the conversation when it clears a model", async () => {
    // Models are free text, so the announcement must not claim the cleared
    // name was invalid for the new agent (it may well be valid there) — it
    // can only state what's known: the name was set for the previous agent.
    const { storage } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    await manager.switchAgentType("s-src", "codex");

    const systemEntry = manager
      .getMessages("s-src")
      .filter(Boolean)
      .find((m) => m?.type === "system" && m.content?.includes("Coding agent switched"));
    expect(systemEntry?.content).toBe(
      "Coding agent switched to Codex. Model reset to the default (`opus` was set for Claude Code)."
    );
    expect(systemEntry?.content).not.toContain("is not a");
  });

  it("switchAgentType leaves the announcement plain when there was no model", async () => {
    const { storage, updateModel } = makeSeededStorage({});
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    await manager.switchAgentType("s-src", "codex");

    const systemEntry = manager
      .getMessages("s-src")
      .filter(Boolean)
      .find((m) => m?.type === "system" && m.content?.includes("Coding agent switched"));
    expect(systemEntry?.content).not.toContain("Model reset");
    expect(updateModel).not.toHaveBeenCalled();
  });
});

/**
 * Changing the model of a session that already exists. The model is a spawn
 * argument, so this is bounded by when the next process starts, not by
 * whether the session is new: a branch, or any stopped session, has no
 * process to argue with.
 */
describe("setModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a branch can still change its model — the whole point of arriving dormant", async () => {
    // The branch inherits "opus", but nothing has run on it yet: the model is
    // still only an argument for a process that hasn't been spawned, so the
    // user must be able to name a different one before the first message.
    const { storage, created, updateModel } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    const branchResult = await manager.branchSession("s-src", undefined, { upToEntryIndex: 1 });
    const newId = (branchResult as { ok: true; sessionId: string }).sessionId;

    expect(await manager.setModel(newId, "sonnet")).toBe("ok");

    expect(manager.getSession(newId)?.model).toBe("sonnet");
    // Persisted, or a server restart would resurrect the inherited "opus"
    // through restoreSessionsFromDb.
    expect(updateModel).toHaveBeenCalledWith(newId, "sonnet");
    expect(created.find((r) => r.id === newId)?.model).toBe("sonnet");
  });

  it("hands the new model to the spawn builder when the session next wakes", async () => {
    // The change is only real if it reaches the CLI: a dormant session spawns
    // on its next user message, and that spawn must carry the new name.
    const { storage } = makeSeededStorage({ model: "opus", branch: "" });
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.setModel("s-src", "sonnet")).toBe("ok");
    await manager.sendUserMessage("s-src", "carry on", "/tmp/p1");

    expect(calls[0]?.[3]).toBe("sonnet");
  });

  it("clears back to the CLI default when the model is set to null", async () => {
    const { storage, updateModel, source } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.setModel("s-src", null)).toBe("ok");

    expect(manager.getSession("s-src")?.model ?? null).toBeNull();
    expect(source.model ?? null).toBeNull();
    expect(updateModel).toHaveBeenCalledWith("s-src", null);
  });

  it("normalizes a whitespace-only name to the default, like creation does", async () => {
    const { storage } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.setModel("s-src", "   ")).toBe("ok");

    expect(manager.getSession("s-src")?.model ?? null).toBeNull();
  });

  it("trims the name, so a stray space can't spawn a model nobody named", async () => {
    const { storage, updateModel } = makeSeededStorage({});
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    await manager.setModel("s-src", "  sonnet  ");

    expect(manager.getSession("s-src")?.model).toBe("sonnet");
    expect(updateModel).toHaveBeenCalledWith("s-src", "sonnet");
  });

  it("refuses while a turn is in flight on a session that has history", async () => {
    // The model is a spawn argument: the running process already has one and
    // cannot be told about another. Same rule as switchAgentType.
    const { storage, updateModel } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    manager.getSession("s-src")!.status = "running";

    expect(await manager.setModel("s-src", "sonnet")).toBe("busy");

    expect(manager.getSession("s-src")?.model).toBe("opus");
    expect(updateModel).not.toHaveBeenCalled();
  });

  it("re-picking the model already in force is a no-op, not a refusal", async () => {
    // Nothing changes, so there is nothing to refuse — and nothing to write.
    const { storage, updateModel } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    manager.getSession("s-src")!.status = "running";

    expect(await manager.setModel("s-src", "opus")).toBe("ok");
    expect(updateModel).not.toHaveBeenCalled();
  });

  it("retires the idle process of a fresh session so the next spawn uses the new model", async () => {
    // A session created but not yet talked to holds a process spawned with the
    // old model. Keeping it would silently run the first turn on the model the
    // user just replaced, so it is retired and the session goes dormant —
    // exactly what switchAgentType does in the same situation.
    const { storage, rows } = makeStorage();
    stubSpawn();
    const manager = new AgentSessionManager(storage);
    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "opus" },
    );

    expect(await manager.setModel(sessionId, "sonnet")).toBe("ok");

    expect(manager.getSession(sessionId)?.model).toBe("sonnet");
    expect(rows.get(sessionId)?.model).toBe("sonnet");
    expect(manager.getSession(sessionId)?.process).toBeNull();
    expect(manager.getSession(sessionId)?.dormant).toBe(true);
    expect(manager.getSession(sessionId)?.status).toBe("stopped");
  });

  it("changes nothing at all when the row can't be written", async () => {
    // The row is what survives a restart and `session.model` is what the next
    // spawn reads. A half-applied change would run the next turn on a model
    // the UI never confirmed, then silently revert on the next restart — so a
    // failed write has to leave the session exactly as it was, process and all.
    const { storage, rows, updateModel } = makeStorage();
    stubSpawn();
    const manager = new AgentSessionManager(storage);
    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "opus" },
    );
    updateModel.mockRejectedValueOnce(new Error("disk full"));

    expect(await manager.setModel(sessionId, "sonnet")).toBe("error");

    expect(manager.getSession(sessionId)?.model).toBe("opus");
    expect(rows.get(sessionId)?.model).toBe("opus");
    // The process is only retired once the change is committed — a failed
    // write must not cost the session its live agent either.
    expect(manager.getSession(sessionId)?.process).not.toBeNull();
    expect(manager.getSession(sessionId)?.dormant).toBe(false);
    expect(manager.getSession(sessionId)?.status).toBe("running");
  });

  it("rolls the row back if a turn starts while the write is in flight", async () => {
    // sendUserMessage doesn't run on the session's event chain, so a message
    // can wake the session across the await — and that process is already
    // running on the old model. Undo the write rather than kill a live turn.
    const { storage, source, updateModel } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();
    updateModel.mockImplementationOnce(async (_id: string, model: string | null) => {
      source.model = model;
      manager.getSession("s-src")!.status = "running"; // a message woke it meanwhile
    });

    expect(await manager.setModel("s-src", "sonnet")).toBe("busy");

    expect(source.model).toBe("opus");
    expect(manager.getSession("s-src")?.model).toBe("opus");
  });

  it("serializes concurrent changes, so the row and memory land on the same last pick", async () => {
    // Two picks in quick succession must not interleave at the write: the
    // second one starts only once the first has finished, so whichever the
    // user chose last is what both the row and the next spawn hold.
    const { storage, source, updateModel } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    let releaseFirstWrite: () => void = () => {};
    const firstWriteStarted = new Promise<void>((started) => {
      updateModel.mockImplementationOnce(async (_id: string, model: string | null) => {
        started();
        await new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
        source.model = model;
      });
    });

    const first = manager.setModel("s-src", "sonnet");
    const second = manager.setModel("s-src", "haiku");
    await firstWriteStarted;

    // The second change is queued behind the first, not racing it.
    expect(updateModel).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    expect(await first).toBe("ok");
    expect(await second).toBe("ok");

    expect(updateModel.mock.calls.map((c) => c[1])).toEqual(["sonnet", "haiku"]);
    expect(source.model).toBe("haiku");
    expect(manager.getSession("s-src")?.model).toBe("haiku");
  });

  it("reports an unknown session rather than inventing one", async () => {
    const { storage } = makeSeededStorage({});
    const manager = new AgentSessionManager(storage);

    expect(await manager.setModel("nope", "opus")).toBe("not_found");
  });
});
