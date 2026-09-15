import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  // What this feeds: the machine an artifact path in a conversation might live
  // on (artifact-read-targets.ts). A refused call never ran anywhere, so the
  // machine it aimed at is not a place this session could have written a file.
  it("lists a session's machines newest-first, and only ones a call reached", async () => {
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-b" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-c", status: "timeout" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-b", status: "error" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "refused", status: "denied" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "unreachable", status: "offline" }));
    await storage.crossRemoteAudit.insert(entry({ session_id: "sess-2", target_remote_id: "other-session" }));

    // srv-b is last-used, so it leads; denied/offline targets never appear.
    expect(await storage.crossRemoteAudit.listSessionTargets("sess-1")).toEqual(["srv-b", "srv-c"]);
  });

  it("scopes a session's machines to the user, and honours the limit", async () => {
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-b" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-c" }));
    await storage.crossRemoteAudit.insert(entry({ user_id: "user-2", target_remote_id: "theirs" }));

    expect(await storage.crossRemoteAudit.listSessionTargets("sess-1", "user-1")).toEqual(["srv-c", "srv-b"]);
    expect(await storage.crossRemoteAudit.listSessionTargets("sess-1", "user-2")).toEqual(["theirs"]);
    expect(await storage.crossRemoteAudit.listSessionTargets("sess-1", "user-1", 1)).toEqual(["srv-c"]);
  });

  it("filters by target and returns newest first, honouring the limit", async () => {
    await storage.crossRemoteAudit.insert(entry({ args_summary: "first" }));
    await storage.crossRemoteAudit.insert(entry({ args_summary: "second" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-c", args_summary: "other-target" }));

    const rows = await storage.crossRemoteAudit.listByTarget("srv-b", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].args_summary).toBe("second");
  });
});
