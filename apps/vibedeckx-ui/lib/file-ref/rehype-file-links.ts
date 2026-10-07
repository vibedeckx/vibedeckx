import { parseFileHref } from "./parse-file-ref";
import { makeFileRefAnchor, type HastNode } from "./rehype-file-refs";

/**
 * A repo-relative file href from a Task description, or null when the href
 * points outside the repository: absolute (`/…`), home (`~/…`) or any `..`
 * segment. A leading `./` is dropped. Input is parseFileHref's rawPath, so
 * URLs and anchors are already filtered out.
 */
export function toRepoRelativePath(rawPath: string): string | null {
  const path = rawPath.replace(/^(?:\.\/)+/, "");
  if (!path || path.startsWith("/") || path === "~" || path.startsWith("~/")) return null;
  if (path.split("/").some((seg) => seg === "..")) return null;
  return path;
}

/**
 * Task-description counterpart of rehypeFileRefs: converts explicit markdown
 * links only, never scanning text for bare paths — a Task has no file index
 * to tell a path from prose. Must run after sanitize and before harden (see
 * agent-markdown.tsx). A file href that leaves the repository becomes plain
 * text rather than a link that does nothing.
 */
export function rehypeFileLinks() {
  function transformAnchor(node: HastNode): HastNode[] {
    const parsed = parseFileHref(String(node.properties?.href ?? ""));
    if (!parsed) return [node]; // external / anchor link — leave as-is
    const path = toRepoRelativePath(parsed.rawPath);
    if (!path) return node.children ?? [];
    return [makeFileRefAnchor(path, parsed.line, node.children ?? [])];
  }

  function processChildren(parent: HastNode): void {
    if (!parent.children || parent.tagName === "pre") return;
    const out: HastNode[] = [];
    for (const child of parent.children) {
      if (child.type === "element" && child.tagName === "a") {
        out.push(...transformAnchor(child));
      } else {
        processChildren(child);
        out.push(child);
      }
    }
    parent.children = out;
  }

  return (tree: HastNode): void => {
    processChildren(tree);
  };
}
