import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createServer } from "./server.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";

describe("project chat server registration", () => {
  let storage: Storage;
  let closeServer: () => Promise<void>;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-server-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Local", path: "/tmp/local" });
    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    closeServer = server.close;
  }, 30_000);

  afterAll(async () => {
    await closeServer?.();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes project chat routes through createServer", async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/project-chat/threads`, {
      method: "POST",
    });

    expect(response.status).toBe(201);
  });
});
