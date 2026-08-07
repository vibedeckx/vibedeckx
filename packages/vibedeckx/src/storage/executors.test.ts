import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("executors/executorProcesses/remoteExecutorProcesses storage", () => {
  let dir: string;
  let storage: Storage;
  let w1: string;

  const registerWorkspace = async (projectId: string, branch: string) => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId, branch, targetId: "local",
      worktreePath: `/tmp/${projectId}-${branch || "main"}`, expectedBranch: branch,
    });
    return registered.workspace.id;
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    // executors.workspace_id is a real FK now, so the owning workspace has to
    // exist before any executor can reference it.
    w1 = await registerWorkspace("p1", "main");
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("executors", () => {
    it("create round-trip: pty boolean, disabled_targets JSON, defaults", async () => {
      const e = await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "run", command: "make" });
      expect(e.pty).toBe(true);
      expect(e.disabled_targets).toEqual([]);
      expect(e.executor_type).toBe("command");
      expect(e.prompt_provider).toBeNull();
      expect(e.cwd).toBeNull();
      expect(e.position).toBe(0);

      const u = await storage.executors.update("e1", { pty: false, disabled_targets: ["local", "srv-1"] });
      expect(u?.pty).toBe(false);
      expect(u?.disabled_targets).toEqual(["local", "srv-1"]);
    });

    it("create accepts explicit executor_type/prompt_provider/cwd/pty overrides", async () => {
      const e = await storage.executors.create({
        id: "e1", project_id: "p1", workspace_id: w1, name: "prompt-run", command: "n/a",
        executor_type: "prompt", prompt_provider: "codex", cwd: "/tmp/work", pty: false,
      });
      expect(e.executor_type).toBe("prompt");
      expect(e.prompt_provider).toBe("codex");
      expect(e.cwd).toBe("/tmp/work");
      expect(e.pty).toBe(false);
    });

    it("create assigns increasing positions per workspace, independent across workspaces", async () => {
      const e1 = await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      const e2 = await storage.executors.create({ id: "e2", project_id: "p1", workspace_id: w1, name: "b", command: "b" });
      const e3 = await storage.executors.create({ id: "e3", project_id: "p1", workspace_id: w1, name: "c", command: "c" });
      expect([e1.position, e2.position, e3.position]).toEqual([0, 1, 2]);

      const w2 = await registerWorkspace("p1", "other");
      const eOther = await storage.executors.create({ id: "e-other", project_id: "p1", workspace_id: w2, name: "x", command: "x" });
      expect(eOther.position).toBe(0); // independent counter for workspace w2
    });

    it("getByProjectId and getByWorkspaceId order by position ascending", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executors.create({ id: "e2", project_id: "p1", workspace_id: w1, name: "b", command: "b" });
      const byWorkspace = await storage.executors.getByWorkspaceId(w1);
      expect(byWorkspace.map((x) => x.id)).toEqual(["e1", "e2"]);
      const byProject = await storage.executors.getByProjectId("p1");
      expect(byProject.map((x) => x.id)).toEqual(["e1", "e2"]);
    });

    it("getById returns undefined for a missing executor", async () => {
      expect(await storage.executors.getById("nonexistent")).toBeUndefined();
    });

    it("update: partial field updates leave other fields untouched; no-op opts still returns current row", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "run", command: "make", cwd: "/tmp" });
      const u1 = await storage.executors.update("e1", { name: "renamed" });
      expect(u1?.name).toBe("renamed");
      expect(u1?.command).toBe("make");
      expect(u1?.cwd).toBe("/tmp");

      const u2 = await storage.executors.update("e1", {});
      expect(u2?.name).toBe("renamed");

      const u3 = await storage.executors.update("e1", { cwd: null, prompt_provider: null, executor_type: "prompt" });
      expect(u3?.cwd).toBeNull();
      expect(u3?.prompt_provider).toBeNull();
      expect(u3?.executor_type).toBe("prompt");

      expect(await storage.executors.update("nonexistent", { name: "x" })).toBeUndefined();
    });

    it("setTargetDisabled: add, add a second, remove one, remove-when-absent is a no-op", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "run", command: "make" });
      const added = await storage.executors.setTargetDisabled("e1", "local", true);
      expect(added?.disabled_targets).toEqual(["local"]);

      const added2 = await storage.executors.setTargetDisabled("e1", "srv-1", true);
      expect(added2?.disabled_targets.slice().sort()).toEqual(["local", "srv-1"]);

      const removed = await storage.executors.setTargetDisabled("e1", "local", false);
      expect(removed?.disabled_targets).toEqual(["srv-1"]);

      const noop = await storage.executors.setTargetDisabled("e1", "local", false);
      expect(noop?.disabled_targets).toEqual(["srv-1"]);
    });

    it("setTargetDisabled returns undefined for a nonexistent executor", async () => {
      expect(await storage.executors.setTargetDisabled("nonexistent", "local", true)).toBeUndefined();
    });

    it("setTargetDisabled: two concurrent toggles of DIFFERENT targets both land (no lost update)", async () => {
      // Regression test mirroring "settings.update: two concurrent
      // read-modify-writes both land" (projects.test.ts). setTargetDisabled's
      // atomicity (types.ts docstring) comes from a JS-side read-modify-write
      // of the disabled_targets JSON Set inside one storage call, wrapped in
      // a transaction in the Kysely port — without it, two concurrent
      // Kysely-awaited calls could interleave read->read->write->write and
      // silently drop one toggle.
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "run", command: "make" });
      await Promise.all([
        storage.executors.setTargetDisabled("e1", "local", true),
        storage.executors.setTargetDisabled("e1", "srv-1", true),
      ]);
      const final = await storage.executors.getById("e1");
      expect(final?.disabled_targets.slice().sort()).toEqual(["local", "srv-1"]);
    });

    it("delete removes the executor", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "run", command: "make" });
      await storage.executors.delete("e1");
      expect(await storage.executors.getById("e1")).toBeUndefined();
    });

    it("reorder persists positions in the given order", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executors.create({ id: "e2", project_id: "p1", workspace_id: w1, name: "b", command: "b" });
      await storage.executors.reorder(w1, ["e2", "e1"]);
      const list = await storage.executors.getByWorkspaceId(w1);
      expect(list.map((x) => x.id)).toEqual(["e2", "e1"]);
      expect(list.map((x) => x.position)).toEqual([0, 1]);
    });
  });

  describe("executorProcesses", () => {
    it("create defaults: status running, pid/exit_code/finished_at null unless given", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      const p = await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      expect(p.status).toBe("running");
      expect(p.pid).toBeNull();
      expect(p.exit_code).toBeNull();
      expect(p.finished_at).toBeNull();

      const withPid = await storage.executorProcesses.create({ id: "pr2", executor_id: "e1", pid: 4242 });
      expect(withPid.pid).toBe(4242);
    });

    it("getById / getRunning", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.create({ id: "pr2", executor_id: "e1" });
      await storage.executorProcesses.updateStatus("pr1", "completed", 0);

      expect((await storage.executorProcesses.getById("pr2"))?.status).toBe("running");
      const running = await storage.executorProcesses.getRunning();
      expect(running.map((r) => r.id)).toEqual(["pr2"]);
    });

    it("getLastByExecutorId returns the single row for that executor", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      expect((await storage.executorProcesses.getLastByExecutorId("e1"))?.id).toBe("pr1");
      expect(await storage.executorProcesses.getLastByExecutorId("no-such-executor")).toBeUndefined();
    });

    it("getLastByExecutorIds: empty input short-circuits to []", async () => {
      expect(await storage.executorProcesses.getLastByExecutorIds([])).toEqual([]);
    });

    it("getLastByExecutorIds returns at most one row per executor", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executors.create({ id: "e2", project_id: "p1", workspace_id: w1, name: "b", command: "b" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.updateStatus("pr1", "completed", 0);
      await storage.executorProcesses.create({ id: "pr2", executor_id: "e1" });
      await storage.executorProcesses.create({ id: "pr3", executor_id: "e2" });

      const last = await storage.executorProcesses.getLastByExecutorIds(["e1", "e2", "no-such-executor"]);
      expect(last).toHaveLength(2);
      const byExecutor = Object.fromEntries(last.map((r) => [r.executor_id, r.id]));
      // e2 has only one row, unambiguous.
      expect(byExecutor.e2).toBe("pr3");
      // e1 has two rows created back-to-back with second-resolution
      // started_at timestamps that usually tie in a fast test run. The
      // underlying SQL (`ROW_NUMBER() OVER (PARTITION BY executor_id ORDER
      // BY started_at DESC)`, no secondary tiebreak column) resolves ties by
      // SQLite's internal stable-sort scan order, which in this environment
      // consistently keeps the FIRST-inserted row on top of a tie (pr1, not
      // the newer pr2) — a real, if surprising, current-behavior quirk this
      // characterization test locks in. See the follow-up test below for the
      // (unambiguous) case where started_at genuinely differs.
      expect(byExecutor.e1).toBe("pr1");
    });

    it("getLastByExecutorIds picks the genuinely newest row once started_at no longer ties", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.updateStatus("pr1", "completed", 0);
      // started_at has second-level resolution; wait past the boundary so
      // pr2 gets a strictly later timestamp and the "most recent" semantics
      // (rather than the tie-break quirk above) is what's under test.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await storage.executorProcesses.create({ id: "pr2", executor_id: "e1" });

      const last = await storage.executorProcesses.getLastByExecutorIds(["e1"]);
      expect(last).toHaveLength(1);
      expect(last[0].id).toBe("pr2");
    }, 10000);

    it("updateStatus sets exit_code and finished_at when leaving 'running'; clears finished_at going back to running", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.updateStatus("pr1", "failed", 17);
      const failed = await storage.executorProcesses.getById("pr1");
      expect(failed?.status).toBe("failed");
      expect(failed?.exit_code).toBe(17);
      expect(failed?.finished_at).not.toBeNull();

      await storage.executorProcesses.updateStatus("pr1", "running");
      const runningAgain = await storage.executorProcesses.getById("pr1");
      expect(runningAgain?.status).toBe("running");
      expect(runningAgain?.finished_at).toBeNull();
    });

    it("updatePid updates the pid", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.updatePid("pr1", 999);
      expect((await storage.executorProcesses.getById("pr1"))?.pid).toBe(999);
    });

    it("markKilledIfRunning: kills a running process; is a no-op on an already-finished one", async () => {
      await storage.executors.create({ id: "e1", project_id: "p1", workspace_id: w1, name: "a", command: "a" });
      await storage.executorProcesses.create({ id: "pr1", executor_id: "e1" });
      await storage.executorProcesses.create({ id: "pr2", executor_id: "e1" });
      await storage.executorProcesses.updateStatus("pr2", "completed", 5);

      await storage.executorProcesses.markKilledIfRunning("pr1");
      const killed = await storage.executorProcesses.getById("pr1");
      expect(killed?.status).toBe("killed");
      expect(killed?.exit_code).toBeNull();
      expect(killed?.finished_at).not.toBeNull();

      // Guarded by `WHERE status = 'running'` — a concurrent completion must
      // not be clobbered by a stale kill.
      await storage.executorProcesses.markKilledIfRunning("pr2");
      const stillCompleted = await storage.executorProcesses.getById("pr2");
      expect(stillCompleted?.status).toBe("completed");
      expect(stillCompleted?.exit_code).toBe(5);
    });
  });

  describe("remoteExecutorProcesses", () => {
    it("insert defaults: status running, exit_code/finished_at/machine_id/project_id/branch null unless given", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
      });
      const row = await storage.remoteExecutorProcesses.getById("lp1");
      expect(row?.status).toBe("running");
      expect(row?.exit_code).toBeNull();
      expect(row?.finished_at).toBeNull();
      expect(row?.machine_id).toBeNull();
      expect(row?.project_id).toBeNull();
      expect(row?.branch).toBeNull();
    });

    it("insert accepts optional projectId/branch/machineId", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
        projectId: "p1", branch: "main", machineId: "m1",
      });
      const row = await storage.remoteExecutorProcesses.getById("lp1");
      expect(row?.project_id).toBe("p1");
      expect(row?.branch).toBe("main");
      expect(row?.machine_id).toBe("m1");
    });

    it("insert is INSERT OR REPLACE: re-inserting the same local_process_id resets status/exit_code/finished_at", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.markFinished("lp1", 3);
      const finished = await storage.remoteExecutorProcesses.getById("lp1");
      expect(finished?.status).toBe("failed");
      expect(finished?.exit_code).toBe(3);
      expect(finished?.finished_at).not.toBeNull();

      // Re-insert with the same PK — REPLACE semantics mean the whole row is
      // re-created, so status/exit_code/finished_at fall back to their
      // fresh-row values (running/null/null) rather than being preserved.
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp2", executorId: "e-x",
      });
      const replaced = await storage.remoteExecutorProcesses.getById("lp1");
      expect(replaced?.status).toBe("running");
      expect(replaced?.exit_code).toBeNull();
      expect(replaced?.finished_at).toBeNull();
      // The legacy direct-URL columns still exist in SQLite (NOT NULL, written
      // as "") but must never surface on the mapped row.
      expect(replaced).not.toHaveProperty("remote_url");
      expect(replaced).not.toHaveProperty("remote_api_key");
      expect(replaced?.remote_process_id).toBe("rp2");
    });

    it("delete hard-removes the row", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.delete("lp1");
      expect(await storage.remoteExecutorProcesses.getById("lp1")).toBeUndefined();
    });

    it("markFinished: default finalStatus is 'completed' for exitCode undefined/0, 'failed' otherwise; explicit status overrides; getRunning excludes it", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
      });
      expect(await storage.remoteExecutorProcesses.getRunning()).toHaveLength(1);
      await storage.remoteExecutorProcesses.markFinished("lp1", 0);
      expect((await storage.remoteExecutorProcesses.getById("lp1"))?.status).toBe("completed");
      expect(await storage.remoteExecutorProcesses.getRunning()).toHaveLength(0);

      await storage.remoteExecutorProcesses.insert("lp2", {
        remoteServerId: "rs1",
        remoteProcessId: "rp2", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.markFinished("lp2", 1);
      expect((await storage.remoteExecutorProcesses.getById("lp2"))?.status).toBe("failed");

      await storage.remoteExecutorProcesses.insert("lp3", {
        remoteServerId: "rs1",
        remoteProcessId: "rp3", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.markFinished("lp3", undefined, "killed");
      expect((await storage.remoteExecutorProcesses.getById("lp3"))?.status).toBe("killed");
    });

    it("markFinished is guarded by status='running' — a no-op on an already-finished row", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1",
        remoteProcessId: "rp1", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.markFinished("lp1", 0);
      await storage.remoteExecutorProcesses.markFinished("lp1", 99); // no-op, already 'completed'
      const row = await storage.remoteExecutorProcesses.getById("lp1");
      expect(row?.status).toBe("completed");
      expect(row?.exit_code).toBe(0);
    });

    it("getLastByExecutorId returns undefined for a falsy executorId, and for one with no rows", async () => {
      expect(await storage.remoteExecutorProcesses.getLastByExecutorId("")).toBeUndefined();
      expect(await storage.remoteExecutorProcesses.getLastByExecutorId("no-rows")).toBeUndefined();
    });

    it("getLastByExecutorIdsGroupedByServer: empty input short-circuits to []", async () => {
      expect(await storage.remoteExecutorProcesses.getLastByExecutorIdsGroupedByServer([])).toEqual([]);
    });

    it("getLastByExecutorIdsGroupedByServer returns one row per (executor, server) pair across the given executors", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1", remoteProcessId: "rp1", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.insert("lp2", {
        remoteServerId: "rs2", remoteProcessId: "rp2", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.insert("lp3", {
        remoteServerId: "rs1", remoteProcessId: "rp3", executorId: "e-y",
      });

      const grouped = await storage.remoteExecutorProcesses.getLastByExecutorIdsGroupedByServer(["e-x", "e-y", "no-such"]);
      expect(grouped).toHaveLength(3);
      const pairs = grouped.map((r) => `${r.executor_id}:${r.remote_server_id}`).sort();
      expect(pairs).toEqual(["e-x:rs1", "e-x:rs2", "e-y:rs1"]);
    });

    it("getRunningByMachine filters by status='running' AND machine_id", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1", remoteProcessId: "rp1", executorId: "e-x", machineId: "m1",
      });
      await storage.remoteExecutorProcesses.insert("lp2", {
        remoteServerId: "rs1", remoteProcessId: "rp2", executorId: "e-x", machineId: "m2",
      });
      await storage.remoteExecutorProcesses.markFinished("lp2", 0);

      expect((await storage.remoteExecutorProcesses.getRunningByMachine("m1")).map((r) => r.local_process_id)).toEqual(["lp1"]);
      expect(await storage.remoteExecutorProcesses.getRunningByMachine("m2")).toEqual([]); // finished, excluded
      expect(await storage.remoteExecutorProcesses.getRunningByMachine("no-such-machine")).toEqual([]);
    });

    it("getAll returns every row regardless of status", async () => {
      await storage.remoteExecutorProcesses.insert("lp1", {
        remoteServerId: "rs1", remoteProcessId: "rp1", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.insert("lp2", {
        remoteServerId: "rs1", remoteProcessId: "rp2", executorId: "e-x",
      });
      await storage.remoteExecutorProcesses.markFinished("lp2", 0);
      const all = await storage.remoteExecutorProcesses.getAll();
      expect(all.map((r) => r.local_process_id).sort()).toEqual(["lp1", "lp2"]);
    });
  });
});
