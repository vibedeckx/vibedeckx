import { describe, it, expect } from "vitest";
import { buildFileRefIndex } from "./file-ref-index";

const files = [
  "packages/eve/src/execution/compaction.ts",
  "packages/eve/src/runtime/framework-tools/todo.ts",
  "apps/ui/todo.ts",
];

describe("buildFileRefIndex.resolve", () => {
  const idx = buildFileRefIndex(files);

  it("matches an exact full path", () => {
    expect(idx.resolve("packages/eve/src/execution/compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("matches a unique path suffix", () => {
    expect(idx.resolve("execution/compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("matches a bare filename that is unique", () => {
    expect(idx.resolve("compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("returns all matches for an ambiguous bare filename", () => {
    expect(idx.resolve("todo.ts").sort()).toEqual(
      ["apps/ui/todo.ts", "packages/eve/src/runtime/framework-tools/todo.ts"].sort(),
    );
  });

  it("returns empty for an unknown reference", () => {
    expect(idx.resolve("nope.ts")).toEqual([]);
    expect(idx.resolve("")).toEqual([]);
  });

  it("matches an absolute path whose tail is a repo file (remote working dir)", () => {
    expect(
      idx.resolve("/src/eve/packages/eve/src/execution/compaction.ts"),
    ).toEqual(["packages/eve/src/execution/compaction.ts"]);
  });

  it("ignores leading slashes when the remainder is an exact repo path", () => {
    expect(idx.resolve("//packages/eve/src/execution/compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("disambiguates an absolute path to the correct same-basename file", () => {
    expect(idx.resolve("/remote/root/apps/ui/todo.ts")).toEqual([
      "apps/ui/todo.ts",
    ]);
  });
});
