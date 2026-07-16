import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import type { AgentSession, Storage } from "./storage/types.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * Crash repair: a session whose DB status was still "running" and whose
 * entry tail is not a turn_end gets a server_restart turn_end appended at
 * restore. Status-stopped sessions (incl. pre-feature histories) and clean
 * tails are untouched; repair is idempotent across restarts.
 */

type Row = { session_id: string; entry_index: number; data: string };
const entry = (i: number, msg: object): Row => ({ session_id: "s1", entry_index: i, data: JSON.stringify(msg) });

function makeHarness(status: AgentSession["status"], rows: Row[]) {
  const row: AgentSession = {
    id: "s1", project_id: "p1", branch: "main", status,
    permission_mode: "edit", agent_type: "claude-code", title: "t",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_user_message_at: 1, last_completed_at: null,
  };
  const upserts: Array<{ index: number; msg: AgentMessage }> = [];
  const storage = {
    agentSessions: {
      getAll: async () => [row],
      getEntries: async () => [...rows],
      getById: async () => row,
      listByBranch: async () => [row],
      updateStatusPreservingTimestamp: vi.fn(async (_id: string, s: AgentSession["status"]) => { row.status = s; }),
      upsertEntry: vi.fn(async (_id: string, index: number, data: string) => {
        const msg = JSON.parse(data) as AgentMessage;
        upserts.push({ index, msg });
        rows.push(entry(index, msg)); // simulate persistence for a second restore
      }),
      touchUpdatedAt: vi.fn(async () => undefined),
    },
  } as unknown as Storage;
  return { storage, row, rows, upserts };
}

describe("restore-time turn repair", () => {
  it("appends a server_restart turn_end when DB status was running and the tail is mid-turn", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "tool_use", tool: "Bash", input: {}, timestamp: 2 }),
    ]);
    const manager = new AgentSessionManager(h.storage);
    await manager.restoreSessionsFromDb();

    const turnEnds = h.upserts.filter((u) => u.msg.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].index).toBe(2); // maxIndex + 1
    expect((turnEnds[0].msg as { outcome?: string }).outcome).toBe("server_restart");
    expect((turnEnds[0].msg as { durationMs?: number }).durationMs).toBeUndefined();
    // The rebuilt in-memory store includes the repair entry.
    const msgs = manager.getMessages("s1");
    expect(msgs[2]?.type).toBe("turn_end");
  });

  it("is idempotent: a second restore appends nothing", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "assistant", content: "half", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    await new AgentSessionManager(h.storage).restoreSessionsFromDb(); // fresh manager, same DB
    expect(h.upserts.filter((u) => u.msg.type === "turn_end")).toHaveLength(1);
  });

  it("leaves status-stopped marker-less (pre-feature) sessions untouched", async () => {
    const h = makeHarness("stopped", [
      entry(0, { type: "user", content: "old", timestamp: 1 }),
      entry(1, { type: "assistant", content: "old answer", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.upserts).toHaveLength(0);
  });

  it("skips trailing system entries when checking the tail (hibernate note after turn_end)", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" }),
      entry(2, { type: "system", content: "Agent process hibernated to free resident capacity. Send a message to wake it.", timestamp: 3 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.upserts).toHaveLength(0);
  });
});
