import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

import processRoutes from "./process-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import { resolveWorktreePath } from "../utils/worktree-paths.js";
import type { Storage } from "../storage/types.js";

/**
 * An executor belongs to exactly one workspace, and completion is attributed
 * through that binding. The working directory therefore has to come from the
 * same place — not from the request, which can name any branch at all.
 */
describe("POST /api/executors/:id/start — workspace-derived working directory", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const start = vi.fn(async () => "process-1");

  const registerWorkspace = async (branch: string) => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "project-1", branch, targetId: "local",
      worktreePath: `/repo-${branch || "main"}`, expectedBranch: branch,
    });
    return registered.workspace.id;
  };

  beforeEach(async () => {
    auth.userId = "user-1";
    start.mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-start-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "p", path: "/repo" }, "user-1");

    const featWorkspaceId = await registerWorkspace("feat");
    await storage.executors.create({
      id: "e-feat", project_id: "project-1", workspace_id: featWorkspaceId,
      name: "dev", command: "npm run dev",
    });

    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("processManager", { start, get: vi.fn(), stop: vi.fn(), getRunningProcessIds: vi.fn(() => []), getProcessProjectId: vi.fn(() => null) });
    app.decorate("reverseConnectManager", { isConnected: () => false, getMachineId: () => null });
    app.decorate("remoteExecutorMap", new Map());
    app.decorate("remoteExecutorMonitor", { watch: vi.fn() });
    app.decorate("eventBus", { emit: vi.fn() });
    await app.register(processRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs in the executor's own workspace worktree", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/executors/e-feat/start", payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-feat" }),
      resolveWorktreePath("/repo", "feat"),
    );
  });

  it("ignores a branch in the request body naming another workspace", async () => {
    await registerWorkspace("");

    const response = await app.inject({
      method: "POST", url: "/api/executors/e-feat/start", payload: { branch: null },
    });

    expect(response.statusCode).toBe(200);
    // null would resolve to the main worktree (/repo) if the body were trusted.
    expect(start).toHaveBeenCalledWith(expect.anything(), resolveWorktreePath("/repo", "feat"));
    expect(start).not.toHaveBeenCalledWith(expect.anything(), "/repo");
  });
});
