import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage, WorkflowRunStatus } from "./types.js";
import { WORKFLOW_ACTIVE_STATUSES } from "./workflow-run-status.js";

/**
 * The retention predicate and its two consumers
 * (docs/plans/2026-08-08-session-retention.md §1.2 / §1.5). Everything here is
 * about what must NOT be deleted: the scan and the conditional delete share
 * one SQL fragment precisely so an exemption can't hold in one and leak in the
 * other.
 */

const DAY = 86_400_000;

describe("session retention predicate", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;
  let now: number;
  let cutoff: number;

  /** `activity_at` has no setter — it only ever moves forward through real
   * activity — so ageing a session for a test means writing the column. */
  const setActivityAt = (id: string, activityAt: number) => {
    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE agent_sessions SET activity_at = ? WHERE id = ?").run(activityAt, id);
    } finally {
      raw.close();
    }
  };

  const createExpired = async (id: string, ageDays = 100) => {
    await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus(id, "stopped");
    setActivityAt(id, now - ageDays * DAY);
  };

  const candidateIds = async (limit = 20) =>
    (await storage.agentSessions.listRetentionCandidates({ cutoff, limit })).map((c) => c.id);

  beforeEach(async () => {
    now = Date.now();
    cutoff = now - 90 * DAY;
    dir = mkdtempSync(path.join(tmpdir(), "vdx-retention-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects an expired, unfavorited, stopped session", async () => {
    await createExpired("old");
    expect(await candidateIds()).toEqual(["old"]);
    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(true);
    expect(await storage.agentSessions.getById("old")).toBeUndefined();
  });

  it("exempts favorited sessions", async () => {
    await createExpired("old");
    await storage.agentSessions.setFavorited("old", true);
    expect(await candidateIds()).toEqual([]);
    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(false);
    expect(await storage.agentSessions.getById("old")).toBeDefined();
  });

  it("exempts running sessions", async () => {
    await createExpired("old");
    await storage.agentSessions.updateStatusPreservingTimestamp("old", "running");
    expect(await candidateIds()).toEqual([]);
    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(false);
  });

  it("exempts sessions inside the window", async () => {
    await createExpired("fresh", 89);
    expect(await candidateIds()).toEqual([]);
    expect(await storage.agentSessions.deleteIfExpired("fresh", cutoff)).toBe(false);
  });

  it("goes by last activity, not creation date", async () => {
    await createExpired("revived");
    // Created long ago, used yesterday: activity_at is what counts.
    await storage.agentSessions.markUserMessage("revived", now - DAY);
    expect(await candidateIds()).toEqual([]);
  });

  describe("active workflow participants", () => {
    // The participants of a live review are routinely `stopped` while waiting
    // on the reviewer, and workflow_runs has no foreign key to agent_sessions
    // — nothing but this predicate stands between them and deletion.
    for (const role of ["source_session_id", "reviewer_session_id"] as const) {
      for (const status of WORKFLOW_ACTIVE_STATUSES) {
        it(`exempts the ${role} of a ${status} run`, async () => {
          await createExpired("participant");
          await storage.workflowRuns.create({
            id: `r-${role}-${status}`, project_id: "p1", branch: "dev",
            source_session_id: role === "source_session_id" ? "participant" : "other",
            source_turn_end_index: 1, review_focus: null, review_target: null,
            reviewer_session_id: role === "reviewer_session_id" ? "participant" : null,
          });
          await storage.workflowRuns.update(`r-${role}-${status}`, { status });
          expect(await candidateIds()).toEqual([]);
          expect(await storage.agentSessions.deleteIfExpired("participant", cutoff)).toBe(false);
        });
      }
    }

    for (const status of ["completed", "cancelled", "failed"] as WorkflowRunStatus[]) {
      it(`allows deletion once the run is ${status}`, async () => {
        await createExpired("participant");
        await storage.workflowRuns.create({
          id: "r1", project_id: "p1", branch: "dev", source_session_id: "participant",
          source_turn_end_index: 1, review_focus: null, review_target: null,
        });
        expect(await candidateIds()).toEqual([]);
        await storage.workflowRuns.update("r1", { status });
        expect(await candidateIds()).toEqual(["participant"]);
        expect(await storage.agentSessions.deleteIfExpired("participant", cutoff)).toBe(true);
      });
    }
  });

  it("orders oldest first and caps the page", async () => {
    await createExpired("mid", 100);
    await createExpired("oldest", 300);
    await createExpired("newest", 91);
    expect(await candidateIds()).toEqual(["oldest", "mid", "newest"]);
    expect(await candidateIds(2)).toEqual(["oldest", "mid"]);
  });

  it("advances past a page via the keyset cursor, matching the sort exactly", async () => {
    await createExpired("a", 300);
    await createExpired("b", 200);
    await createExpired("c", 100);
    const first = await storage.agentSessions.listRetentionCandidates({ cutoff, limit: 1 });
    expect(first.map((c) => c.id)).toEqual(["a"]);
    const second = await storage.agentSessions.listRetentionCandidates({
      cutoff, limit: 10,
      after: { activityAt: first[0].activity_at, id: first[0].id },
    });
    expect(second.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("breaks activity_at ties by id so the cursor can never stall", async () => {
    await createExpired("s2");
    await createExpired("s1");
    const sameInstant = now - 100 * DAY;
    setActivityAt("s1", sameInstant);
    setActivityAt("s2", sameInstant);
    expect(await candidateIds()).toEqual(["s1", "s2"]);
    const after = await storage.agentSessions.listRetentionCandidates({
      cutoff, limit: 10, after: { activityAt: sameInstant, id: "s1" },
    });
    expect(after.map((c) => c.id)).toEqual(["s2"]);
  });

  it("cascades every child table with the parent row", async () => {
    await createExpired("old");
    await storage.agentSessions.upsertEntry("old", 0, JSON.stringify({ type: "user", content: "hi" }));
    await storage.agentSessions.setNativeSessionId("old", "native-1", "claude-code");
    await storage.turnSnapshots.create({ session_id: "old", turn_end_index: 0, head: "H", dirty: {} });
    await storage.agentInstructionDeliveries.claim({
      sessionId: "old", idempotencyKey: "k1", contentHash: "h1", claimToken: "t1",
    });

    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(true);

    const raw = new Database(dbPath);
    try {
      const count = (table: string) =>
        (raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = 'old'`).get() as { n: number }).n;
      expect(count("agent_session_entries")).toBe(0);
      expect(count("agent_session_native_ids")).toBe(0);
      expect(count("turn_snapshots")).toBe(0);
      expect(count("agent_instruction_deliveries")).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("deleteIfExpired is idempotent — a second call reports no deletion", async () => {
    await createExpired("old");
    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(true);
    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(false);
  });

  describe("remoteSessionMappings.delete", () => {
    const upsert = (local: string, remote: string) =>
      storage.remoteSessionMappings.upsert(local, "p1", "worker-1", remote, "dev");

    it("deletes unconditionally when no expectation is given", async () => {
      await upsert("remote-a", "ra");
      expect(await storage.remoteSessionMappings.delete("remote-a")).toBe(true);
      expect(await storage.remoteSessionMappings.getByLocal("remote-a")).toBeUndefined();
      expect(await storage.remoteSessionMappings.delete("remote-a")).toBe(false);
    });

    it("compares and deletes when an expectation is given", async () => {
      await upsert("remote-a", "ra");
      // Re-mapped to a different remote session since the caller observed it:
      // the delete must miss rather than take the fresh mapping down.
      await upsert("remote-a", "ra-v2");
      expect(await storage.remoteSessionMappings.delete("remote-a", {
        remoteServerId: "worker-1", remoteSessionId: "ra",
      })).toBe(false);
      expect((await storage.remoteSessionMappings.getByLocal("remote-a"))?.remote_session_id).toBe("ra-v2");

      expect(await storage.remoteSessionMappings.delete("remote-a", {
        remoteServerId: "worker-1", remoteSessionId: "ra-v2",
      })).toBe(true);
      expect(await storage.remoteSessionMappings.getByLocal("remote-a")).toBeUndefined();
    });
  });

  it("listIdsByProject returns every row, including sessions with no entries", async () => {
    await storage.agentSessions.create({ id: "with-entries", project_id: "p1", branch: "dev" });
    await storage.agentSessions.upsertEntry("with-entries", 0, "{}");
    await storage.agentSessions.create({ id: "brand-new", project_id: "p1", branch: "dev" });
    await storage.projects.create({ id: "p2", name: "p2", path: "/tmp/p2" });
    await storage.agentSessions.create({ id: "elsewhere", project_id: "p2", branch: "dev" });

    expect((await storage.agentSessions.listIdsByProject("p1")).sort())
      .toEqual(["brand-new", "with-entries"]);
  });
});
