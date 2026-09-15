import { describe, expect, it } from "vitest";
import { pathLabelParts } from "./file-path-label";

describe("pathLabelParts", () => {
  it("keeps the filename out of the truncatable part for a plain path", () => {
    expect(pathLabelParts("apps/vibedeckx-ui/components/diff/file-diff.tsx")).toEqual({
      dir: "apps/vibedeckx-ui/components/diff",
      from: null,
      to: "file-diff.tsx",
      suffix: "",
    });
  });

  it("handles a bare filename with no directory", () => {
    expect(pathLabelParts("README.md")).toEqual({ dir: "", from: null, to: "README.md", suffix: "" });
  });

  it("folds the shared directory of a rename so both names stay visible", () => {
    expect(
      pathLabelParts("apps/ui/components/diff/file-diff.tsx", "apps/ui/components/diff/old-diff.tsx"),
    ).toEqual({
      dir: "apps/ui/components/diff",
      from: "old-diff.tsx",
      to: "file-diff.tsx",
      suffix: "",
    });
  });

  it("folds a shared trailing segment when a directory is renamed", () => {
    expect(pathLabelParts("apps/new/index.ts", "apps/old/index.ts")).toEqual({
      dir: "apps",
      from: "old",
      to: "new",
      suffix: "index.ts",
    });
  });

  it("shows both paths whole when a rename shares nothing", () => {
    expect(pathLabelParts("src/b.ts", "lib/a.ts")).toEqual({
      dir: "",
      from: "lib/a.ts",
      to: "src/b.ts",
      suffix: "",
    });
  });

  it("keeps a differing segment on each side rather than folding everything away", () => {
    // Same basename AND same parent: the tail scan must stop before it eats
    // the only segments that differ.
    expect(pathLabelParts("a/x/f.ts", "b/x/f.ts")).toEqual({
      dir: "",
      from: "b",
      to: "a",
      suffix: "x/f.ts",
    });
  });

  it("treats a same-path rename as a plain path", () => {
    expect(pathLabelParts("a/f.ts", "a/f.ts")).toEqual({ dir: "a", from: null, to: "f.ts", suffix: "" });
  });
});
