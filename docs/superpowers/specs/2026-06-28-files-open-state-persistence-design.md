# Files: persist & restore open state

## Problem

In the Files panel, opening a file and then switching workspace/project (or
refreshing the page) loses everything: the open file closes and the
back/forward navigation history is wiped.

Root cause: open-file state lives in plain `useState` inside `useFileBrowser`
(`hooks/use-file-browser.ts`) as a single global value — `selectedFile`,
`fileContent`, `history` — not scoped per project. `FilesView` stays mounted
across switches (no `key={projectId}`, only CSS `hidden`), but `fetchRoot` runs
on every `projectId`/`branch`/`target` change and **unconditionally clears**
`selectedFile`, `fileContent`, and `history` (`use-file-browser.ts:94-96`). So
switching away and back re-runs `fetchRoot` and resets to the empty state; the
panel has no memory of what was open per project.

## Goal

Persist the open file, the full back/forward history, and the scroll position
per project/branch/target, and restore them when returning to that
project — surviving both in-app switches and page refresh / browser restart.

## Decisions (locked)

- **Storage:** `localStorage` (resume across refresh and restart, VS Code-like).
- **Restored state:** open file + full back/forward history + scroll position
  (scroll for the currently-open file only).
- **Scroll mechanism:** pixel `scrollTop` of the scroll container, restored via
  a `ResizeObserver` re-align loop (the existing `scrollToHashTarget` pattern)
  to absorb async render height shifts.
- **Refresh button:** keeps the open file, re-fetches its content + the tree
  (does not clear the view or the stored record).

## Data model

One persisted record per project/branch/target:

```ts
type PersistedFileView = {
  selectedFile: string | null;
  history: { entries: { path: string; line: number | null }[]; index: number };
  scrollTop: number; // currently-open file only
};
```

Stored as a **single** localStorage blob — a map of `key → record` wrapped with
a schema version and an LRU cap:

```ts
{
  v: 1,
  views: { "<key>": { selectedFile, history, scrollTop, updatedAt } }
}
```

- **Key** = `projectId | branch | target` (mirrors the existing file-cache key,
  minus the file path).
- Single blob → one read/write, trivial eviction, tiny payload (paths + ints).
- **Cap ~30 keys**, evict oldest by `updatedAt` on write.
- `v` guards shape changes; on mismatch the blob is ignored (treated as empty).
- All access wrapped in try/catch — quota / unavailable / parse errors degrade
  to "no restore," never throw.

## Components

### New module: `lib/files/open-file-persistence.ts`

Pure, DOM-free, the single owner of the storage format. No other code touches
localStorage for this feature. Independently testable.

```ts
function makeKey(projectId: string, branch: string | null | undefined,
                 target: "local" | "remote" | undefined): string;
function loadView(key: string): PersistedFileView | null;
function saveView(key: string, view: PersistedFileView): void; // bumps updatedAt, evicts oldest past cap
function clearView(key: string): void;
```

### Hook: `hooks/use-file-browser.ts`

Split today's overloaded `fetchRoot` (which always wipes selected/history) into
two intents:

- **`fetchRoot()` — mount / project·branch·target switch.** Loads the tree but
  **no longer clears** `selectedFile`/`fileContent`/`history`. After the tree
  loads, call `loadView(key)` and apply it: `setHistory`, `setSelectedFile`,
  fetch that file's content (reuse `selectFile`), and emit a
  `restoreScroll: { top, nonce }` signal carrying the saved `scrollTop`. If the
  restored file 404s, fall back to the empty state and `clearView(key)`.
- **`refresh()` — Refresh button (decision (i)).** Drops the file cache and
  re-fetches the tree **and the currently-open file's content**, keeping
  `selectedFile`/`history` intact. Does not clear the stored view.

**Write path:** a debounced (~300ms) effect writes
`saveView(key, { selectedFile, history, scrollTop })` whenever `selectedFile` or
`history` changes. Scroll updates feed a ref and the same debounced writer
(scroll fires frequently).

Expose to the view: the current `restoreScroll` signal and a
`reportScroll(top: number)` callback.

### Scroll capture/restore: `components/files/file-preview.tsx` (+ `files-view.tsx` wiring)

The scroll container is the `overflow-auto` div (currently `file-preview.tsx:657`).

- Attach a `ref` to that div and a debounced `onScroll(top)` handler forwarded up
  to the hook's `reportScroll`.
- Add props `restoreScrollTop?: number` and `restoreScrollKey?: number`. An
  effect keyed on `restoreScrollKey` runs the **re-align loop**: set `scrollTop`,
  re-assert on every `ResizeObserver` reflow until layout settles (~1s) or the
  user scrolls / a jump fires. This mirrors `scrollToHashTarget`
  (`file-preview.tsx:452`) and absorbs async Shiki/markdown height changes.
- A line jump (`scrollToLine`) takes precedence over scroll restore when both
  would fire for the same open.

`files-view.tsx` wires the hook's `restoreScroll`/`reportScroll` to
`FilePreview`'s `restoreScrollTop`/`restoreScrollKey`/`onScroll`.

## Edge cases

- **Restored file deleted/moved** → content fetch 404s → `clearView(key)`, show
  "Select a file to preview."
- **localStorage disabled / full / corrupt** → silent no-op; the feature simply
  doesn't persist.
- **In-session switch** is already covered by in-memory state surviving (the
  component stays mounted); persistence makes restore robust across the
  `fetchRoot` re-run and across refresh/restart.

## Out of scope (YAGNI)

- Per-history-entry scroll position (back/forward lands at top or the jump line).
- Multi-tab live sync of open state.
- Persisting expanded-directory tree state.
- Server-side persistence.

## Affected files

- `apps/vibedeckx-ui/lib/files/open-file-persistence.ts` (new)
- `apps/vibedeckx-ui/hooks/use-file-browser.ts`
- `apps/vibedeckx-ui/components/files/file-preview.tsx`
- `apps/vibedeckx-ui/components/files/files-view.tsx`
