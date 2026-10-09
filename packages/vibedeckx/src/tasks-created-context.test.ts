import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { buildTasksCreatedContext, VTASKS_CREATED_BLOCK_RE } from "./tasks-created-context.js";

describe("buildTasksCreatedContext", () => {
  let storage: Storage;
  let dir: string;

  const propose = (id: string, sessionId: string, index: number, extra: { title?: string; parent_id?: string } = {}) =>
    storage.tasks.create({
      id,
      project_id: "project-1",
      title: extra.title ?? id,
      parent_id: extra.parent_id,
      source: { session_id: sessionId, tool_use_id: "tu-1", item_index: index },
    });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-tasks-created-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/mine" }, "user-1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the session's unreported proposed tasks with ids, once", async () => {
    await propose("goal", "s1", 0, { title: 'Ship "trees" <now>' });
    await propose("step", "s1", 1, { parent_id: "goal" });
    await propose("elsewhere", "s2", 0);
    await storage.tasks.create({ id: "manual", project_id: "project-1", title: "Manual" });

    const context = await buildTasksCreatedContext(storage, "s1", "user-1");
    expect(context?.ids).toEqual(["goal", "step"]);
    expect(context?.block).toContain('<task id="goal" title="Ship &quot;trees&quot; &lt;now&gt;" />');
    expect(context?.block).toContain('<task id="step" title="step" parent_id="goal" />');
    expect("before\n\n" + context!.block).toMatch(VTASKS_CREATED_BLOCK_RE);

    await storage.tasks.markSourceReported(context!.ids);
    expect(await buildTasksCreatedContext(storage, "s1", "user-1")).toBeNull();
  });

  it("leaves out tasks in a project the caller can't see", async () => {
    await propose("goal", "s1", 0);
    expect(await buildTasksCreatedContext(storage, "s1", "user-2")).toBeNull();
  });
});
