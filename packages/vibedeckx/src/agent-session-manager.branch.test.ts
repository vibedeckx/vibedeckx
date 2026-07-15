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

function makeHarness() {
  const sourceRow: AgentSession = {
    id: SOURCE_ID,
    project_id: "p1",
    branch: "feat",
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

  const storage = {
    agentSessions: {
      getById: async (id: string) => (id === SOURCE_ID ? sourceRow : created.find((r) => r.id === id) ?? null),
      getEntries: async () => [
        { session_id: SOURCE_ID, entry_index: 0, data: JSON.stringify({ type: "user", content: "hello", timestamp: 1 }) },
      ],
      create: async (row: AgentSession) => { created.push({ ...sourceRow, ...row }); },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => created,
    },
  } as unknown as Storage;

  return { storage };
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

    const newId = await manager.branchSession(SOURCE_ID, undefined, {
      sessionId: preSessionId,
      crossRemoteMcp,
    });

    expect(newId).toBe(preSessionId);
    expect(manager.getSession(newId!)?.crossRemoteMcp).toEqual(crossRemoteMcp);
  });
});
