# Files Open-State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Files panel's open file, back/forward history, and scroll position per project/branch/target, and restore them on project switch and page refresh.

**Architecture:** A new pure localStorage module owns the storage format. `useFileBrowser` writes open-state (debounced) and, on mount/switch, restores it after loading the tree — splitting today's overloaded `fetchRoot` into a restoring `fetchRoot` and a selection-preserving `refresh`. `FilePreview` captures scroll on the single scroll container and re-applies a saved offset through async render growth.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind, browser `localStorage` + `ResizeObserver`.

## Global Constraints

- Frontend path alias `@/*` maps to `apps/vibedeckx-ui/` root.
- **No test framework is configured** (per `CLAUDE.md`). Verification is type-check + lint + a manual smoke checklist — there are no unit-test steps.
- Backend type-check is irrelevant here; this is frontend-only.
- Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Frontend lint: `pnpm --filter vibedeckx-ui lint`
- Storage schema version is `1`; bump and ignore-on-mismatch if the shape ever changes.
- Debounce: persistence writes ~300ms; scroll-report ~200ms; scroll re-align window ~1500ms.

---

### Task 1: Persistence module

The single owner of the localStorage format. Pure, DOM-free except for the `localStorage` global, all access wrapped so quota/disabled/corrupt never throws.

**Files:**
- Create: `apps/vibedeckx-ui/lib/files/open-file-persistence.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PersistedFileView = { selectedFile: string | null; history: { entries: { path: string; line: number | null }[]; index: number }; scrollTop: number }`
  - `makeKey(projectId: string, branch: string | null | undefined, target: "local" | "remote" | undefined): string`
  - `loadView(key: string): PersistedFileView | null`
  - `saveView(key: string, view: PersistedFileView): void`
  - `clearView(key: string): void`

- [ ] **Step 1: Create the module**

```ts
// Persists the Files panel's open state (selected file + back/forward history +
// scroll position) per project/branch/target, so switching projects or
// refreshing the page restores where the user left off. The whole feature's
// localStorage access lives here; everything is wrapped so a disabled/full/
// corrupt store degrades to "no restore" rather than throwing.

const STORAGE_KEY = "vibedeckx:files:views";
const SCHEMA_VERSION = 1;
const MAX_VIEWS = 30;
const KEY_SEP = "|";

export interface PersistedHistory {
  entries: { path: string; line: number | null }[];
  index: number;
}

export interface PersistedFileView {
  selectedFile: string | null;
  history: PersistedHistory;
  scrollTop: number;
}

interface StoredRecord extends PersistedFileView {
  updatedAt: number;
}

interface StoredBlob {
  v: number;
  views: Record<string, StoredRecord>;
}

// Identifies one persisted view. Mirrors the file-content cache key in
// use-file-browser.ts, minus the file path.
export function makeKey(
  projectId: string,
  branch: string | null | undefined,
  target: "local" | "remote" | undefined
): string {
  return [projectId, branch ?? "", target ?? ""].join(KEY_SEP);
}

function emptyBlob(): StoredBlob {
  return { v: SCHEMA_VERSION, views: {} };
}

function readBlob(): StoredBlob {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyBlob();
    const parsed = JSON.parse(raw) as StoredBlob;
    if (!parsed || parsed.v !== SCHEMA_VERSION || typeof parsed.views !== "object") {
      return emptyBlob();
    }
    return parsed;
  } catch {
    return emptyBlob();
  }
}

function writeBlob(blob: StoredBlob): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Quota exceeded or storage disabled — drop the write silently.
  }
}

export function loadView(key: string): PersistedFileView | null {
  const rec = readBlob().views[key];
  if (!rec) return null;
  return {
    selectedFile: rec.selectedFile,
    history: rec.history,
    scrollTop: rec.scrollTop,
  };
}

export function saveView(key: string, view: PersistedFileView): void {
  const blob = readBlob();
  blob.views[key] = { ...view, updatedAt: Date.now() };
  // Evict the oldest entries once past the cap.
  const keys = Object.keys(blob.views);
  if (keys.length > MAX_VIEWS) {
    keys
      .sort((a, b) => blob.views[a].updatedAt - blob.views[b].updatedAt)
      .slice(0, keys.length - MAX_VIEWS)
      .forEach((k) => delete blob.views[k]);
  }
  writeBlob(blob);
}

export function clearView(key: string): void {
  const blob = readBlob();
  if (blob.views[key]) {
    delete blob.views[key];
    writeBlob(blob);
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: (Optional) sanity-check the pure logic**

There is no test runner, so this is a throwaway manual check, not committed:
Run: `cd apps/vibedeckx-ui && node -e "global.localStorage={_:{},getItem(k){return this._[k]??null},setItem(k,v){this._[k]=v}}; (async()=>{const m=await import('./lib/files/open-file-persistence.ts').catch(()=>null); console.log('module import is TS-only; rely on tsc + manual smoke test');})()"`
Expected: confirms the module is TS (import via node isn't the verification path). The real verification is the manual smoke test in Task 4. Skip if it adds friction.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/files/open-file-persistence.ts
git commit -m "feat(files): localStorage module for persisted open-state"
```

---

### Task 2: Hook — restore on mount, split refresh, persistence wiring

Rework `useFileBrowser` so `fetchRoot` restores saved state, a new `refresh` keeps the open file, and changes to selection/history/scroll get persisted (debounced) — guarded so a project switch can't write the old project's selection under the new key.

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-file-browser.ts`

**Interfaces:**
- Consumes (Task 1): `makeKey`, `loadView`, `saveView`, `clearView`, `PersistedFileView`.
- Produces (for Task 4, added to the hook's return object):
  - `refresh: () => Promise<void>`
  - `reportScroll: (top: number) => void`
  - `restoreScroll: { top: number; nonce: number } | null`
  - (`fetchRoot` stays in the return; its behavior changes.)

- [ ] **Step 1: Add `useEffect` to the React import and import the persistence module**

Change line 3 from:
```ts
import { useState, useCallback, useRef } from "react";
```
to:
```ts
import { useState, useCallback, useEffect, useRef } from "react";
```

Add after the existing imports (after line 6):
```ts
import {
  makeKey,
  loadView,
  saveView,
  clearView,
  type PersistedFileView,
} from "@/lib/files/open-file-persistence";
```

- [ ] **Step 2: Add persistence state/refs after the existing refs (after line 72, before the `cacheKey` callback)**

```ts
  // --- persisted open-state wiring (lib/files/open-file-persistence.ts) ---
  // Key for the active project/branch/target. Null while no project is selected.
  const persistKey = projectId ? makeKey(projectId, branch, target) : null;
  const persistKeyRef = useRef<string | null>(persistKey);
  persistKeyRef.current = persistKey;
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  // Latest known scroll offset of the open file, reported by FilePreview.
  const scrollTopRef = useRef(0);
  // The key whose state is currently "settled" in selectedFile/history. Writes
  // are suppressed until fetchRoot finishes restoring for a new key, so the
  // previous project's selection can't be saved under the new project's key.
  const restoredKeyRef = useRef<string | null>(null);
  // Bumps each restore so FilePreview re-applies the saved scroll position.
  const restoreNonceRef = useRef(0);
  const [restoreScroll, setRestoreScroll] = useState<{ top: number; nonce: number } | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 3: Add the persist helpers after `cacheKey` (after line 79)**

```ts
  // Write the current open-state for the active key. No-op until the key's state
  // has been restored/settled — this is the cross-project clobber guard.
  const persistView = useCallback(() => {
    const key = persistKeyRef.current;
    if (!key || restoredKeyRef.current !== key) return;
    const view: PersistedFileView = {
      selectedFile: selectedFileRef.current,
      history: historyRef.current,
      scrollTop: scrollTopRef.current,
    };
    saveView(key, view);
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistView();
    }, 300);
  }, [persistView]);

  // FilePreview calls this as the user scrolls the open file.
  const reportScroll = useCallback((top: number) => {
    scrollTopRef.current = top;
    schedulePersist();
  }, [schedulePersist]);

  // Persist whenever the open file or its history changes (the guard inside
  // persistView keeps restore-time and cross-project churn from writing).
  useEffect(() => {
    schedulePersist();
  }, [selectedFile, history, schedulePersist]);
```

- [ ] **Step 4: Extract a content loader and reduce `selectFile` to use it.** Replace the whole current `selectFile` (lines 147-178) with:

```ts
  // Fetch + cache a file's content into state. Returns the outcome so callers
  // can react to a missing file ("failed") without disturbing a newer selection
  // ("stale").
  const loadFileContent = useCallback(
    async (filePath: string): Promise<"loaded" | "failed" | "stale"> => {
      if (!projectId) return "failed";
      const key = cacheKey(filePath);
      const cached = fileCacheRef.current.get(key);
      if (cached) {
        setFileContent(cached);
        setFileLoading(false);
        return "loaded";
      }
      const reqId = ++selectKeyRef.current;
      setFileLoading(true);
      setFileContent(null);
      try {
        const result = await api.getFileContent(projectId, filePath, branch, target);
        if (reqId !== selectKeyRef.current) return "stale";
        fileCacheRef.current.set(key, result);
        setFileContent(result);
        return "loaded";
      } catch (err) {
        if (reqId !== selectKeyRef.current) return "stale";
        console.error("Failed to get file content:", err);
        setFileContent(null);
        return "failed";
      } finally {
        if (reqId === selectKeyRef.current) setFileLoading(false);
      }
    },
    [projectId, branch, target, cacheKey]
  );

  const selectFile = useCallback(
    async (filePath: string) => {
      if (!projectId) return;
      setSelectedFile(filePath);
      await loadFileContent(filePath);
    },
    [projectId, loadFileContent]
  );
```

- [ ] **Step 5: Replace `fetchRoot` (lines 81-107) with a tree loader + restoring fetchRoot + selection-preserving refresh.** Place these where `fetchRoot` currently sits (they reference `loadFileContent`, which is now defined later in the file — so move this block to AFTER the `selectFile`/`loadFileContent` definitions from Step 4, i.e. just before `navigate`).

Delete the old `fetchRoot` (lines 81-107) and insert this block immediately after the `selectFile` definition:

```ts
  // Load the root listing only. Returns true if the load completed and is still
  // the latest request (not superseded by a newer project/branch/target).
  const loadRootTree = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    setRootLoading(true);
    const key = ++fetchKeyRef.current;
    try {
      const result = await api.browseProjectDirectory(projectId, undefined, branch, target, showHidden);
      if (key !== fetchKeyRef.current) return false;
      setRootEntries(result.items);
      setDirectoryContents(new Map());
      setExpandedDirs(new Set());
      return true;
    } catch (err) {
      console.error("Failed to browse root directory:", err);
      if (key !== fetchKeyRef.current) return false;
      setRootEntries([]);
      toast.error("Failed to browse files", {
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      if (key === fetchKeyRef.current) setRootLoading(false);
    }
  }, [projectId, branch, target, showHidden]);

  // Mount / project·branch·target switch: load the tree, then restore the saved
  // open file + history + scroll for this key. No saved file → empty state.
  const fetchRoot = useCallback(async () => {
    if (!projectId) return;
    const ok = await loadRootTree();
    if (!ok) return;
    const key = persistKeyRef.current;
    const saved = key ? loadView(key) : null;
    if (key && saved && saved.selectedFile) {
      setHistory(
        saved.history.entries.length
          ? saved.history
          : { entries: [{ path: saved.selectedFile, line: null }], index: 0 }
      );
      scrollTopRef.current = saved.scrollTop;
      setRestoreScroll({ top: saved.scrollTop, nonce: ++restoreNonceRef.current });
      setSelectedFile(saved.selectedFile);
      // Settle the key BEFORE the async load so the load's state writes persist.
      restoredKeyRef.current = key;
      const status = await loadFileContent(saved.selectedFile);
      if (status === "failed") {
        // The restored file is gone — fall back to empty and forget the view.
        setSelectedFile(null);
        setHistory({ entries: [], index: -1 });
        scrollTopRef.current = 0;
        clearView(key);
      }
    } else {
      setSelectedFile(null);
      setFileContent(null);
      setHistory({ entries: [], index: -1 });
      scrollTopRef.current = 0;
      restoredKeyRef.current = key;
    }
  }, [projectId, loadRootTree, loadFileContent]);

  // Manual Refresh: drop cached content and re-fetch the tree AND the open
  // file's content, but keep the current selection + history (and saved view).
  const refresh = useCallback(async () => {
    if (!projectId) return;
    fileCacheRef.current.clear();
    const ok = await loadRootTree();
    if (!ok) return;
    const current = selectedFileRef.current;
    if (current) await loadFileContent(current);
  }, [projectId, loadRootTree, loadFileContent]);
```

Note: `fetchRoot` no longer clears the file cache — caches are keyed by project/branch/target/path so stale entries from other keys are harmless, and keeping them makes returning to a project instant. Only `refresh` clears, because it means "give me fresh content."

- [ ] **Step 6: Export the new members.** In the return object (currently lines 312-337), add `refresh`, `reportScroll`, and `restoreScroll` alongside `fetchRoot`:

```ts
    fetchRoot,
    refresh,
    reportScroll,
    restoreScroll,
    toggleDirectory,
```

- [ ] **Step 7: Type-check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors. (If tsc reports `loadFileContent` used before definition, confirm the Step 5 block was placed AFTER the Step 4 `selectFile`/`loadFileContent` block.)

- [ ] **Step 8: Lint**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors/warnings for this file. The persist `useEffect` deps are `[selectedFile, history, schedulePersist]` — complete, no disable needed.

- [ ] **Step 9: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-file-browser.ts
git commit -m "feat(files): restore open-state on switch, persist on change"
```

---

### Task 3: FilePreview — scroll capture & restore

Capture the scroll container's offset (debounced) and report it up; re-apply a saved offset once content renders, holding it through async height growth.

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/file-preview.tsx`

**Interfaces:**
- Consumes (Task 2, via Task 4 wiring): `restoreScrollTop`, `restoreScrollKey`, `onScroll`.
- Produces: scroll events surfaced through the `onScroll` prop.

- [ ] **Step 1: Extend the props interface (after line 291's `onJump`)**

In `FilePreviewProps` add:
```ts
  // Restore a saved scroll offset for the open file; restoreScrollKey bumps per
  // restore so the same offset re-applies. onScroll reports live scrolling up.
  restoreScrollTop?: number | null;
  restoreScrollKey?: number;
  onScroll?: (top: number) => void;
```

And add them to the destructured params (in the `export function FilePreview({ ... })` list, after `onJump`):
```ts
  restoreScrollTop,
  restoreScrollKey,
  onScroll,
```

- [ ] **Step 2: Add the scroll refs + handler + effects.** Place this block alongside the other refs/effects, before the first early return (e.g. right after the `useEffect(() => () => realignCleanupRef.current?.(), []);` at line 485):

```ts
  // The scroll container (the overflow-auto content div below). Capturing and
  // restoring scrollTop here covers both source code and rendered markdown — the
  // CodeBlock's inner divs auto-size to content, so this is the only scroller.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // True while a restore is programmatically driving scrollTop, so partial
  // (pre-render) offsets don't get reported back and overwrite the saved value.
  const restoringScrollRef = useRef(false);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const scrollReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A saved offset waiting to be applied once the content (and thus the scroll
  // container) is in the DOM — on restore the preview first renders a loading
  // state with no container.
  const pendingRestoreRef = useRef<number | null>(null);

  const handleContainerScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (restoringScrollRef.current) return;
    const top = e.currentTarget.scrollTop;
    if (scrollReportTimerRef.current) clearTimeout(scrollReportTimerRef.current);
    scrollReportTimerRef.current = setTimeout(() => onScrollRef.current?.(top), 200);
  }, []);

  // Record a restore request; applied by the effect below once content lands.
  useEffect(() => {
    if (restoreScrollKey === undefined) return;
    pendingRestoreRef.current = restoreScrollTop ?? 0;
  }, [restoreScrollKey, restoreScrollTop]);

  // Reset to top when a different file opens, so a fresh open doesn't inherit
  // the previous file's offset. Declared BEFORE the restore-apply effect so that
  // on a mount-restore (filePath + content change together) restore wins.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = 0;
  }, [filePath]);

  // Apply a pending restore once the scroll container exists, holding the offset
  // through async render growth (Shiki/markdown). Mirrors scrollToHashTarget.
  useEffect(() => {
    const target = pendingRestoreRef.current;
    if (target == null) return;
    const el = scrollContainerRef.current;
    if (!el) return; // preview still loading — retry when content arrives
    pendingRestoreRef.current = null;
    if (!target) return; // 0 → already reset to top
    restoringScrollRef.current = true;
    const align = () => {
      el.scrollTop = target;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(el.firstElementChild ?? el);
    const stop = () => {
      restoringScrollRef.current = false;
      observer.disconnect();
      window.clearTimeout(timer);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
      el.removeEventListener("keydown", stop);
    };
    // Real-content height settles within ~1s; give restore a little more.
    const timer = window.setTimeout(stop, 1500);
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    el.addEventListener("keydown", stop);
    return stop;
  }, [fileContent]);
```

- [ ] **Step 3: Attach the ref + scroll handler to the scroll container.** Change the content `div` (currently line 657):

```tsx
      {/* Content */}
      <div className="flex-1 overflow-auto" ref={scrollContainerRef} onScroll={handleContainerScroll}>
```

- [ ] **Step 4: Type-check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors. The restore-apply effect intentionally keys on `[fileContent]` (it reads `pendingRestoreRef`/`restoreScrollTop` via refs); if lint flags exhaustive-deps, add `// eslint-disable-next-line react-hooks/exhaustive-deps` above the dep array with a one-line reason, matching the existing `navRequest` pattern in files-view.tsx.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/files/file-preview.tsx
git commit -m "feat(files): capture and restore preview scroll position"
```

---

### Task 4: Wire FilesView + end-to-end verification

Connect the hook's new outputs to `FilePreview` and point Refresh at `refresh`.

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx`

**Interfaces:**
- Consumes (Task 2): `refresh`, `reportScroll`, `restoreScroll`.

- [ ] **Step 1: Destructure the new hook members.** In the `useFileBrowser` destructure (lines 43-70), add `refresh`, `reportScroll`, and `restoreScroll`:

```ts
    jumpTarget,
    canGoBack,
    canGoForward,
    fetchRoot,
    refresh,
    reportScroll,
    restoreScroll,
    toggleDirectory,
```

- [ ] **Step 2: Point Refresh at `refresh`.** Replace `handleRefresh` (lines 88-91):

```ts
  // Refresh re-fetches the tree, the open file's content, and the search cache —
  // keeping the current file open (just reloading it from disk).
  const handleRefresh = useCallback(() => {
    refresh();
    search.refresh();
  }, [refresh, search]);
```

(The mount effect at lines 74-76 still calls `fetchRoot` — leave it.)

- [ ] **Step 3: Pass restore/scroll props to FilePreview** (in the `<FilePreview ... />`, lines 296-307), after `onJump={jumpTo}`:

```tsx
              onJump={jumpTo}
              restoreScrollTop={restoreScroll?.top ?? null}
              restoreScrollKey={restoreScroll?.nonce}
              onScroll={reportScroll}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors.

- [ ] **Step 6: Manual smoke test** (the real verification — there is no test runner)

Run the app: `pnpm dev:all` then open `http://localhost:3000`.

Verify each:
1. **Switch & return:** Open a file in Files, scroll partway down, navigate it (open a 2nd file, jump to a symbol so back/forward has entries), then switch to another project/workspace and switch back. → The same file reopens, scrolled to the same place, with back/forward still working.
2. **Refresh page:** With a file open and scrolled, reload the browser tab. → File reopens at the same scroll position; back/forward history intact.
3. **Refresh button:** Click the Refresh icon. → The open file stays open (content reloaded), the panel does not blank out.
4. **New file navigation:** Click a different file in the tree. → It opens scrolled to the top (no inherited offset).
5. **Deleted-file fallback:** Open a file, switch away, delete that file on disk, switch back. → Panel shows "Select a file to preview." (no error spinner stuck), and the saved view is cleared (switching away/back again stays empty).
6. **Per-project isolation:** Open file A in project 1 and file B in project 2; switch between them. → Each project restores its own file, not the other's.
7. **Private/incognito or storage-disabled:** Feature simply doesn't persist; no console errors, Files still works.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/files/files-view.tsx
git commit -m "feat(files): wire scroll persistence and selection-preserving refresh"
```

---

## Self-Review

**Spec coverage:**
- localStorage, per project/branch/target, single versioned blob with LRU cap → Task 1. ✓
- Restore open file + full history + scroll → Task 2 (`fetchRoot` restore) + Task 3 (scroll). ✓
- Pixel `scrollTop` + ResizeObserver re-align loop → Task 3. ✓
- Refresh keeps the open file, re-fetches content + tree, doesn't clear view → Task 2 (`refresh`) + Task 4 (wire). ✓
- Edge: restored file 404 → clear + empty → Task 2 (`status === "failed"`). ✓
- Edge: localStorage disabled/full/corrupt → silent no-op → Task 1 (try/catch). ✓
- New module `open-file-persistence.ts`; modified hook, file-preview, files-view → all four tasks match the spec's "Affected files". ✓
- Out-of-scope items (per-entry scroll, multi-tab sync, tree expansion, server persistence) → not implemented. ✓

**Type consistency:** `makeKey`/`loadView`/`saveView`/`clearView`/`PersistedFileView` names match between Task 1 and Task 2. `refresh`/`reportScroll`/`restoreScroll` produced by Task 2 are consumed verbatim in Task 4. `restoreScrollTop`/`restoreScrollKey`/`onScroll` produced by Task 3 are passed verbatim in Task 4. `restoreScroll` shape `{ top, nonce }` maps to `restoreScrollTop={...top}` / `restoreScrollKey={...nonce}`. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete. The only "optional" step (Task 1 Step 3) is explicitly a throwaway sanity check, with the real verification deferred to Task 4's smoke test. ✓

**Ordering note (the one subtle hazard):** Task 2 Step 5 must be placed after Task 2 Step 4 (`loadFileContent` defined before `fetchRoot`/`refresh` use it), and Task 3's reset-to-top effect must be declared before the restore-apply effect. Both are called out inline.
