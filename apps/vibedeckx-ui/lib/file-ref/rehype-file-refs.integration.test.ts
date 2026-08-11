import { describe, it, expect } from "vitest";
import { defaultRehypePlugins } from "streamdown";
import { rehypeFileRefs } from "./rehype-file-refs";

// End-to-end guard: run rehypeFileRefs inside streamdown's REAL rehype chain
// (sanitize + harden), in the SAME order AgentMarkdown uses, against hand-built
// hast mirroring what streamdown produces. The Task-3 unit tests feed
// rehypeFileRefs hand-built nodes directly and never exercise this ordering —
// which is where the harden-mangles-relative-hrefs regression hid. `raw` is
// dropped (it needs a vfile and only matters for embedded raw HTML).

interface HNode { type: string; tagName?: string; value?: string; properties?: any; children?: HNode[]; }
const el = (tagName: string, properties: any, children: HNode[]): HNode => ({ type: "element", tagName, properties, children });
const txt = (value: string): HNode => ({ type: "text", value });
const p = (...kids: HNode[]): HNode => ({ type: "root", children: [el("p", {}, kids)] });

function runChain(tree: HNode): HNode {
  const { harden, raw, ...beforeHarden } = defaultRehypePlugins as any;
  const chain = [...Object.values(beforeHarden), rehypeFileRefs, ...(harden ? [harden] : [])];
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
function hasBlockedSpan(node: HNode): boolean {
  if (node.tagName === "span" && typeof node.properties?.title === "string" && node.properties.title.startsWith("Blocked URL")) return true;
  return (node.children ?? []).some(hasBlockedSpan);
}
function textOf(node: HNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");
}

describe("rehypeFileRefs in streamdown's real rehype chain", () => {
  it("converts an agent markdown link with a resolvable path into a file-ref anchor", () => {
    const tree = runChain(p(txt("see "), el("a", { href: "packages/eve/src/execution/compaction.ts:18" }, [txt("compaction.ts")]), txt(" now")));
    const [a] = anchors(tree);
    expect(a.className).toEqual(["file-ref"]);
    expect(a.href).toBe("#file-ref");
    expect(a.dataFileRaw).toBe("packages/eve/src/execution/compaction.ts");
    expect(a.dataFileLine).toBe("18");
    expect(hasBlockedSpan(tree)).toBe(false);
  });

  it("uses the link's path even when the display text is a symbol, not a filename", () => {
    const tree = runChain(p(el("a", { href: "packages/eve/src/runtime/framework-tools/todo.ts:56" }, [txt("getTodoCompactionMessage")])));
    const [a] = anchors(tree);
    expect(a.dataFileRaw).toBe("packages/eve/src/runtime/framework-tools/todo.ts");
    expect(a.dataFileLine).toBe("56");
    expect(textOf(tree)).toContain("getTodoCompactionMessage");
  });

  it("carries an unresolvable path as a raw-path anchor with clean text (no blocked span)", () => {
    // Resolution is deferred to FileRefLink, which renders a no-match anchor
    // as its plain children — the de-linking happens at render time now.
    const tree = runChain(p(txt("see "), el("a", { href: "a/b/does-not-exist.ts:9" }, [txt("x")]), txt(" end")));
    const [a] = anchors(tree);
    expect(a.dataFileRaw).toBe("a/b/does-not-exist.ts");
    expect(hasBlockedSpan(tree)).toBe(false);
    expect(textOf(tree)).toBe("see x end");
  });

  it("linkifies a bare path sitting in prose text", () => {
    const tree = runChain(p(txt("最后在 packages/eve/src/execution/compaction.ts:18 里")));
    const [a] = anchors(tree);
    expect(a.dataFileRaw).toBe("packages/eve/src/execution/compaction.ts");
    expect(a.dataFileLine).toBe("18");
  });

  it("leaves a genuine external link untouched", () => {
    const tree = runChain(p(el("a", { href: "https://example.com/x" }, [txt("docs")])));
    const [a] = anchors(tree);
    expect(String(a.href)).toContain("example.com");
    expect(a.dataFileRaw).toBeUndefined();
  });
});
