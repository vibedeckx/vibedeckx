import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("agent instruction delivery claims", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-instruction-delivery-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "One", path: "/tmp/one" });
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("claims once, rejects hash reuse, supports restart takeover, and replays sent", async () => {
    const input = { sessionId: "s1", idempotencyKey: "delivery-1", contentHash: "hash-a" };

    await expect(storage.agentInstructionDeliveries.claim({ ...input, claimToken: "instance-a" }))
      .resolves.toBe("claimed");
    await expect(storage.agentInstructionDeliveries.claim({ ...input, claimToken: "instance-a" }))
      .resolves.toBe("busy");
    await expect(storage.agentInstructionDeliveries.claim({ ...input, contentHash: "hash-b", claimToken: "instance-a" }))
      .resolves.toBe("conflict");
    await storage.close();
    storage = await createSqliteStorage(dbPath);
    await expect(storage.agentInstructionDeliveries.claim({ ...input, claimToken: "instance-b" }))
      .resolves.toBe("claimed");
    await expect(storage.agentInstructionDeliveries.markSent({
      sessionId: "s1", idempotencyKey: "delivery-1", claimToken: "instance-b",
    })).resolves.toBe(true);
    await expect(storage.agentInstructionDeliveries.claim({ ...input, claimToken: "instance-c" }))
      .resolves.toBe("sent");
  });

  it("releases a failed claim so the same instance can retry", async () => {
    const input = {
      sessionId: "s1", idempotencyKey: "delivery-2", contentHash: "hash-a", claimToken: "instance-a",
    };
    await expect(storage.agentInstructionDeliveries.claim(input)).resolves.toBe("claimed");
    await storage.agentInstructionDeliveries.release(input);
    await expect(storage.agentInstructionDeliveries.claim(input)).resolves.toBe("claimed");
  });
});
