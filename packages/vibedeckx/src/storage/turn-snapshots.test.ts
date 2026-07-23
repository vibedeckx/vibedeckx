import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("turnSnapshots repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-snap-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.agentSessions.create({
      id: "s1", project_id: "p1", branch: "dev",
      permission_mode: "edit", agent_type: "claude-code",
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and round-trips the dirty map", async () => {
    await storage.turnSnapshots.create({
      session_id: "s1", turn_end_index: -1, head: "AAA",
      dirty: { "a.ts": "sha-a", "gone.ts": "absent" },
    });
    const snap = await storage.turnSnapshots.getStartBoundary("s1", 5);
    expect(snap).toEqual({ head: "AAA", dirty: { "a.ts": "sha-a", "gone.ts": "absent" } });
  });

  it("getStartBoundary returns the largest index strictly below the argument", async () => {
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: -1, head: "H0", dirty: {} });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 7, head: "H7", dirty: {} });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 12, head: "H12", dirty: {} });
    expect((await storage.turnSnapshots.getStartBoundary("s1", 12))?.head).toBe("H7");
    expect((await storage.turnSnapshots.getStartBoundary("s1", 7))?.head).toBe("H0");
    expect(await storage.turnSnapshots.getStartBoundary("s1", -1)).toBeUndefined();
  });
});
