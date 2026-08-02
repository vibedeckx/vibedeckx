import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/fastify", () => ({ getAuth: () => ({ userId: null }), clerkClient: {} }));

import terminalRoutes from "./terminal-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

/**
 * `/api/path/terminals` is the provider-side spawn endpoint the front server
 * calls over the reverse-connect tunnel. The terminal it registers must be
 * owned by a real project row — the same `path:<projectPath>` pseudo project
 * agent sessions use — so that per-process authorization can resolve an owner.
 */
describe("POST /api/path/terminals project ownership", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const startTerminal = vi.fn(() => ({ id: "terminal-1", name: "Terminal 1" }));

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-path-terminal-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    app.decorate("processManager", { startTerminal, sendToTerminal: vi.fn(), getTerminalProjectId: vi.fn() } as never);
    app.decorate("remoteExecutorMap", new Map());
    app.decorate("reverseConnectManager", { isConnected: () => false, getMachineId: () => null } as never);
    await app.register(terminalRoutes);
  });

  afterEach(async () => {
    startTerminal.mockClear();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the terminal under a project row that exists", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/path/terminals", payload: { path: "/repo" },
    });

    expect(response.statusCode).toBe(201);
    const [projectId, cwd] = startTerminal.mock.calls[0] as unknown as [string, string];
    expect(cwd).toBe("/repo");
    expect(await storage.projects.getById(projectId)).toMatchObject({ path: "/repo" });
  });

  it("reuses the project already registered for that path", async () => {
    await storage.projects.create({ id: "existing", name: "repo", path: "/repo" });

    await app.inject({ method: "POST", url: "/api/path/terminals", payload: { path: "/repo" } });

    expect(startTerminal.mock.calls[0][0]).toBe("existing");
  });
});
