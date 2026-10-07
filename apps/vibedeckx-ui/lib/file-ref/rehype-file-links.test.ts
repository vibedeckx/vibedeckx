/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- hast fixtures, mirroring rehype-file-refs.integration.test.ts */
import { describe, it, expect } from "vitest";
import { defaultRehypePlugins } from "streamdown";
import { rehypeFileLinks, toRepoRelativePath } from "./rehype-file-links";

// Runs in streamdown's real rehype chain, in TASK_REHYPE_PLUGINS order
// (sanitize → rehypeFileLinks → harden), like rehype-file-refs.integration.

interface HNode { type: string; tagName?: string; value?: string; properties?: any; children?: HNode[]; }
const el = (tagName: string, properties: any, children: HNode[]): HNode => ({ type: "element", tagName, properties, children });
const txt = (value: string): HNode => ({ type: "text", value });
const p = (...kids: HNode[]): HNode => ({ type: "root", children: [el("p", {}, kids)] });

function runChain(tree: HNode): HNode {
  const { harden, raw, ...beforeHarden } = defaultRehypePlugins as any;
  const chain = [...Object.values(beforeHarden), rehypeFileLinks, ...(harden ? [harden] : [])];
  let t = tree;
  for (const plugin of chain) {
    const [fn, ...opts] = Array.isArray(plugin) ? plugin : [plugin];
    const out = (fn as any)(...opts)(t);
    if (out) t = out;
  }
  return t;
}
function anchors(node: HNode, out: any[] = []): any[] {
  if (node.tagName === "a") out.push(node.properties);
  for (const c of node.children ?? []) anchors(c, out);
  return out;
}
function textOf(node: HNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");
}
const link = (href: string, label = "x") => runChain(p(el("a", { href }, [txt(label)])));

describe("rehypeFileLinks", () => {
  it("turns a repo-relative link into a file-ref anchor", () => {
    const [a] = anchors(link("docs/x.md", "设计"));
    expect(a.href).toBe("#file-ref");
    expect(a.dataFileRaw).toBe("docs/x.md");
    expect(a.dataFileLine).toBeUndefined();
  });

  it.each(["src/a.ts:42", "src/a.ts#L42", "src/a.ts#L42-L50"])("reads the line from %s", (href) => {
    const [a] = anchors(link(href));
    expect(a.dataFileRaw).toBe("src/a.ts");
    expect(a.dataFileLine).toBe("42");
  });

  it.each(["Makefile", "bin/vibedeckx"])("links an extension-less file %s", (href) => {
    expect(anchors(link(href))[0].dataFileRaw).toBe(href);
  });

  it("drops a leading ./", () => {
    expect(anchors(link("./docs/x.md"))[0].dataFileRaw).toBe("docs/x.md");
  });

  it("leaves bare paths and code as text", () => {
    const tree = runChain(p(txt("see docs/x.md:42 and "), el("code", {}, [txt("[x](docs/x.md)")])));
    expect(anchors(tree)).toEqual([]);
    expect(textOf(tree)).toBe("see docs/x.md:42 and [x](docs/x.md)");
  });

  it("keeps an external link external", () => {
    const [a] = anchors(link("https://example.com/a"));
    expect(a.dataFileRaw).toBeUndefined();
    expect(a.href).toBe("https://example.com/a");
  });

  it.each(["/etc/x", "~/x", "../x", "docs/../../x"])("renders %s as plain text", (href) => {
    const tree = link(href, "label");
    expect(anchors(tree)).toEqual([]);
    expect(textOf(tree)).toBe("label");
  });
});

describe("toRepoRelativePath", () => {
  it("accepts repo paths and rejects ones leaving the repo", () => {
    expect(toRepoRelativePath("a/b.ts")).toBe("a/b.ts");
    expect(toRepoRelativePath("././a")).toBe("a");
    expect(toRepoRelativePath("a/..b")).toBe("a/..b");
    expect(toRepoRelativePath("~")).toBeNull();
    expect(toRepoRelativePath("./")).toBeNull();
  });
});
