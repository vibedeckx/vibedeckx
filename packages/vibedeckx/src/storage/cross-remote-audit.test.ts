import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage, CrossRemoteAuditEntry } from "./types.js";

const entry = (over: Partial<CrossRemoteAuditEntry> = {}): CrossRemoteAuditEntry => ({
  user_id: "user-1",
  session_id: "sess-1",
  source_remote_id: "srv-a",
  target_remote_id: "srv-b",
  tool_name: "remote_bash",
  args_summary: "uptime",
  exit_code: 0,
  duration_ms: 12,
  status: "ok",
  ...over,
});

describe("crossRemoteAudit storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xraudit-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and reads back an entry", async () => {
    await storage.crossRemoteAudit.insert(entry());
    const rows = await storage.crossRemoteAudit.listByTarget("srv-b");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      tool_name: "remote_bash",
      args_summary: "uptime",
      exit_code: 0,
      status: "ok",
    });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].created_at).toBeTruthy();
  });

  it("records denied calls with a null exit code and no source remote", async () => {
    await storage.crossRemoteAudit.insert(entry({ status: "denied", exit_code: null, source_remote_id: null }));
    const rows = await storage.crossRemoteAudit.listByTarget("srv-b");
    expect(rows[0].status).toBe("denied");
    expect(rows[0].exit_code).toBeNull();
    expect(rows[0].source_remote_id).toBeNull();
  });

  it("filters by target and returns newest first, honouring the limit", async () => {
    await storage.crossRemoteAudit.insert(entry({ args_summary: "first" }));
    await storage.crossRemoteAudit.insert(entry({ args_summary: "second" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-c", args_summary: "other-target" }));

    const rows = await storage.crossRemoteAudit.listByTarget("srv-b", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].args_summary).toBe("second");
  });

  describe("pruneBefore", () => {
    afterEach(() => { vi.useRealTimers(); });

    const insertAt = async (iso: string, args_summary: string) => {
      vi.setSystemTime(new Date(iso));
      await storage.crossRemoteAudit.insert(entry({ args_summary }));
    };
    const remaining = async () =>
      (await storage.crossRemoteAudit.listByTarget("srv-b")).map((r) => r.args_summary).reverse();

    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });

    it("deletes only rows older than the cutoff, in batches", async () => {
      await insertAt("2026-01-01T00:00:00Z", "old-1");
      await insertAt("2026-01-02T00:00:00Z", "old-2");
      await insertAt("2026-01-03T00:00:00Z", "old-3");
      await insertAt("2026-03-01T00:00:00Z", "new");
      const cutoff = new Date("2026-02-01T00:00:00Z");

      // A full batch tells the caller to come back for more…
      expect(await storage.crossRemoteAudit.pruneBefore(cutoff, 2)).toBe(2);
      expect(await remaining()).toEqual(["old-3", "new"]);
      // …a short one says the backlog is gone.
      expect(await storage.crossRemoteAudit.pruneBefore(cutoff, 2)).toBe(1);
      expect(await storage.crossRemoteAudit.pruneBefore(cutoff, 2)).toBe(0);
      expect(await remaining()).toEqual(["new"]);
    });

    it("empties a table in which every row is past the window", async () => {
      await insertAt("2026-01-01T00:00:00Z", "a");
      await insertAt("2026-01-02T00:00:00Z", "b");
      expect(await storage.crossRemoteAudit.pruneBefore(new Date("2026-06-01T00:00:00Z"), 10)).toBe(2);
      expect(await remaining()).toEqual([]);
    });
  });
});
