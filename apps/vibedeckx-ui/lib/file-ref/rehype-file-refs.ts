import type { FileRefIndex } from "./file-ref-index";
import { scanFileRefs, parseFileHref } from "./parse-file-ref";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypeFileRefs(opts: { index: FileRefIndex | null }) {
  const resolve = (p: string): string[] => (opts.index ? opts.index.resolve(p) : []);

  function makeAnchor(
    paths: string[],
    line: number | null,
    children: HastNode[],
  ): HastNode {
    return {
      type: "element",
      tagName: "a",
      properties: {
        className: ["file-ref"],
        href: "#file-ref",
        dataFilePaths: JSON.stringify(paths),
        ...(line != null ? { dataFileLine: String(line) } : {}),
      },
      children,
    };
  }

  function expandText(value: string): HastNode[] {
    const refs = scanFileRefs(value);
    if (refs.length === 0) return [{ type: "text", value }];
    const out: HastNode[] = [];
    let pos = 0;
    let linked = false;
    for (const r of refs) {
      const matches = resolve(r.rawPath);
      if (matches.length === 0) continue;
      if (r.start > pos) out.push({ type: "text", value: value.slice(pos, r.start) });
      out.push(
        makeAnchor(matches, r.line, [{ type: "text", value: value.slice(r.start, r.end) }]),
      );
      pos = r.end;
      linked = true;
    }
    if (!linked) return [{ type: "text", value }];
    if (pos < value.length) out.push({ type: "text", value: value.slice(pos) });
    return out;
  }

  function transformAnchor(node: HastNode): HastNode[] {
    const href = String(node.properties?.href ?? "");
    const parsed = parseFileHref(href);
    if (!parsed) return [node]; // external / anchor link — leave as-is
    const matches = resolve(parsed.rawPath);
    // TEMP DEBUG — remove after diagnosing file-ref rendering
    console.log("[fileref-debug] transformAnchor", {
      href,
      rawPath: parsed.rawPath,
      indexNull: !opts.index,
      matches: matches.length,
    });
    if (matches.length === 0) return node.children ?? []; // unwrap broken file link
    return [makeAnchor(matches, parsed.line, node.children ?? [])];
  }

  function processChildren(parent: HastNode, insidePre: boolean = false): void {
    if (!parent.children) return;
    const newInsidePre = insidePre || parent.tagName === "pre";
    const out: HastNode[] = [];
    for (const child of parent.children) {
      if (child.type === "text") {
        if (!newInsidePre) {
          out.push(...expandText(child.value ?? ""));
        } else {
          out.push(child);
        }
      } else if (child.type === "element" && child.tagName === "pre") {
        processChildren(child, true); // pass true to indicate we're inside pre
        out.push(child);
      } else if (child.type === "element" && child.tagName === "a" && !newInsidePre) {
        out.push(...transformAnchor(child));
      } else {
        processChildren(child, newInsidePre);
        out.push(child);
      }
    }
    parent.children = out;
  }

  return (tree: HastNode): void => {
    processChildren(tree);
  };
}
