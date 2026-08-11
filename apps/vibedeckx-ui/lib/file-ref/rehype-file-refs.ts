import { scanFileRefs, parseFileHref } from "./parse-file-ref";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Marks every path-shaped reference as a `.file-ref` anchor carrying the RAW
// path (`dataFileRaw`); whether it resolves to a real file is decided at
// render time by FileRefLink, which reads the file-ref index from context.
//
// Deliberately index-free: an index-dependent plugin forced AgentMarkdown to
// remount the whole Streamdown tree when the index arrived (Streamdown's memo
// ignores rehypePlugins), and the remount collapses every markdown message to
// its placeholder height for a frame — the field-captured "content jump" when
// opening a session whose index loads late. With the decision deferred, the
// plugin (and thus the rendered tree) never depends on the index; a late index
// only restyles the anchors in place via a context re-render.
export function rehypeFileRefs() {
  function makeAnchor(
    rawPath: string,
    line: number | null,
    children: HastNode[],
  ): HastNode {
    return {
      type: "element",
      tagName: "a",
      properties: {
        className: ["file-ref"],
        href: "#file-ref",
        dataFileRaw: rawPath,
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
    for (const r of refs) {
      if (r.start > pos) out.push({ type: "text", value: value.slice(pos, r.start) });
      const display = r.display ?? value.slice(r.start, r.end);
      out.push(makeAnchor(r.rawPath, r.line, [{ type: "text", value: display }]));
      pos = r.end;
    }
    if (pos < value.length) out.push({ type: "text", value: value.slice(pos) });
    return out;
  }

  function transformAnchor(node: HastNode): HastNode[] {
    const href = String(node.properties?.href ?? "");
    const parsed = parseFileHref(href);
    if (!parsed) return [node]; // external / anchor link — leave as-is
    return [makeAnchor(parsed.rawPath, parsed.line, node.children ?? [])];
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
