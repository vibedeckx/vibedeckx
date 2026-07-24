// Workspace tab shortcuts, shared between the right panel (window keydown →
// switch tab) and xterm hosts (attachCustomKeyEventHandler → let the combo
// bubble instead of sending control bytes to the PTY).
//
// Each tab is reachable via its label's first letter: ⌃⇧<letter> on macOS,
// Ctrl+Alt+<letter> elsewhere. The modifier pair differs per platform because
// each namespace is only clean on its own platform: Ctrl+Shift is the
// browser's namespace on Windows (Ctrl+Shift+T reopens a tab and can't be
// intercepted), while ⌘-based combos collide on macOS (⌘⌥D toggles the Dock,
// ⌘⇧A/B/D belong to Chrome). Known accepted exceptions: Ctrl+Alt+T opens a
// terminal on many Linux desktops, AltGr (= Ctrl+Alt) types symbols on some
// European layouts, some IMEs bind ⌃⇧<letter> (e.g. Sogou's ⌃⇧F), and macOS
// text fields lose the ⌃⇧A/E select-to-paragraph chords. Also: none of these
// fire while focus is inside the Browser preview iframe (keyboard events
// don't cross document boundaries) — same pre-existing limitation as ⌘K/⌘J.

export type TabShortcutTarget = 'agent' | 'executors' | 'diff' | 'terminal' | 'preview' | 'files';

// event.code (physical key) keeps the match stable under IMEs and non-latin
// layouts.
const CODE_TO_TAB: Record<string, TabShortcutTarget> = {
  KeyA: 'agent',
  KeyE: 'executors',
  KeyD: 'diff',
  KeyT: 'terminal',
  KeyB: 'preview',
  KeyF: 'files',
};

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type ComboKeys = Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>;

/** The tab a keyboard event addresses, or null if it isn't a tab shortcut. */
export function matchTabShortcut(event: ComboKeys): TabShortcutTarget | null {
  const comboHeld = isMacPlatform()
    ? event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    : event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
  if (!comboHeld) return null;
  return CODE_TO_TAB[event.code] ?? null;
}

export const tabShortcutHint = (isMac: boolean, code: string) =>
  `${isMac ? '⌃⇧' : 'Ctrl+Alt+'}${code.slice(3)}`;
