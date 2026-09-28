// Target picking for the read-aloud shortcut: the lowest agent reply the user
// can actually see in the transcript. Works off the rendered speak buttons, so
// it inherits their rules for free — streaming and code-only replies render no
// button and are never picked.

import { SPEAK_SHORTCUT_CODE, matchComboShortcut } from "@/lib/tab-shortcuts";
import { ttsPlayer } from "./tts-player";

// SpeakButton carries `data-speak-button`; the assistant message around it
// carries `data-speak-message` — that box is what must be on screen.
const SPEAK_BUTTON_ATTR = "data-speak-button";
const SPEAK_MESSAGE_ATTR = "data-speak-message";

/**
 * A message counts as on screen when this much of it shows, or all of it does
 * (short replies) — so a reply peeking a few pixels over the composer edge
 * doesn't win over the one the user is actually reading.
 */
const MIN_VISIBLE_PX = 32;

interface Box {
  top: number;
  bottom: number;
}

/** The vertical band of `el` not clipped by a scrolling ancestor or the window. */
function visibleBand(el: HTMLElement): Box {
  const rect = el.getBoundingClientRect();
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let node = el.parentElement; node && top < bottom; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "visible") continue;
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  return { top, bottom };
}

/** The speak button of the bottom-most visible speakable message under `container`. */
export function findSpeakTarget(container: HTMLElement): HTMLButtonElement | null {
  let best: HTMLButtonElement | null = null;
  let bestTop = -Infinity;
  for (const button of container.querySelectorAll<HTMLButtonElement>(`button[${SPEAK_BUTTON_ATTR}]`)) {
    const message = button.closest<HTMLElement>(`[${SPEAK_MESSAGE_ATTR}]`) ?? button;
    const rect = message.getBoundingClientRect();
    if (rect.height === 0) continue; // display:none
    const band = visibleBand(message);
    const shown = band.bottom - band.top;
    if (shown < Math.min(MIN_VISIBLE_PX, rect.height)) continue;
    if (rect.top > bestTop) {
      best = button;
      bestTop = rect.top;
    }
  }
  return best;
}

/**
 * The shortcut's keydown handler. Clicks the target's speak button rather than
 * calling the player: the keydown's user activation carries into the click
 * (the player needs it to unlock audio), and the button's toggle already means
 * "stop if this reply is the one playing, else switch to it". With no reply on
 * screen it still stops whatever plays. Key repeat is ignored, or holding the
 * keys would flip playback on and off.
 */
export function handleSpeakShortcut(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!matchComboShortcut(event, SPEAK_SHORTCUT_CODE)) return;
  event.preventDefault();
  if (event.repeat) return;
  const target = container ? findSpeakTarget(container) : null;
  if (target) target.click();
  else ttsPlayer.stop();
}
