import { describe, expect, it } from "vitest";
import { parseDiffOutput, unquoteGitPath } from "./diff-parser.js";

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

describe("parseDiffOutput quoted paths", () => {
  it("decodes a non-ASCII path git escaped with core.quotePath", () => {
    const out = [
      'diff --git "a/docs/\\345\\212\\237\\350\\203\\275.md" "b/docs/\\345\\212\\237\\350\\203\\275.md"',
      "index 1111111..2222222 100644",
      '--- "a/docs/\\345\\212\\237\\350\\203\\275.md"',
      '+++ "b/docs/\\345\\212\\237\\350\\203\\275.md"',
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const [file] = parseDiffOutput(out);
    expect(file.path).toBe("docs/功能.md");
  });

  it("keeps a rename's escaped old path", () => {
    const out = [
      'diff --git "a/\\345\\211\\215.md" "b/\\345\\220\\216.md"',
      "similarity index 100%",
      'rename from "\\345\\211\\215.md"',
      'rename to "\\345\\220\\216.md"',
      "",
    ].join("\n");
    const [file] = parseDiffOutput(out);
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("前.md");
    expect(file.path).toBe("后.md");
  });

  it("still parses plain ASCII headers", () => {
    const out = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parseDiffOutput(out)[0].path).toBe("src/a.ts");
  });
});

describe("unquoteGitPath", () => {
  it("returns an unquoted token unchanged", () => {
    expect(unquoteGitPath("docs/plain name.md")).toBe("docs/plain name.md");
  });

  it("decodes octal escapes as UTF-8 bytes, not characters", () => {
    expect(unquoteGitPath('"\\345\\212\\237"')).toBe("功");
  });

  it("decodes the simple C escapes git emits", () => {
    expect(unquoteGitPath('"a\\tb\\nc\\"d\\\\e"')).toBe('a\tb\nc"d\\e');
  });
});
