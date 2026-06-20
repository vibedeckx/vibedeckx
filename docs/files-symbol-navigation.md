# Files: Double-Click Symbol Navigation

How the Files viewer turns a double-clicked identifier into a custom "selected"
highlight, a Definitions/References popover, a copyable symbol, and click-to-jump
— and **why** the implementation looks the way it does (it fights two non-obvious
browser/React realities).

Frontend code lives in `apps/vibedeckx-ui/components/files/` and
`apps/vibedeckx-ui/hooks/use-file-browser.ts`; the search endpoint is in
`packages/vibedeckx/src/routes/file-routes.ts`.

---

## 1. What the user sees

1. **Double-click an identifier** in the source view → the word gets an amber
   highlight and a popover opens at the cursor.
2. The popover lists **Definitions** and **References** (heuristic, search-based).
3. **Ctrl/Cmd-C** while the popover is open copies the symbol.
4. **Click a hit** → the target file opens, scrolls to the line, and flashes a
   line highlight. Tree / search / jumps all share one **back/forward history**.

The feature is intentionally split into four decoupled pieces. Each can be
understood (and changed) on its own:

| Piece | Where |
|-------|-------|
| Trigger + custom highlight | `file-preview.tsx` |
| Popover + Ctrl-C copy | `symbol-nav-popover.tsx` |
| Search (Definitions/References) | `file-routes.ts` (`/api/projects/:id/symbol-search`) |
| Jump + back/forward history | `use-file-browser.ts`, `files-view.tsx` |

---

## 2. The two realities that shaped the design

Most of the complexity exists to survive these. They were found the hard way
(via on-screen range diagnostics), so they're documented here to save the next
person the same dig.

### 2a. Opening the popover clears the native selection

A double-click makes the browser natively select the word (the blue highlight).
But the instant the popover mounts (a `setState` → re-render), the browser
**clears that native selection**. So we cannot rely on the native selection (or
any `Range` captured from it) to represent the "selected" symbol while the
popover is open.

### 2b. Shiki's code text nodes are *replaced* on re-render

The code is rendered via `dangerouslySetInnerHTML` in
`components/ai-elements/code-block.tsx`. When `FilePreview` re-renders (e.g. to
open the popover), **the code's text nodes get swapped out** — the node you
captured a millisecond ago is now detached (`isConnected === false`).

Consequence: any highlight anchored to a **captured DOM node or `Range`** dies —
the range collapses to empty or points at a detached node, so there's nothing
live to paint. This is why several "obvious" approaches all failed:

| Approach | Why it failed |
|----------|---------------|
| Re-assert the captured `Range` after mount | Range collapsed to length 0 when the selection cleared |
| `document.createRange()` over the captured nodes | Captured node is detached after the re-render → paints nothing |
| `caretRangeFromPoint(x, y)` at apply time | The popover (fixed, `z-50`) covers the click point when the symbol is mid-screen → hits the popover, not the code |

---

## 3. The working approach: a node-free line+column anchor

Instead of capturing nodes, capture a **stable, DOM-free anchor** and re-resolve
it against the *live* DOM after the popover mounts.

The anchor is `{ line, start, end }`:

- `line` — the value of the `data-line` attribute that `CodeBlock` stamps on
  every line (`lineDataTransformer` in `code-block.tsx`).
- `start` / `end` — character offsets of the word **within that line element's
  text** (line-number prefix included; it's consistent on both capture and
  re-resolve, so it cancels out).

### Capture (in the double-click handler)

```
handleDoubleClick(e):
  sel = getSelection().toString()           // the word; also gates on identifier regex
  anchor = anchorFromRange(getRangeAt(0))    // -> { line, start, end }, plain data
  selection.removeAllRanges()                // kill the native blue BEFORE it paints
  setSymbolNav({ symbol, x, y, anchor })
```

`anchorFromRange` walks up to the nearest `[data-line]` ancestor and measures the
char offsets with a throwaway `Range` (`charOffsetWithin`), so it works whether
the selection's container is a text or element node.

### Re-resolve + paint (in a `useEffect` keyed on `symbolNav`)

Runs **after** the popover mounts — i.e. after the selection clear and the node
swap have already happened:

```
useEffect on [symbolNav]:
  range = rangeFromAnchor(anchor)            // query live DOM, rebuild a fresh range
  CSS.highlights.set("symbol-nav", new Highlight(range))
  cleanup: CSS.highlights.delete("symbol-nav")
```

`rangeFromAnchor` finds the visible `[data-line="N"]` (there are two copies,
light + dark; pick the one with `offsetParent !== null`), walks its text nodes by
character count (`charToPoint`) to locate start/end, and builds a fresh range over
**live** nodes — so the highlight actually paints.

`x` / `y` are used **only** to position the popover, never the highlight — which
is why a mid-screen popover covering the click point no longer breaks anything.

---

## 4. The highlight itself: CSS Custom Highlight API

The "selected" look is **not** a native selection — it's a custom highlight via
[`CSS.highlights`](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
+ `::highlight()`. It styles a `Range` without touching the DOM or the native
selection, so nothing the popover does can clear it. Two gotchas, both handled in
`ensureSymbolHlStyle`:

- **The `::highlight()` rule is injected at runtime** (a `<style>` appended to
  `<head>`), not written in `globals.css` — the build's Lightning CSS rejects
  `::highlight()` as an unknown pseudo-element, while the browser engine that
  backs the API parses it fine.
- **A literal color is used** (`rgba(255, 196, 0, 0.32)`, amber) — `var(--primary)`
  / `color-mix` don't resolve inside `::highlight()`'s restricted inheritance.

**Amber, not blue, on purpose:** the native drag-to-select selection is blue, so
the symbol highlight uses a contrasting amber to make "symbol nav (has popover)"
visually distinct from "plain text selection" — the same reasoning GitHub uses.

Feature detection (`highlightApiAvailable`) degrades gracefully: on a browser
without the API, there's simply no highlight (Ctrl-C still works).

---

## 5. Copy: Ctrl/Cmd-C writes the symbol

Because the highlight isn't a native selection, the browser has nothing to copy
on its own. While the popover is open, its keydown handler intercepts Ctrl/Cmd-C
and calls `navigator.clipboard.writeText(symbol)`. It defers to a real selection
if the user made one (so other text stays copyable). Requires a secure context
(localhost / https), which the local app satisfies.

---

## 6. The native-selection flash (and why a tiny gap remains)

A double-click paints the browser's native blue selection **instantly** (it's the
default action; we can't run before it). Our amber can only appear **after** the
popover mounts and the node swap happens (the `useEffect`). Left alone, you see
"blue, then amber".

The fix is the synchronous `selection.removeAllRanges()` in the handler: it clears
the native selection before the next paint, so **the blue never shows**. What
remains is a ~1-frame *no-highlight* gap before the amber lands — inherent to the
node-swap timing, and far less noticeable than a wrong-color flash.

---

## 7. Search, jump, and history (supporting pieces)

- **Search** — the popover calls `GET /api/projects/:id/symbol-search?symbol=…`.
  The backend runs a single `git grep` in the worktree and classifies each line
  into `definition` (keyword-prefixed heuristic) vs `reference`. No index, no
  state; it follows the existing worktree + remote-proxy path (there's a
  `/api/path/symbol-search` variant for remote execution). Precision is the same
  tier as GitHub's "search-based" navigation — name-based, not semantic.
- **Jump** — clicking a hit calls `jumpTo(file, line)` in `use-file-browser.ts`,
  which opens the file and scrolls to / flashes the line. Line addressing reuses
  `CodeBlock`'s `data-line` + the `.code-line-highlight` style. (`code` is
  `display: grid` so each `.line` is a full-width row — this also fixes a blank
  line that `display:block` line-highlighting would otherwise introduce under
  Shiki's trailing `\n`.)
- **History** — tree clicks, search hits, and jumps all funnel through
  `navigate(...)`, which pushes onto a back/forward stack (`goBack` / `goForward`,
  surfaced as arrow buttons in the Files header next to Refresh).

---

## 8. Disabling it / a single-click variant

The pieces are decoupled enough that a "disable symbol nav" setting is a **single
early-return** in `handleDoubleClick`: when off, none of the custom machinery runs
and double-click falls back to **pure native selection + native Ctrl-C**, exactly
as before the feature existed.

A GitHub-style **single-click** trigger is possible but was deliberately *not*
adopted. GitHub can let single-click-nav and double-click-select coexist because
its popover has no side effects on the selection or DOM. **Ours does** (§2), so a
single-click variant would need explicit single-vs-double-click disambiguation
(a ~200 ms timer) to preserve double-click-to-select — extra complexity and a
slight nav delay, for a gesture change that doesn't remove the §6 gap anyway.

---

## 9. File map

| File | Responsibility |
|------|----------------|
| `components/files/file-preview.tsx` | Double-click trigger, line+col anchor capture/re-resolve, custom highlight register/clear, native-selection clear, renders popover |
| `components/files/symbol-nav-popover.tsx` | Fetches results, Definitions/References UI, outside-click/Esc close, Ctrl-C copy |
| `components/ai-elements/code-block.tsx` | `data-line` stamping, `display:grid` lines, jump-to-line scroll + `.code-line-highlight` |
| `hooks/use-file-browser.ts` | `navigate` / `jumpTo` / `goBack` / `goForward` + history stack |
| `components/files/files-view.tsx` | Wires history + back/forward buttons, passes `projectId`/`branch`/`target` to the preview |
| `routes/file-routes.ts` | `symbol-search` routes (project-scoped + `/api/path/*` remote variant), `git grep` + definition heuristic |
| `app/globals.css` | `.code-line-highlight` (jump target). NB: the `::highlight()` rule is **not** here — it's injected at runtime by `file-preview.tsx` |
