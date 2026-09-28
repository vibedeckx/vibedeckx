// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const player = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("./tts-player", () => ({ ttsPlayer: player }));

import { findSpeakTarget, handleSpeakShortcut } from "./speak-shortcut";

function setRect(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top }) as DOMRect;
}

/** A scroller showing viewport y ∈ [100, 500], holding messages at the given [top, bottom] boxes. */
function transcript(boxes: Array<[number, number] | { box: [number, number]; speakable: false }>) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  setRect(scroller, 100, 500);
  const container = document.createElement("div");
  scroller.appendChild(container);
  const buttons = boxes.map((entry) => {
    const [top, bottom] = Array.isArray(entry) ? entry : entry.box;
    const message = document.createElement("div");
    message.setAttribute("data-speak-message", "");
    setRect(message, top, bottom);
    const button = document.createElement("button");
    if (Array.isArray(entry)) button.setAttribute("data-speak-button", "");
    message.appendChild(button);
    container.appendChild(message);
    return button;
  });
  document.body.appendChild(scroller);
  return { container, buttons };
}

afterEach(() => {
  document.body.innerHTML = "";
  player.stop.mockReset();
});

describe("findSpeakTarget", () => {
  it("picks the lowest message on screen", () => {
    const { container, buttons } = transcript([[120, 200], [220, 300], [320, 400]]);
    expect(findSpeakTarget(container)).toBe(buttons[2]);
  });

  it("skips messages scrolled out of the scroller", () => {
    const { container, buttons } = transcript([[-300, 50], [150, 300], [600, 800]]);
    expect(findSpeakTarget(container)).toBe(buttons[1]);
  });

  it("ignores a reply peeking just a few pixels into view", () => {
    const { container, buttons } = transcript([[150, 400], [490, 900]]);
    expect(findSpeakTarget(container)).toBe(buttons[0]);
  });

  it("counts a short reply that is fully visible", () => {
    const { container, buttons } = transcript([[150, 400], [470, 490]]);
    expect(findSpeakTarget(container)).toBe(buttons[1]);
  });

  it("passes over messages without a speak button", () => {
    const { container, buttons } = transcript([[150, 300], { box: [320, 400], speakable: false }]);
    expect(findSpeakTarget(container)).toBe(buttons[0]);
  });

  it("returns null when nothing speakable is on screen", () => {
    const { container } = transcript([[-300, 50], [600, 800]]);
    expect(findSpeakTarget(container)).toBeNull();
  });
});

describe("handleSpeakShortcut", () => {
  // jsdom reports a non-Mac platform, so the combo is Ctrl+Alt+S.
  const press = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { code: "KeyS", ctrlKey: true, altKey: true, cancelable: true, ...init });

  it("clicks the lowest visible reply's button even while another reply plays", () => {
    // The button's own toggle switches playback to it (or stops it if it is
    // the one playing) — the shortcut must not stop first and leave silence.
    const { container, buttons } = transcript([[120, 200], [220, 300]]);
    const clicked = vi.fn();
    buttons[1].addEventListener("click", clicked);
    const event = press();
    handleSpeakShortcut(event, container);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores key repeat", () => {
    const { container, buttons } = transcript([[120, 200]]);
    const clicked = vi.fn();
    buttons[0].addEventListener("click", clicked);
    const event = press({ repeat: true });
    handleSpeakShortcut(event, container);
    expect(clicked).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("stops playback when no reply is on screen", () => {
    const { container } = transcript([[-300, 50]]);
    handleSpeakShortcut(press(), container);
    expect(player.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores other combos", () => {
    const { container, buttons } = transcript([[120, 200]]);
    const clicked = vi.fn();
    buttons[0].addEventListener("click", clicked);
    const event = press({ code: "KeyR" });
    handleSpeakShortcut(event, container);
    expect(clicked).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
