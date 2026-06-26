import { describe, it, expect } from "vitest";
import { scanFileRefs, parseFileHref } from "./parse-file-ref";

describe("scanFileRefs", () => {
  it("finds a bare path with a line suffix in prose", () => {
    const text = "最后在 packages/eve/src/execution/compaction.ts:18 里";
    const refs = scanFileRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].rawPath).toBe("packages/eve/src/execution/compaction.ts");
    expect(refs[0].line).toBe(18);
    expect(text.slice(refs[0].start, refs[0].end)).toBe(
      "packages/eve/src/execution/compaction.ts:18",
    );
  });

  it("finds a bare filename with no line", () => {
    const refs = scanFileRefs("see compaction.ts here");
    expect(refs).toHaveLength(1);
    expect(refs[0].rawPath).toBe("compaction.ts");
    expect(refs[0].line).toBeNull();
  });

  it("keeps the line from a col suffix and from #L forms", () => {
    expect(scanFileRefs("a/b.ts:18:5")[0].line).toBe(18);
    expect(scanFileRefs("a/b.ts#L20")[0].line).toBe(20);
    expect(scanFileRefs("a/b.ts#L20-L25")[0].line).toBe(20);
  });

  it("does not match a bare word without an extension or slash", () => {
    expect(scanFileRefs("update the config now")).toHaveLength(0);
  });

  it("does not include trailing sentence punctuation", () => {
    const refs = scanFileRefs("在 todo.ts:56。");
    expect(refs[0].rawPath).toBe("todo.ts");
    expect(refs[0].line).toBe(56);
  });
});

describe("parseFileHref", () => {
  it("parses a relative file href with a line", () => {
    expect(parseFileHref("packages/eve/x/todo.ts:56")).toEqual({
      rawPath: "packages/eve/x/todo.ts",
      line: 56,
    });
  });

  it("rejects http(s), mailto, and pure anchors", () => {
    expect(parseFileHref("https://vibedeckx.dev/x")).toBeNull();
    expect(parseFileHref("mailto:a@b.com")).toBeNull();
    expect(parseFileHref("#section")).toBeNull();
  });

  it("parses a relative href whose basename looks like a scheme", () => {
    expect(parseFileHref("gone.ts:9")).toEqual({ rawPath: "gone.ts", line: 9 });
    expect(parseFileHref("src/a.ts")).toEqual({ rawPath: "src/a.ts", line: null });
  });
});
