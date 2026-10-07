import { describe, it, expect } from "vitest";
import { descriptionPreview, taskFileBranch } from "./task-utils";

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
