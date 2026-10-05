/**
 * Helpers for swapping rendered markdown for its source textarea in place:
 * map a click in the rendered tree to a source offset, and measure where an
 * offset sits on screen so the scroller can keep that line under the pointer.
 */

/**
 * Source offset for a click at (x, y) inside `root`, the rendered form of
 * `source`; null off text. Rendered text appears verbatim in the source
 * (markup only surrounds it), so text nodes are matched in document order,
 * each searched from where the previous one ended, up to the clicked one.
 */
export function sourceOffsetAt(root: HTMLElement, x: number, y: number, source: string): number | null {
  let node: Node | null = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    node = pos?.offsetNode ?? null;
    offset = pos?.offset ?? 0;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;

  let cursor = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? "";
    const start = text.trim() ? source.indexOf(text, cursor) : -1;
    if (n === node) return start === -1 ? null : start + offset;
    if (start !== -1) cursor = start + text.length;
  }
  return null;
}

const MIRRORED_STYLES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "tabSize",
  "wordBreak",
  "overflowWrap",
] as const;

/** Viewport y of the middle of the line holding `caret` in `el`, via an off-screen mirror. */
export function caretClientY(el: HTMLTextAreaElement, caret: number): number {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const prop of MIRRORED_STYLES) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, { position: "absolute", top: "0", left: "-9999px", visibility: "hidden", whiteSpace: "pre-wrap", borderStyle: "solid" });
  mirror.textContent = el.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const y = el.getBoundingClientRect().top - el.scrollTop + marker.offsetTop + marker.offsetHeight / 2;
  mirror.remove();
  return y;
}

/** Nearest ancestor that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
