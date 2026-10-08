// Drag-to-select confined to a code block.
//
// Chrome extends a native drag selection to whatever text sits under the
// pointer, anywhere on the page. In the Files preview that means drifting over
// the header or the file tree (both earlier in DOM order) flips the selection
// to run BACKWARD from the press point — the lines dragged over vanish and
// everything from the top of the file to the press point turns blue. Code
// editors confine the selection to the code instead, which is what this does:
// the press point is the anchor, the pointer is clamped into the visible code
// viewport to find the focus, and dragging past an edge auto-scrolls.

export interface Caret {
  node: Node;
  offset: number;
}

// Pixels scrolled per frame at most while the pointer is past an edge.
const EDGE_SCROLL_MAX = 24;
// Inner margin at the window edge that also auto-scrolls, for scrollers that
// reach the window bottom (the pointer can't get below them).
const WINDOW_EDGE = 4;

export function caretFromPoint(x: number, y: number): Caret | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

function isUnselectable(node: Node): boolean {
  return node instanceof Element && getComputedStyle(node).userSelect === "none";
}

// Keep a caret inside `code`, and out of a line's gutter cells (line number,
// fold chevron — both user-select:none): a caret landing there snaps to the
// line's first code character so the selection never starts mid-gutter.
function normalize(caret: Caret, code: Element): Caret | null {
  if (!code.contains(caret.node)) return null;
  const el =
    caret.node.nodeType === Node.ELEMENT_NODE ? (caret.node as Element) : caret.node.parentElement;
  const line = el?.closest("[data-line]");
  if (!line || !code.contains(line)) return caret;
  let gutter = 0;
  while (gutter < line.childNodes.length && isUnselectable(line.childNodes[gutter])) gutter++;
  if (caret.node === line) return { node: line, offset: Math.max(caret.offset, gutter) };
  let cell: Node | null = caret.node;
  while (cell && cell.parentNode !== line) cell = cell.parentNode;
  if (cell && Array.prototype.indexOf.call(line.childNodes, cell) < gutter) {
    return { node: line, offset: gutter };
  }
  return caret;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// The on-screen box the code is visible through: the vertical scroller
// intersected with the horizontal one (and the window).
function viewport(scroller: Element, hScroller: Element) {
  const v = scroller.getBoundingClientRect();
  const h = hScroller.getBoundingClientRect();
  return {
    left: Math.max(v.left, h.left, 0),
    right: Math.min(v.right, h.right, window.innerWidth),
    top: Math.max(v.top, h.top, WINDOW_EDGE),
    bottom: Math.min(v.bottom, h.bottom, window.innerHeight - WINDOW_EDGE),
  };
}

function caretAt(x: number, y: number, code: Element, scroller: Element, hScroller: Element) {
  const box = viewport(scroller, hScroller);
  const cx = clamp(x, box.left + 1, box.right - 2);
  const cy = clamp(y, box.top + 1, box.bottom - 2);
  const hit = caretFromPoint(cx, cy);
  const caret = hit && normalize(hit, code);
  if (caret) return caret;
  // Off the text (pre padding above/below the lines): snap to the nearer end.
  const rect = code.getBoundingClientRect();
  if (cy < rect.top) return { node: code, offset: 0 };
  if (cy > rect.bottom) return { node: code, offset: code.childNodes.length };
  return null;
}

function edgeDelta(p: number, lo: number, hi: number): number {
  if (p < lo) return -Math.min(EDGE_SCROLL_MAX, (lo - p) / 2 + 2);
  if (p > hi) return Math.min(EDGE_SCROLL_MAX, (p - hi) / 2 + 2);
  return 0;
}

// Take over a primary-button press inside `code` and run the drag selection
// ourselves until release. Returns false (leaving the press to the browser)
// when the press point doesn't resolve to a caret in the code.
export function beginConfinedSelection(
  e: MouseEvent,
  code: Element,
  scroller: Element
): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const hScroller = code.closest("pre")?.parentElement ?? scroller;
  const start = caretAt(e.clientX, e.clientY, code, scroller, hScroller);
  if (!start) return false;

  // Shift-press extends the existing selection when it is anchored in the code.
  const anchor: Caret =
    e.shiftKey && sel.anchorNode && code.contains(sel.anchorNode)
      ? { node: sel.anchorNode, offset: sel.anchorOffset }
      : start;

  // Suppress the native selection. That also keeps focus where it was, so drop
  // focus from a text field elsewhere — otherwise copy would read the field.
  e.preventDefault();
  const active = document.activeElement;
  if (active instanceof HTMLElement && !code.contains(active)) active.blur();

  let px = e.clientX;
  let py = e.clientY;
  const extend = () => {
    const focus = caretAt(px, py, code, scroller, hScroller);
    if (focus) sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };
  extend();

  let raf = 0;
  const tick = () => {
    raf = 0;
    const box = viewport(scroller, hScroller);
    const dx = edgeDelta(px, box.left, box.right);
    const dy = edgeDelta(py, box.top, box.bottom);
    if (!dx && !dy) return;
    if (dy) scroller.scrollTop += dy;
    if (dx) hScroller.scrollLeft += dx;
    extend();
    raf = requestAnimationFrame(tick);
  };
  const onMove = (ev: MouseEvent) => {
    if (!(ev.buttons & 1)) {
      stop();
      return;
    }
    px = ev.clientX;
    py = ev.clientY;
    extend();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  // Wheel-scrolling mid-drag moves the text under a still pointer.
  const onScroll = () => extend();
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
    scroller.removeEventListener("scroll", onScroll);
    hScroller.removeEventListener("scroll", onScroll);
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", stop, true);
  window.addEventListener("blur", stop);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  hScroller.addEventListener("scroll", onScroll, { passive: true });
  return true;
}
