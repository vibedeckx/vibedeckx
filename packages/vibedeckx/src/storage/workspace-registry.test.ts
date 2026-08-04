import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("workspace registry storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-workspace-registry-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project", path: "/repo" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records creating intent and promotes the logical workspace when checkout succeeds", async () => {
    const creating = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    expect(creating.workspace.status).toBe("creating");
    expect(creating.checkout.status).toBe("creating");

    await storage.workspaceRegistry.setCheckoutStatus(creating.workspace.id, "local", "ready");
    const ready = await storage.workspaceRegistry.getByProjectBranch("p1", "dev", "local");
    expect(ready?.workspace.status).toBe("ready");
    expect(ready?.checkout.status).toBe("ready");
  });

  it("keeps per-target failures without hiding a ready checkout", async () => {
    const local = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    const remote = await storage.workspaceRegistry.beginCheckout({
      projectId: "p1", branch: "dev", targetId: "remote-1",
      worktreePath: "/remote/dev", expectedBranch: "dev",
    });
    await storage.workspaceRegistry.setCheckoutStatus(remote.workspace.id, "remote-1", "error", "offline");

    const rows = await storage.workspaceRegistry.listByProject("p1");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.checkout.target_id === "remote-1")?.checkout.error).toBe("offline");
    expect(rows[0].workspace.id).toBe(local.workspace.id);
    expect(rows.every((row) => row.workspace.status === "ready")).toBe(true);
  });

  it("removes the logical workspace after its last checkout is removed", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    await storage.workspaceRegistry.removeCheckout(registered.workspace.id, "local");
    expect(await storage.workspaceRegistry.listByProject("p1")).toEqual([]);
  });

  it("registerReadyCheckout adopts an existing worktree idempotently", async () => {
    const first = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    const second = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "dev", targetId: "local",
      worktreePath: "/worktrees/dev", expectedBranch: "dev",
    });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.checkout.id).toBe(first.checkout.id);
    expect(await storage.workspaceRegistry.listByProject("p1", "local")).toHaveLength(1);
  });
});
