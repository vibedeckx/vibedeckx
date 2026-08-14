import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import { SESSION_TOOLS_MCP_PATH, type SessionToolsMcpConfig } from "./session-tools-mcp.js";
import { verifySessionToolsToken } from "./utils/session-tools-token.js";
import type { AgentSession, Storage } from "./storage/types.js";

mkdirSync("/tmp/p1", { recursive: true });

/** Same shape as the model-wiring harness, plus the settings store the token secret lives in. */
function makeStorage() {
  const rows = new Map<string, AgentSession>();
  const settings = new Map<string, string>();
  const checkout = {
    id: "checkout-1", workspace_id: "workspace-1", target_id: "local",
    worktree_path: "/tmp/p1", expected_branch: "", status: "ready" as const,
    error: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const workspace = {
    id: "workspace-1", project_id: "p1", branch: "", status: "ready", error: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const storage = {
    agentSessions: {
      create: async (row: Partial<AgentSession> & { id: string }) => {
        const full = { status: "running", created_at: "x", updated_at: "x", ...row } as AgentSession;
        rows.set(row.id, full);
        return full;
      },
      createBound: async (row: Partial<AgentSession> & { id: string }) => ({
        session: await storage.agentSessions.create({ ...row, workspace_checkout_id: checkout.id }),
        checkout,
      }),
      getById: async (id: string) => rows.get(id) ?? null,
      getAll: async () => [...rows.values()],
      getEntries: async () => [],
      upsertEntry: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => [...rows.values()],
      touchUpdatedAt: vi.fn(async () => undefined),
    },
    settings: {
      get: async () => undefined,
      getOrCreate: vi.fn(async (key: string, create: () => string) => {
        if (!settings.has(key)) settings.set(key, create());
        return settings.get(key)!;
      }),
    },
    workspaceRegistry: {
      getByProjectBranch: async () => ({ workspace, checkout }),
      getCheckoutById: async () => ({ workspace, checkout }),
    },
  } as unknown as Storage;
  return { storage, settings };
}

/** Capture buildSpawnConfig args while spawning a process that exits at once. */
function stubSpawn() {
  const calls: unknown[][] = [];
  vi.spyOn(getProvider("claude-code"), "buildSpawnConfig").mockImplementation((...args: unknown[]) => {
    calls.push(args);
    return { command: "true", args: [] };
  });
  return calls;
}

describe("session tools MCP wiring at spawn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands the spawn builder a loopback config whose token names this session", async () => {
    const { storage, settings } = makeStorage();
    const calls = stubSpawn();
    const manager = new AgentSessionManager(storage);
    manager.localApiOrigin = "http://127.0.0.1:5173";

    const sessionId = await manager.createNewSession("p1", null, "/tmp/p1", false, "edit", "claude-code");

    const config = calls[0]?.[4] as SessionToolsMcpConfig;
    expect(config.url).toBe(`http://127.0.0.1:5173${SESSION_TOOLS_MCP_PATH}`);
    const secret = settings.get("session_tools_token_secret")!;
    expect(verifySessionToolsToken(secret, config.token, Date.now())).toEqual({ sessionId });
  });

  it("offers no tools when the server's local origin is unknown", async () => {
    const { storage } = makeStorage();
    const calls = stubSpawn();
    const manager = new AgentSessionManager(storage);

    await manager.createNewSession("p1", null, "/tmp/p1", false, "edit", "claude-code");

    expect(calls[0]?.[4]).toBeUndefined();
  });

  it("spawns the session anyway when minting fails", async () => {
    const { storage } = makeStorage();
    const calls = stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    (storage.settings.getOrCreate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const manager = new AgentSessionManager(storage);
    manager.localApiOrigin = "http://127.0.0.1:5173";

    const sessionId = await manager.createNewSession("p1", null, "/tmp/p1", false, "edit", "claude-code");

    expect(manager.getSession(sessionId)).toBeDefined();
    expect(calls[0]?.[4]).toBeUndefined();
  });
});
