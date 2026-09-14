// The app's ⌃⇧/Ctrl+Alt shortcut namespace: the workspace tab shortcuts plus
// the few non-tab bindings that share the same modifier pair (Start review).
// Shared between the right panel (window keydown → switch tab), the dialogs
// that bind their own letter, and xterm hosts
// (attachCustomKeyEventHandler → let the combo bubble instead of sending
// control bytes to the PTY).
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

// Single source of truth for tab ids, display labels, and bound keys — the
// right panel (buttons + tooltips), the shortcuts overlay, and the xterm
// passthrough all render/match from this list so they can't drift apart.
// event.code (physical key) keeps the match stable under IMEs and non-latin
// layouts.
export const TAB_SHORTCUTS = [
  { id: 'agent', label: 'Agent', code: 'KeyA' },
  { id: 'executors', label: 'Executors', code: 'KeyE' },
  { id: 'diff', label: 'Diff', code: 'KeyD' },
  { id: 'terminal', label: 'Terminal', code: 'KeyT' },
  { id: 'preview', label: 'Browser', code: 'KeyB' },
  { id: 'files', label: 'Files', code: 'KeyF' },
] as const satisfies ReadonlyArray<{ id: TabShortcutTarget; label: string; code: string }>;

const CODE_TO_TAB: Record<string, TabShortcutTarget> = Object.fromEntries(
  TAB_SHORTCUTS.map((t) => [t.code, t.id]),
);

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// Non-tab bindings in the same namespace, listed here so anyone picking a new
// letter sees every claimed key. Unlike the tab shortcuts these are scoped to
// one panel (Start review is bound only while the Agent tab is on screen), so
// they need no xterm passthrough — no terminal is ever mounted there.
export const REVIEW_SHORTCUT_CODE = 'KeyR';

type ComboKeys = Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>;

const comboHeld = (event: ComboKeys) =>
  isMacPlatform()
    ? event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    : event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;

/** The tab a keyboard event addresses, or null if it isn't a tab shortcut. */
export function matchTabShortcut(event: ComboKeys): TabShortcutTarget | null {
  if (!comboHeld(event)) return null;
  return CODE_TO_TAB[event.code] ?? null;
}

/** Whether the event is the platform combo plus `code` — for non-tab bindings. */
export const matchComboShortcut = (event: ComboKeys, code: string) =>
  comboHeld(event) && event.code === code;

export const comboShortcutHint = (isMac: boolean, code: string) =>
  `${isMac ? '⌃⇧' : 'Ctrl+Alt+'}${code.slice(3)}`;
