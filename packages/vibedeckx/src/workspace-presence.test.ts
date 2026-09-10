import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { conventionalWorktreePath } from "./utils/worktree-paths.js";
import { findWorkspaceMissingOnRemote } from "./workspace-presence.js";

describe("findWorkspaceMissingOnRemote", () => {
  let dir: string;
  let storage: Storage;
  let serverId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-presence-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: null });
    serverId = (await storage.remoteServers.create({ name: "worker3" })).id;
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/srv/repo" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const missing = (branch: string | null) =>
    findWorkspaceMissingOnRemote(storage, { projectId: "p1", remoteServerId: serverId, branch });

  it("names the remote when its full list has been seen and holds no row for the branch", async () => {
    await storage.projectRemotes.markWorktreesSynced("p1", serverId);
    expect(await missing("dev")).toEqual({ serverId, name: "worker3", branch: "dev" });
  });

  it("lets a never-listed remote through: no row is no evidence", async () => {
    expect(await missing("dev")).toBeNull();
  });

  it("lets any live row through, whatever its status, and never blocks the main workspace", async () => {
    await storage.projectRemotes.markWorktreesSynced("p1", serverId);
    await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: serverId,
      worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
    });
    expect(await missing("dev")).toBeNull();
    expect(await missing(null)).toBeNull();
  });

  it("treats a tombstoned branch as missing even on a never-listed remote", async () => {
    const gone = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: serverId,
      worktreePath: conventionalWorktreePath("/srv/repo", "dev"), expectedBranch: "dev",
    });
    await storage.workspaceRegistry.markCheckoutDeleted(gone.checkout.id);
    expect(await missing("dev")).toMatchObject({ branch: "dev" });
  });

  it("says nothing about a remote the project does not have", async () => {
    expect(await findWorkspaceMissingOnRemote(storage, { projectId: "p1", remoteServerId: "gone", branch: "dev" })).toBeNull();
  });
});
