/**
 * Walks up the DOM from `el` and returns the nearest ancestor whose computed
 * overflow-y allows scrolling (`auto` or `scroll`), or null if none exists.
 */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}
