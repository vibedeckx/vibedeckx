import { describe, it, expect } from "vitest";
import { descriptionPreview, orderAsTree, selfAndDescendantIds, subtaskProgress, taskFileBranch } from "./task-utils";

describe("taskFileBranch", () => {
  const source = (branch: string | null) => ({ id: "s", title: null, branch, exists: true });

  it("uses the source session's workspace, null meaning main", () => {
    expect(taskFileBranch({ source_session: source("feat") })).toBe("feat");
    expect(taskFileBranch({ source_session: source(null) })).toBeNull();
  });

  it("falls back to main without a source session", () => {
    expect(taskFileBranch({ source_session: null })).toBeNull();
    expect(taskFileBranch({})).toBeNull();
  });

  it("ignores assigned_branch", () => {
    expect(taskFileBranch({ source_session: source("feat"), assigned_branch: "other" } as never)).toBe("feat");
    expect(taskFileBranch({ source_session: null, assigned_branch: "other" } as never)).toBeNull();
  });
});

describe("descriptionPreview", () => {
  it("collapses links to their labels", () => {
    expect(descriptionPreview("参考 [设计文档](docs/x.md) 第 3 节")).toBe("参考 设计文档 第 3 节");
  });

  it("cleans before truncating, so a link is never cut in half", () => {
    const label = "a".repeat(70);
    expect(descriptionPreview(`${label} [b](${"p/".repeat(40)}x.md) tail`)).toBe(`${label} b tail`);
    expect(descriptionPreview("x".repeat(90))).toBe("x".repeat(80) + "...");
  });
});

describe("task tree helpers", () => {
  const t = (id: string, parent_id: string | null = null, status = "todo", archived_at: number | null = null) =>
    ({ id, parent_id, status, archived_at }) as never as { id: string; parent_id: string | null; status: "todo"; archived_at: number | null };

  it("orders parents before their sub-tasks, keeping sibling order", () => {
    const rows = orderAsTree([t("b1", "b"), t("a"), t("b"), t("a1", "a"), t("b2", "b"), t("b1x", "b1")]);
    expect(rows.map((r) => `${r.task.id}:${r.depth}`)).toEqual(["a:0", "a1:1", "b:0", "b1:1", "b1x:2", "b2:1"]);
  });

  it("shows a task whose parent is not listed at the top level, and survives a cycle", () => {
    expect(orderAsTree([t("x", "gone")]).map((r) => r.depth)).toEqual([0]);
    expect(orderAsTree([t("p", "q"), t("q", "p")]).map((r) => r.task.id).sort()).toEqual(["p", "q"]);
  });

  it("collects a task and its descendants", () => {
    expect([...selfAndDescendantIds("a", [t("a1", "a"), t("a11", "a1"), t("b")])].sort()).toEqual(["a", "a1", "a11"]);
  });

  it("counts direct sub-tasks, leaving out cancelled and archived ones", () => {
    const tasks = [t("a1", "a", "done"), t("a2", "a"), t("a3", "a", "cancelled"), t("a4", "a", "done", 1), t("a11", "a1")];
    expect(subtaskProgress("a", tasks as never)).toEqual({ done: 1, total: 2 });
  });
});
