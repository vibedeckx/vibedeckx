// Shared guard for global keydown listeners: keys must keep typing text
// wherever text entry is possible. (A focused xterm never lets keys bubble to
// window, so terminals need no check here; keys also never cross the Browser
// preview iframe boundary.)
export const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable);
