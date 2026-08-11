import { describe, it, expect } from "vitest";
import { rehypeFileRefs } from "./rehype-file-refs";

// The plugin is index-free: it marks every path-shaped span as a `.file-ref`
// anchor carrying the RAW path; whether it resolves (link vs plain children)
// is FileRefLink's render-time decision. See file-ref-link.tsx tests for that
// half.

function el(tagName: string, properties: any, children: any[]) {
  return { type: "element", tagName, properties, children };
}
function txt(value: string) {
  return { type: "text", value };
}

describe("rehypeFileRefs", () => {
  it("splits a path ref out of a text node into a raw-path anchor", () => {
    const tree = el("p", {}, [txt("open src/a.ts:18 now")]);
    rehypeFileRefs()(tree as any);
    const kids = (tree as any).children;
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual(txt("open "));
    expect(kids[1].tagName).toBe("a");
    expect(kids[1].properties.className).toEqual(["file-ref"]);
    expect(kids[1].properties.dataFileRaw).toBe("src/a.ts");
    expect(kids[1].properties.dataFileLine).toBe("18");
    expect(kids[2]).toEqual(txt(" now"));
  });

  it("collapses a literal [label](path:line) inside inline code into one clean anchor", () => {
    const tree = el("code", {}, [txt("[compaction.ts](src/a.ts:18)")]);
    rehypeFileRefs()(tree as any);
    const kids = (tree as any).children;
    expect(kids).toHaveLength(1);
    expect(kids[0].tagName).toBe("a");
    expect(kids[0].properties.dataFileRaw).toBe("src/a.ts");
    expect(kids[0].properties.dataFileLine).toBe("18");
    // Display text is the label, and the literal [ ]( ) are gone.
    expect(kids[0].children).toEqual([txt("compaction.ts")]);
  });

  it("marks path-shaped tokens even when they may not resolve (deferred decision)", () => {
    const tree = el("p", {}, [txt("open zzz.ts here")]);
    rehypeFileRefs()(tree as any);
    const kids = (tree as any).children;
    expect(kids).toHaveLength(3);
    expect(kids[1].tagName).toBe("a");
    expect(kids[1].properties.dataFileRaw).toBe("zzz.ts");
  });

  it("leaves bare words without separators as plain text", () => {
    const tree = el("p", {}, [txt("open something here")]);
    rehypeFileRefs()(tree as any);
    expect((tree as any).children).toEqual([txt("open something here")]);
  });

  it("never touches text inside <pre>", () => {
    const tree = el("pre", {}, [el("code", {}, [txt("src/a.ts:1")])]);
    rehypeFileRefs()(tree as any);
    const codeKids = (tree as any).children[0].children;
    expect(codeKids).toEqual([txt("src/a.ts:1")]);
  });

  it("converts a relative <a> into a raw-path anchor, preserving text", () => {
    const tree = el("p", {}, [
      el("a", { href: "src/a.ts:18" }, [txt("compaction")]),
    ]);
    rehypeFileRefs()(tree as any);
    const a = (tree as any).children[0];
    expect(a.tagName).toBe("a");
    expect(a.properties.dataFileRaw).toBe("src/a.ts");
    expect(a.properties.dataFileLine).toBe("18");
    expect(a.children).toEqual([txt("compaction")]);
  });

  it("leaves http links untouched", () => {
    const tree = el("p", {}, [
      el("a", { href: "https://x.dev" }, [txt("x")]),
    ]);
    rehypeFileRefs()(tree as any);
    const a = (tree as any).children[0];
    expect(a.properties.href).toBe("https://x.dev");
    expect(a.properties.dataFileRaw).toBeUndefined();
  });

  it("leaves mailto and pure-anchor links untouched", () => {
    const tree = el("p", {}, [
      el("a", { href: "mailto:a@b.com" }, [txt("mail")]),
      el("a", { href: "#section" }, [txt("anchor")]),
    ]);
    rehypeFileRefs()(tree as any);
    const kids = (tree as any).children;
    expect(kids[0].properties.href).toBe("mailto:a@b.com");
    expect(kids[0].properties.dataFileRaw).toBeUndefined();
    expect(kids[1].properties.href).toBe("#section");
    expect(kids[1].properties.dataFileRaw).toBeUndefined();
  });
});
