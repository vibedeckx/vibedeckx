/** How long a keyboard-driven press stays lit, in ms. */
const PRESS_MS = 160;

const pending = new WeakMap<HTMLElement, number>();

/**
 * Click a button the way a keyboard commit needs to: `el.click()` alone never
 * puts the element in `:active`, so a keyboard Enter fires the action with no
 * visible press. `data-pressed` stands in for `:active` — `buttonVariants`
 * styles the two identically — and is cleared on a timer.
 *
 * Disabled buttons flash nothing: the click is a no-op, so lighting them up
 * would report an action that never ran.
 */
export function clickWithPressFeedback(el: HTMLElement) {
  if (!(el instanceof HTMLButtonElement && el.disabled)) {
    const previous = pending.get(el);
    if (previous !== undefined) window.clearTimeout(previous);
    el.dataset.pressed = "true";
    pending.set(
      el,
      window.setTimeout(() => {
        pending.delete(el);
        delete el.dataset.pressed;
      }, PRESS_MS),
    );
  }
  el.click();
}
