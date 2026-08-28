// Registry behind the "?" keyboard-shortcuts overlay. Every global shortcut
// the app registers is listed here; the overlay renders this and nothing
// else, so keeping a new shortcut discoverable = adding one entry. Tab
// entries derive from lib/tab-shortcuts.ts (the same data the bindings and
// tooltips use), so the overlay can't drift from the actual keys.

import { TAB_SHORTCUTS, tabShortcutHint } from './tab-shortcuts';

export interface ShortcutEntry {
  /** Rendered as <kbd> chips, one per alternative binding. */
  hints: string[];
  description: string;
}

export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

const meta = (isMac: boolean, key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
const metaShift = (isMac: boolean, key: string) => (isMac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`);

export function shortcutGroups(isMac: boolean): ShortcutGroup[] {
  return [
    {
      title: 'Global',
      entries: [
        { hints: [meta(isMac, 'K')], description: 'Quick switcher' },
        { hints: [meta(isMac, 'J')], description: 'Notifications' },
        { hints: [meta(isMac, 'B')], description: 'Toggle sidebar' },
        { hints: [metaShift(isMac, 'O')], description: 'New agent conversation' },
        { hints: ['a…z'], description: 'Locate workspace (type, ↑↓ cycle, ↵ jump)' },
        { hints: ['Esc'], description: 'Clear locate query / unfocus right panel' },
        { hints: ['?', meta(isMac, '/')], description: 'This dialog' },
      ],
    },
    {
      title: 'Workspace tabs',
      entries: [
        ...TAB_SHORTCUTS.map((t) => ({
          hints: [tabShortcutHint(isMac, t.code)],
          description: `Open ${t.label}`,
        })),
        { hints: ['←', '→'], description: 'Switch executor target (Executors focused)' },
      ],
    },
  ];
}
