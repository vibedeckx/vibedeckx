import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  formatBackfillSummary,
  healWorkspaceBindings,
  runWorkspaceBindingBackfill,
} from "./workspace-binding-backfill.js";

describe("self-healing workspace binding backfill", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-heal-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: null });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers worker-reported checkouts and binds the legacy mappings they explain", async () => {
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remote.id, remote_path: "/repo",
    });
    await storage.remoteSessionMappings.upsert("legacy-main", "p1", remote.id, "worker-main", null);
    await storage.remoteSessionMappings.upsert("legacy-dev", "p1", remote.id, "worker-dev", "dev");

    const result = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({
        ok: true,
        data: {
          worktrees: [
            { branch: null, worktreePath: "/repo" },
            { branch: "dev", worktreePath: "/repo-worktrees/dev" },
          ],
        },
      }),
    });

    expect(result.remote.updated).toBe(2);
    // The main workspace round-trips through the '' sentinel, which the raw
    // join would otherwise miss for a NULL-branch mapping.
    expect((await storage.remoteSessionMappings.getByLocal("legacy-main"))?.workspace_checkout_id)
      .toBe((await storage.workspaceRegistry.getByProjectBranch("p1", "", remote.id))?.checkout.id);
    expect((await storage.remoteSessionMappings.getByLocal("legacy-dev"))?.workspace_checkout_id)
      .toBe((await storage.workspaceRegistry.getByProjectBranch("p1", "dev", remote.id))?.checkout.id);
    expect(await storage.remoteSessionMappings.getByLocal("legacy-dev"))
      .toMatchObject({ remote_session_id: "worker-dev" });
  });

  it("leaves an offline remote untouched and heals it on the next pass", async () => {
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: remote.id, remote_path: "/repo",
    });
    await storage.remoteSessionMappings.upsert("offline", "p1", remote.id, "worker-x", "dev");

    const offline = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({ ok: false, data: { error: "not connected" } }),
    });
    expect(offline.remote.updated).toBe(0);
    expect((await storage.remoteSessionMappings.getByLocal("offline"))?.workspace_checkout_id).toBeNull();

    const online = await healWorkspaceBindings(storage, {
      listRemoteWorktrees: async () => ({
        ok: true, data: { worktrees: [{ branch: "dev", worktreePath: "/repo-worktrees/dev" }] },
      }),
    });
    expect(online.remote.updated).toBe(1);
  });

  it("never guesses an ambiguous incarnation and reports it instead", async () => {
    const first = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "rebuilt", targetId: "local",
      worktreePath: "/tmp/old", expectedBranch: "rebuilt",
    });
    await storage.workspaceRegistry.markCheckoutDeleted(first.checkout.id);
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "rebuilt", targetId: "local",
      worktreePath: "/tmp/new", expectedBranch: "rebuilt",
    });
    await storage.agentSessions.create({ id: "ambiguous", project_id: "p1", branch: "rebuilt" });

    const summary = await runWorkspaceBindingBackfill(storage, "local");

    expect(summary.updated).toBe(0);
    expect(summary.reasons.multiple_incarnations).toBe(1);
    expect((await storage.agentSessions.getById("ambiguous"))?.workspace_checkout_id).toBeNull();
  });

  it("stops on the time budget and resumes from the untouched rows next run", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/tmp/dev", expectedBranch: "dev",
    });
    for (let index = 0; index < 4; index += 1) {
      await storage.agentSessions.create({ id: `s${index}`, project_id: "p1", branch: "dev" });
    }
    let clock = 0;

    const bounded = await runWorkspaceBindingBackfill(storage, "local", {
      batchSize: 1, budgetMs: 1, now: () => (clock += 1),
    });
    expect(bounded.incomplete).toBe(true);
    expect(bounded.updated).toBe(1);

    const rest = await runWorkspaceBindingBackfill(storage, "local");
    expect(rest.incomplete).toBe(false);
    expect(rest.updated).toBe(3);
    for (let index = 0; index < 4; index += 1) {
      expect((await storage.agentSessions.getById(`s${index}`))?.workspace_checkout_id)
        .toBe(registered.checkout.id);
    }
    expect((await runWorkspaceBindingBackfill(storage, "local")).updated).toBe(0);
  });

  it("stays silent and does no registry work when every row is already bound", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/tmp/dev", expectedBranch: "dev",
    });
    await storage.agentSessions.createBound({
      id: "bound", project_id: "p1", branch: "dev", target_id: "local",
      checkout_id: registered.checkout.id,
    });
    const listRemoteWorktrees = vi.fn(async () => ({ ok: true, data: { worktrees: [] } }));

    const quiet = await healWorkspaceBindings(storage, { listRemoteWorktrees });

    expect(formatBackfillSummary("startup", quiet)).toBeNull();
    // Steady state must not shell out to git or the tunnel on every startup.
    expect(listRemoteWorktrees).not.toHaveBeenCalled();
  });

  it("heals a worker, whose projects are all path pseudo projects", async () => {
    // A worker never has anything else: `/api/path/agent-sessions*` creates a
    // `path:` row per workspace. Sourcing the sweep from the user-facing
    // project list would silently skip every one of them.
    const repo = mkdtempSync(path.join(tmpdir(), "vdx-worker-project-"));
    try {
      await storage.projects.create({ id: `path:${repo}`, name: "repo", path: repo });
      await storage.agentSessions.create({ id: "legacy", project_id: `path:${repo}`, branch: "" });

      const result = await healWorkspaceBindings(storage);

      expect(result.local.updated).toBe(1);
      const bound = await storage.agentSessions.getById("legacy");
      const checkout = await storage.workspaceRegistry.getByProjectBranch(`path:${repo}`, "", "local");
      expect(bound?.workspace_checkout_id).toBe(checkout?.checkout.id);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a project whose local path disappeared from failing the whole sweep", async () => {
    await storage.projects.create({ id: "gone", name: "gone", path: "/tmp/vdx-not-a-repo" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(healWorkspaceBindings(storage)).resolves.toMatchObject({
        local: { updated: 0 },
      });
    } finally {
      warn.mockRestore();
    }
  });
});
