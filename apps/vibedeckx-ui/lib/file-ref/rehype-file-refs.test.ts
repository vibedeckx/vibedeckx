import { describe, it, expect } from "vitest";
import { rehypeFileRefs } from "./rehype-file-refs";
import type { FileRefIndex } from "./file-ref-index";

// Stub index: src/a.ts is unique; a.ts is ambiguous; everything else unknown.
const index: FileRefIndex = {
  resolve: (p) =>
    p === "src/a.ts"
      ? ["src/a.ts"]
      : p === "a.ts"
        ? ["src/a.ts", "lib/a.ts"]
        : [],
};

function el(tagName: string, properties: any, children: any[]) {
  return { type: "element", tagName, properties, children };
}
function txt(value: string) {
  return { type: "text", value };
}

describe("rehypeFileRefs", () => {
  it("splits a resolvable ref out of a text node into a file-ref anchor", () => {
    const tree = el("p", {}, [txt("open src/a.ts:18 now")]);
    rehypeFileRefs({ index })(tree as any);
    const kids = (tree as any).children;
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual(txt("open "));
    expect(kids[1].tagName).toBe("a");
    expect(kids[1].properties.className).toEqual(["file-ref"]);
    expect(JSON.parse(kids[1].properties.dataFilePaths)).toEqual(["src/a.ts"]);
    expect(kids[1].properties.dataFileLine).toBe("18");
    expect(kids[2]).toEqual(txt(" now"));
  });

  it("leaves unresolved tokens as plain text", () => {
    const tree = el("p", {}, [txt("open zzz.ts here")]);
    rehypeFileRefs({ index })(tree as any);
    expect((tree as any).children).toEqual([txt("open zzz.ts here")]);
  });

  it("never touches text inside <pre>", () => {
    const tree = el("pre", {}, [el("code", {}, [txt("src/a.ts:1")])]);
    rehypeFileRefs({ index })(tree as any);
    const codeKids = (tree as any).children[0].children;
    expect(codeKids).toEqual([txt("src/a.ts:1")]);
  });

  it("converts a resolving relative <a> into a file-ref, preserving text", () => {
    const tree = el("p", {}, [
      el("a", { href: "src/a.ts:18" }, [txt("compaction")]),
    ]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[0];
    expect(a.tagName).toBe("a");
    expect(JSON.parse(a.properties.dataFilePaths)).toEqual(["src/a.ts"]);
    expect(a.properties.dataFileLine).toBe("18");
    expect(a.children).toEqual([txt("compaction")]);
  });

  it("unwraps a non-resolving relative <a> to plain text", () => {
    const tree = el("p", {}, [el("a", { href: "gone.ts:9" }, [txt("gone")])]);
    rehypeFileRefs({ index })(tree as any);
    expect((tree as any).children).toEqual([txt("gone")]);
  });

  it("leaves http links untouched", () => {
    const tree = el("p", {}, [
      el("a", { href: "https://x.dev" }, [txt("x")]),
    ]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[0];
    expect(a.properties.href).toBe("https://x.dev");
    expect(a.properties.dataFilePaths).toBeUndefined();
  });

  it("emits an anchor with all matches for an ambiguous bare filename", () => {
    const tree = el("p", {}, [txt("see a.ts")]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[1];
    expect(JSON.parse(a.properties.dataFilePaths)).toEqual(["src/a.ts", "lib/a.ts"]);
  });
});
