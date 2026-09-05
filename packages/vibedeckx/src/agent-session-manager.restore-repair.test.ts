import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { AgentSessionManager } from "./agent-session-manager.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { AgentSession, NotificationOutboxEvent, Storage } from "./storage/types.js";
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
  const outbox: Array<Omit<NotificationOutboxEvent, "seq">> = [];
  const outboxIds = new Set<string>();
  const storage = {
    agentSessions: {
      // A COPY, matching production: `getAll` reads rows out of SQL, so the
      // snapshot `restoreSessionsFromDb` holds goes stale as the loop writes
      // statuses back. Handing out the live object instead would hide the
      // orphan-repair pass's map check behind an already-updated status.
      getAll: async () => [{ ...row }],
      getEntries: async () => [...rows],
      // Restore reads metadata, not transcripts (lazy hydration): one
      // aggregate over every session, no `data` column.
      getEntryMetaAll: async () => rows.length === 0 ? [] : [{
        session_id: "s1",
        cnt: rows.length,
        max_index: rows.reduce((m, r) => Math.max(m, r.entry_index), -1),
      }],
      // Descending page, strictly before the cursor — what crash repair walks
      // back through to find the turn boundary.
      getEntriesBefore: vi.fn(async (_id: string, before: number | null, limit: number) =>
        [...rows]
          .filter((r) => before === null || r.entry_index < before)
          .sort((a, b) => b.entry_index - a.entry_index)
          .slice(0, limit)),
      getById: async () => row,
      listByBranch: async () => [row],
      updateStatusPreservingTimestamp: vi.fn(async (_id: string, s: AgentSession["status"]) => { row.status = s; }),
      // Present only so a test can assert it is NEVER used here. The plain
      // setter also bumps `activity_at`, which would push every session's
      // retention deadline forward on every boot — silently, since retention
      // would simply keep finding nothing expired.
      updateStatus: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async (_id: string, index: number, data: string) => {
        const msg = JSON.parse(data) as AgentMessage;
        upserts.push({ index, msg });
        rows.push(entry(index, msg)); // simulate persistence for a second restore
      }),
      upsertTurnEndWithOutbox: vi.fn(async (o: {
        entryIndex: number;
        entryData: string;
        outbox?: Omit<NotificationOutboxEvent, "seq">;
      }) => {
        const msg = JSON.parse(o.entryData) as AgentMessage;
        upserts.push({ index: o.entryIndex, msg });
        rows.push(entry(o.entryIndex, msg));
        if (o.outbox && !outboxIds.has(o.outbox.id)) {
          outboxIds.add(o.outbox.id);
          outbox.push(o.outbox);
        }
      }),
      touchUpdatedAt: vi.fn(async () => undefined),
    },
  } as unknown as Storage;
  return { storage, row, rows, upserts, outbox };
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
    // The restored session is cold, so the repair entry is read back from
    // storage rather than a rebuilt store.
    expect(manager.getSession("s1")?.hot).toBe(false);
    const msgs = await manager.loadMessages("s1");
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

  /**
   * A crash mid-`result` turn is a real attention milestone: the user asked for
   * something and it never finished. Repair therefore has to write the failure
   * milestone in the SAME storage operation as the server_restart turn_end, and
   * it must recover the turn's disposition from the persisted opening user entry
   * (process memory is gone by definition).
   */
  it("writes session_failed atomically with the server_restart turn_end for a result turn", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1, notificationDisposition: "result" }),
      entry(1, { type: "tool_use", tool: "Bash", input: {}, timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();

    const turnEnds = h.upserts.filter((u) => u.msg.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(h.outbox).toHaveLength(1);
    // Keyed on the real repair index (maxIndex + 1 = 2).
    expect(h.outbox[0].id).toBe("session:s1:turn:2:failed");
    expect(h.outbox[0].kind).toBe("session_failed");
    expect(h.outbox[0].session_id).toBe("s1");
    expect(h.outbox[0].project_id).toBe("p1");
    expect(h.outbox[0].branch).toBe("main");
    // The repaired turn_end carries the recovered disposition forward.
    expect((turnEnds[0].msg as { notificationDisposition?: string }).notificationDisposition).toBe("result");
  });

  it.each(["internal", "milestone-managed"] as const)(
    "repairs a %s turn's boundary without a generic notification",
    async (disposition) => {
      const h = makeHarness("running", [
        entry(0, { type: "user", content: "review", timestamp: 1, origin: "workflow", notificationDisposition: disposition }),
        entry(1, { type: "assistant", content: "half", timestamp: 2 }),
      ]);
      await new AgentSessionManager(h.storage).restoreSessionsFromDb();

      expect(h.upserts.filter((u) => u.msg.type === "turn_end")).toHaveLength(1);
      expect(h.outbox).toHaveLength(0);
    },
  );

  it("a legacy origin:workflow turn with no persisted disposition repairs without a notification", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "old reviewer prompt", timestamp: 1, origin: "workflow" }),
      entry(1, { type: "assistant", content: "half", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.upserts.filter((u) => u.msg.type === "turn_end")).toHaveLength(1);
    expect(h.outbox).toHaveLength(0);
  });

  it("a legacy ordinary user turn with no persisted disposition repairs as a failure", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "assistant", content: "half", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0].kind).toBe("session_failed");
  });

  it("repair is idempotent for the milestone too: a second restore adds nothing", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1, notificationDisposition: "result" }),
      entry(1, { type: "assistant", content: "half", timestamp: 2 }),
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();
    expect(h.outbox).toHaveLength(1);
  });

  it("repairs when the landing row is unparsable (truncated tail write from a hard kill)", async () => {
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      { session_id: "s1", entry_index: 1, data: "{truncated" }, // corrupted tail — crash signature
    ]);
    await new AgentSessionManager(h.storage).restoreSessionsFromDb();

    const turnEnds = h.upserts.filter((u) => u.msg.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].index).toBe(2); // maxIndex + 1
    expect((turnEnds[0].msg as { outcome?: string }).outcome).toBe("server_restart");
  });
});

/**
 * Repair inserts the server_restart turn_end, but review scoping needs a
 * snapshot at that same index too (see recordTurnSnapshot / endActiveTurn's
 * hook) — otherwise getStartBoundary for the NEXT turn skips the crash
 * boundary and jumps back to the stale pre-crash snapshot, folding the
 * interrupted turn's changes into the next turn's review scope. Uses real
 * sqlite storage + a real git worktree (the mocked harness above has no
 * `projects` table or filesystem, so it can't exercise resolveWorktreePath /
 * captureSnapshot) — mirrors the pattern in review-snapshot.test.ts.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vdx-repair-repo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "base.ts"), "const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

describe("restore-time turn repair: snapshot at the repair boundary", () => {
  it("records a turn_snapshots row at the repair index, so a later turn's getStartBoundary resolves to the restart state instead of the stale pre-crash snapshot", async () => {
    const repoDir = initRepo();
    const dbDir = mkdtempSync(path.join(tmpdir(), "vdx-repair-db-"));
    const storage: Storage = await createSqliteStorage(path.join(dbDir, "db.sqlite"));

    try {
      await storage.projects.create({ id: "p1", name: "p", path: repoDir });
      // branch: "" is how the manager records "no worktree branch" (see
      // spawnSession) — resolveWorktreePath treats it as falsy and resolves
      // straight to the project path, same as branch: null.
      await storage.agentSessions.create({
        id: "s1", project_id: "p1", branch: "",
        permission_mode: "edit", agent_type: "claude-code",
      });

      // Turn 0 completes cleanly; its turn_end (index 2) gets a snapshot of
      // the clean-tree state, exactly as endActiveTurn would record live.
      await storage.agentSessions.upsertEntry("s1", 0, JSON.stringify({ type: "user", content: "turn 0", timestamp: 1 } satisfies AgentMessage));
      await storage.agentSessions.upsertEntry("s1", 1, JSON.stringify({ type: "assistant", content: "done", timestamp: 2 } satisfies AgentMessage));
      await storage.agentSessions.upsertEntry("s1", 2, JSON.stringify({ type: "turn_end", timestamp: 3, durationMs: 2, outcome: "completed" } satisfies AgentMessage));
      await storage.turnSnapshots.create({
        session_id: "s1",
        turn_end_index: 2,
        head: git(repoDir, ["rev-parse", "HEAD"]),
        dirty: {},
      });

      // Turn 1 starts and the agent writes an uncommitted file, then the
      // process is killed mid-turn — no turn_end persisted, and the dirty
      // file is left on disk exactly as it was at crash time.
      await storage.agentSessions.upsertEntry("s1", 3, JSON.stringify({ type: "user", content: "turn 1", timestamp: 4 } satisfies AgentMessage));
      await storage.agentSessions.upsertEntry("s1", 4, JSON.stringify({ type: "tool_use", tool: "Write", input: {}, timestamp: 5 } satisfies AgentMessage));
      writeFileSync(path.join(repoDir, "mid-turn.ts"), "const inflight = true;\n");

      // Session row's status is "running" (create()'s default) — the crash
      // never got to mark it stopped, so restore's repair gate fires.
      const manager = new AgentSessionManager(storage);
      await manager.restoreSessionsFromDb();

      // The repair turn_end lands at index 5 (maxIndex 4 + 1). A snapshot
      // must exist at that same index, capturing the crash-time dirty file.
      const repairSnap = await storage.turnSnapshots.getStartBoundary("s1", 6);
      expect(repairSnap).toBeDefined();
      expect(repairSnap?.head).toBe(git(repoDir, ["rev-parse", "HEAD"]));
      expect(repairSnap?.dirty["mid-turn.ts"]).toBe(git(repoDir, ["hash-object", "mid-turn.ts"]));

      // End-to-end: a subsequent turn's start boundary must be the repair
      // snapshot (dirty includes mid-turn.ts), not the pre-crash one at
      // index 2 (dirty {}) — the exact folding bug this test guards against.
      expect(repairSnap?.dirty).not.toEqual({});
    } finally {
      await storage.close();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

/**
 * Orphan repair: a row the DB still calls "running" that this process does not
 * own gets reset to "stopped".
 *
 * `create` writes `running` before the process is spawned, so anything that
 * dies before the first entry lands leaves such a row — and the restore loop
 * above skips zero-entry sessions before it resets crashed statuses, so those
 * rows were never repaired at all. Measured on a real worker: 63 of them, the
 * oldest four months old, each permanently exempt from session retention and
 * counted as live on the project dashboard.
 */
describe("restore-time orphan repair", () => {
  it("resets a zero-entry running row without resurrecting it as a session", async () => {
    const h = makeHarness("running", []);
    const manager = new AgentSessionManager(h.storage);

    await manager.restoreSessionsFromDb();

    expect(h.row.status).toBe("stopped");
    // Repaired, not restored: with no history there is nothing to rebuild, and
    // a phantom entry in the map would surface in the sidebar and the history
    // dropdown as a session the user never had.
    expect(manager.getSession("s1")).toBeNull();
    expect(h.upserts).toHaveLength(0);
  });

  it("preserves timestamps — the plain setter would break retention silently", async () => {
    const h = makeHarness("running", []);

    await new AgentSessionManager(h.storage).restoreSessionsFromDb();

    expect(vi.mocked(h.storage.agentSessions.updateStatusPreservingTimestamp))
      .toHaveBeenCalledWith("s1", "stopped");
    // `updateStatus` also bumps `activity_at`. Using it here would reset every
    // session's retention deadline on every boot, so a machine that restarts
    // regularly would expire nothing — and nothing would ever error.
    expect(vi.mocked(h.storage.agentSessions.updateStatus)).not.toHaveBeenCalled();
  });

  it("leaves a row alone once the session is in memory", async () => {
    // The snapshot still reads "running" for this row (the loop's write-back
    // does not rewrite it), so only the ownership check can stop a second
    // write. That check is `this.sessions.has(id)` rather than
    // `process === null` on purpose: a session that is spawning or waking sits
    // in the map with a null process and must not be touched either.
    const h = makeHarness("running", [
      entry(0, { type: "user", content: "go", timestamp: 1 }),
      entry(1, { type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" }),
    ]);
    const manager = new AgentSessionManager(h.storage);

    await manager.restoreSessionsFromDb();

    expect(manager.getSession("s1")).toBeDefined();
    expect(vi.mocked(h.storage.agentSessions.updateStatusPreservingTimestamp))
      .toHaveBeenCalledTimes(1); // the restore loop's own reset, not a second one
  });
});
