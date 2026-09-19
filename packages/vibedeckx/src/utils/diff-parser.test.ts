import { describe, expect, it } from "vitest";
import { parseDiffOutput } from "./diff-parser.js";

describe("parseDiffOutput binary files", () => {
  it("marks a file git reports as binary", () => {
    const out = [
      "diff --git a/logo.png b/logo.png",
      "index 435b1338..c0d46d08 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    expect(parseDiffOutput(out)).toEqual([
      { path: "logo.png", status: "modified", hunks: [], binary: true },
    ]);
  });

  it("does not mark a text file whose content mentions binary files", () => {
    const out = [
      "diff --git a/notes.md b/notes.md",
      "index 1111111..2222222 100644",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+Binary files a/x and b/x differ",
      "",
    ].join("\n");
    const [file] = parseDiffOutput(out);
    expect(file.binary).toBeUndefined();
    expect(file.hunks[0].lines).toHaveLength(2);
  });
});
