// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { matchTabShortcut, tabShortcutHint } from "./tab-shortcuts";

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

afterEach(() => {
  if (realPlatform) Object.defineProperty(Navigator.prototype, "platform", realPlatform);
});

function setPlatform(platform: string) {
  Object.defineProperty(Navigator.prototype, "platform", {
    get: () => platform,
    configurable: true,
  });
}

const key = (code: string, mods: Partial<KeyboardEvent>) => ({
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  code,
  ...mods,
});

describe("matchTabShortcut", () => {
  it("maps Ctrl+Alt+<letter> to tabs on non-mac", () => {
    setPlatform("Win32");
    expect(matchTabShortcut(key("KeyA", { ctrlKey: true, altKey: true }))).toBe("agent");
    expect(matchTabShortcut(key("KeyD", { ctrlKey: true, altKey: true }))).toBe("diff");
    expect(matchTabShortcut(key("KeyB", { ctrlKey: true, altKey: true }))).toBe("preview");
    expect(matchTabShortcut(key("KeyZ", { ctrlKey: true, altKey: true }))).toBeNull();
    // Mac combo and extra modifiers must not match
    expect(matchTabShortcut(key("KeyA", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchTabShortcut(key("KeyA", { ctrlKey: true, altKey: true, metaKey: true }))).toBeNull();
  });

  it("maps Ctrl+Shift+<letter> to tabs on mac", () => {
    setPlatform("MacIntel");
    expect(matchTabShortcut(key("KeyT", { ctrlKey: true, shiftKey: true }))).toBe("terminal");
    expect(matchTabShortcut(key("KeyF", { ctrlKey: true, shiftKey: true }))).toBe("files");
    expect(matchTabShortcut(key("KeyE", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe("tabShortcutHint", () => {
  it("renders per-platform hints", () => {
    expect(tabShortcutHint(true, "KeyD")).toBe("⌃⇧D");
    expect(tabShortcutHint(false, "KeyD")).toBe("Ctrl+Alt+D");
  });
});
