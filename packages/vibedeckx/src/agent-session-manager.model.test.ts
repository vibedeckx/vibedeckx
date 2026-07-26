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
  const storage = {
    agentSessions: {
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
      getById: async (id: string) => rows.get(id) ?? null,
      getAll: async () => [...rows.values()],
      getEntries: async () => [],
      upsertEntry: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => [...rows.values()],
    },
    // createNewSession consults settings.agentProcesses for resident-capacity
    // enforcement before it ever touches the model — not in the brief's
    // harness, but required or ensureResidentCapacity throws on a bare mock.
    settings: {
      get: async () => undefined,
    },
  } as unknown as Storage;
  return { storage, rows };
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
    status: "stopped",
    permission_mode: "edit",
    agent_type: "claude-code",
    title: "Original",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...sourceRow,
  } as AgentSession;

  const created: AgentSession[] = [];
  const storage = {
    agentSessions: {
      getAll: async () => [source],
      getById: async (id: string) => (id === "s-src" ? source : created.find((r) => r.id === id) ?? null),
      getEntries: async () => HISTORY,
      create: async (row: Partial<AgentSession>) => { created.push({ ...source, ...row } as AgentSession); },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => created,
      // switchAgentType's confirmation system entry goes through pushEntry →
      // persistEntry, which touches updated_at — not in the brief's harness,
      // but required or that path throws mid-test.
      touchUpdatedAt: vi.fn(async () => undefined),
    },
  } as unknown as Storage;

  return { storage, created };
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

  it("branchSession keeps the model when the agent type is overridden", async () => {
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", "codex", { upToEntryIndex: 1 });
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    // The model is copied verbatim even across agents — it is never validated,
    // so a claude alias landing on a codex session simply fails at the CLI.
    expect(created.find((r) => r.id === newId)?.model).toBe("opus");
  });

  it("switchAgentType leaves the model untouched", async () => {
    // switchAgentType mutates the existing RunningSession rather than building
    // a new one, so it inherits session.model for free — this locks that in
    // against a future refactor that rebuilds the object.
    const { storage } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.switchAgentType("s-src", "codex")).toBe("ok");
    expect(manager.getSession("s-src")?.model).toBe("opus");
  });
});
