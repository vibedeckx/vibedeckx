import { describe, expect, it } from "vitest";
import { computeFoldRanges, mergeFoldRanges } from "./fold-ranges";

describe("computeFoldRanges", () => {
  it("produces nested ranges for indented blocks (1-based, end inclusive)", () => {
    const src = [
      "function compute(value) {", // 1
      "  const x = value;", //        2
      "  if (x) {", //                3
      "    return x;", //             4
      "  }", //                       5
      "  return 0;", //               6
      "}", //                         7
    ].join("\n");
    const ranges = computeFoldRanges(src);
    // Outer function body: lines 2..6 fold under line 1.
    expect(ranges).toContainEqual({ startLine: 1, endLine: 6 });
    // Inner if body: line 4 folds under line 3.
    expect(ranges).toContainEqual({ startLine: 3, endLine: 4 });
  });

  it("returns no ranges for flat, equally-indented lines", () => {
    const src = ["a();", "b();", "c();"].join("\n");
    expect(computeFoldRanges(src)).toEqual([]);
  });

  it("absorbs interior blank lines and excludes trailing blanks", () => {
    const src = [
      "obj = {", //  1
      "  a: 1,", //  2
      "", //         3 (interior blank)
      "  b: 2,", //  4
      "}", //        5
      "", //         6 (trailing blank)
    ].join("\n");
    // Region ends at the last non-blank deeper line (4), not the closing brace
    // or the trailing blank.
    expect(computeFoldRanges(src)).toContainEqual({ startLine: 1, endLine: 4 });
  });

  it("does not create a range when there is nothing to hide", () => {
    const src = ["if (x) {", "}"].join("\n");
    expect(computeFoldRanges(src)).toEqual([]);
  });
});

describe("mergeFoldRanges", () => {
  it("keeps one range per start line, earlier provider winning", () => {
    // First list = higher precedence (e.g. bracket over indentation).
    const merged = mergeFoldRanges(
      [{ startLine: 1, endLine: 9 }],
      [{ startLine: 1, endLine: 5 }]
    );
    expect(merged).toEqual([{ startLine: 1, endLine: 9 }]);
  });

  it("keeps properly nested ranges", () => {
    const merged = mergeFoldRanges([
      { startLine: 1, endLine: 10 },
      { startLine: 3, endLine: 6 },
    ]);
    expect(merged).toEqual([
      { startLine: 1, endLine: 10 },
      { startLine: 3, endLine: 6 },
    ]);
  });

  it("keeps disjoint ranges", () => {
    const merged = mergeFoldRanges([
      { startLine: 1, endLine: 3 },
      { startLine: 5, endLine: 8 },
    ]);
    expect(merged).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 5, endLine: 8 },
    ]);
  });

  it("drops a range that crosses (partially overlaps) an accepted one", () => {
    const merged = mergeFoldRanges([
      { startLine: 1, endLine: 5 },
      { startLine: 3, endLine: 8 }, // crosses out of {1,5}
    ]);
    expect(merged).toEqual([{ startLine: 1, endLine: 5 }]);
  });

  it("drops degenerate ranges (end <= start)", () => {
    const merged = mergeFoldRanges([
      { startLine: 4, endLine: 4 },
      { startLine: 2, endLine: 1 },
    ]);
    expect(merged).toEqual([]);
  });
});
