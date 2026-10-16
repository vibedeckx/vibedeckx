import { describe, expect, it } from "vitest";
import { diffLines, foldUnchanged } from "./line-diff";

const render = (lines: ReturnType<typeof foldUnchanged>) =>
  lines.map((l) => (l.kind === "fold" ? `~${l.count}` : `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`));

describe("diffLines", () => {
  it("returns only unchanged lines for equal texts", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ kind: "same", text: "a" }, { kind: "same", text: "b" }]);
  });

  it("puts removed lines before the lines that replace them", () => {
    expect(render(diffLines("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("handles pure insertions and deletions", () => {
    expect(render(diffLines("a\nc", "a\nb\nc"))).toEqual([" a", "+b", " c"]);
    expect(render(diffLines("a\nb\nc", "a\nc"))).toEqual([" a", "-b", " c"]);
    expect(render(diffLines("", "x"))).toEqual(["-", "+x"]);
  });
});

describe("foldUnchanged", () => {
  it("folds long unchanged runs down to context around each change", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "5", "6", "7", "X"].join("\n");
    expect(render(foldUnchanged(diffLines(before, after), 2))).toEqual(["~5", " 6", " 7", "-8", "+X"]);
  });

  it("keeps a short run between two changes", () => {
    expect(render(foldUnchanged(diffLines("a\nb\nc\nd", "A\nb\nc\nD"), 2))).toEqual(["-a", "+A", " b", " c", "-d", "+D"]);
  });
});
