# Files: Symbol Navigation (click / double-click)

How the Files viewer turns a clicked identifier into a custom highlight (or a
native selection), a Definitions/References popover, a copyable symbol, and
click-to-jump — and **why** the implementation looks the way it does (it fights
two non-obvious browser/React realities).

Frontend code lives in `apps/vibedeckx-ui/components/files/` and
`apps/vibedeckx-ui/hooks/use-file-browser.ts`; the search endpoint is in
`packages/vibedeckx/src/routes/file-routes.ts`.

---

## 1. What the user sees

- **Single-click an identifier** → the word gets an **amber** highlight and a
  popover opens next to it.
- **Double-click an identifier** → the word gets a **real native (blue)
  selection** (extendable, natively copyable) and the same popover opens.
- The popover lists **Definitions** and **References** (heuristic, search-based).
- **Ctrl/Cmd-C** copies the symbol (single-click: written to the clipboard;
  double-click: the native selection is copied normally).
- **Click a hit** → the target file opens, scrolls to the line, flashes a line
  highlight. Tree / search / jumps all share one **back/forward history**.

The feature is intentionally split into decoupled pieces:

| Piece | Where |
|-------|-------|
| Trigger + highlight/selection | `file-preview.tsx` |
| Popover (positioning, copy, close) | `symbol-nav-popover.tsx` |
| Search (Definitions/References) | `file-routes.ts` (`/api/projects/:id/symbol-search`) |
| Jump + back/forward history | `use-file-browser.ts`, `files-view.tsx` |

---

## 2. The two realities that shaped the design

Most of the complexity exists to survive these. They were found the hard way (via
on-screen range diagnostics), so they're recorded here to save the next dig.

### 2a. Opening the popover clears the native selection

Opening the popover is a `setState` → re-render, and that **clears the browser's
native text selection**. So we can't rely on the native selection to keep
representing the symbol once the popover is open.

### 2b. Shiki's code text nodes are *replaced* on re-render

The code is rendered via `dangerouslySetInnerHTML` in
`components/ai-elements/code-block.tsx`. When `FilePreview` re-renders (e.g. to
open the popover), **the code's text nodes get swapped out** — a node captured a
millisecond earlier is now detached (`isConnected === false`).

Consequence: any highlight anchored to a **captured DOM node or `Range`** dies —
the range collapses to empty or points at a detached node, so there's nothing
live to paint. Several "obvious" approaches all failed for this reason:

| Approach | Why it failed |
|----------|---------------|
| Re-assert a captured `Range` after mount | Range collapsed to length 0 when the selection cleared |
| `document.createRange()` over captured nodes | Captured node is detached after the re-render (`conn=false`) → paints nothing |
| `caretRangeFromPoint(x, y)` **at apply time** | The popover (fixed, `z-50`) covers the click point when mid-screen → hits the popover, not the code |

The fix to the last one is positional, see §6 — the popover is kept off the
symbol so the click point always resolves to code.

---

## 3. The node-free line+column anchor

Instead of capturing nodes, capture a **stable, DOM-free anchor** and re-resolve
it against the *live* DOM after the popover mounts.

The anchor is `{ line, start, end }`:

- `line` — the `data-line` attribute `CodeBlock` stamps on every line
  (`lineDataTransformer` in `code-block.tsx`).
- `start` / `end` — character offsets of the word **within that line element's
  text** (line-number prefix included; consistent on capture and re-resolve, so
  it cancels out).

`anchorFromRange` measures the offsets with a throwaway `Range`
(`charOffsetWithin`). `rangeFromAnchor` rebuilds a fresh range later: it finds the
visible `[data-line="N"]` (there are two copies, light + dark — pick the one with
`offsetParent !== null`), walks its text nodes by character count
(`charToPoint`), and builds a range over **live** nodes.

The anchor is captured in the click handler (while the DOM is still original) and
**applied in a `useEffect` keyed on `symbolNav`** (after the re-render, where the
fresh range resolves against the swapped-in live nodes).

---

## 4. The click model: single vs double via `MouseEvent.detail`

The trigger is `onClick` on the source container. Single vs double click is told
apart by `e.detail` (1 vs 2) — **no disambiguation timer**, because both clicks
open the popover, so there's nothing to wait for.

```
handleClick(e):
  if e.detail >= 2:                          # second click of a double-click
    getSelection().removeAllRanges()         # kill the popover-text selection
    setSymbolNav(prev => { ...prev, selectWord: true })   # REUSE the 1st anchor
    return
  if selection non-collapsed: return         # a drag-select — don't hijack it
  found = wordFromPoint(e.clientX, e.clientY) # caretRangeFromPoint + word expand
  if !found: return
  getSelection().removeAllRanges()           # kill the native blue before it paints
  setSymbolNav({ symbol, x, y, anchor, selectWord: false })
```

Key points:

- **Single-click has no native selection to read**, so the word is found from the
  click point via `wordFromPoint` (`caretRangeFromPoint` / `caretPositionFromPoint`
  → expand to identifier chars → `anchorFromRange`).
- **The second click of a double-click REUSES the first click's anchor**, it does
  *not* re-detect from coordinates — by then the popover exists and (before §6)
  could be under the cursor; coordinates would resolve into the popover.

Then the apply effect branches on `selectWord`:

```
useEffect on [symbolNav]:
  range = rangeFromAnchor(anchor)
  if selectWord:                              # double-click → real native selection
    clear amber; getSelection().removeAllRanges(); addRange(range)
  else:                                        # single-click → custom highlight
    CSS.highlights.set("symbol-nav", new Highlight(range))   # cleanup: delete
```

---

## 5. The custom highlight: CSS Custom Highlight API

The single-click "selected" look is **not** a native selection — it's a custom
highlight via [`CSS.highlights`](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
+ `::highlight()`. It styles a `Range` without touching the DOM or the native
selection, so nothing the popover does can clear it. Two gotchas, both in
`ensureSymbolHlStyle`:

- **The `::highlight()` rule is injected at runtime** (a `<style>` appended to
  `<head>`), not written in `globals.css` — the build's Lightning CSS rejects
  `::highlight()` as an unknown pseudo-element; the browser engine parses it fine.
- **A literal color is used** (`rgba(255, 196, 0, 0.32)`, amber) — `var(--primary)`
  / `color-mix` don't resolve inside `::highlight()`'s restricted inheritance.

**Amber, not blue, on purpose:** the native selection (drag-select, and the
double-click selection) is blue, so single-click uses a contrasting amber — you
can tell "symbol nav highlight" apart from "real text selection" at a glance, the
same reasoning GitHub uses.

`highlightApiAvailable` degrades gracefully: no API → no amber (copy still works).

---

## 6. Popover positioning: never cover the symbol

`symbol-nav-popover.tsx` positions the popover so it **never overlaps the clicked
line**: open `GAP` (18px) below the click; if it doesn't fit (symbol low on
screen), **flip above** the click instead of sliding up over it. Height adapts to
the available space.

This is load-bearing, not cosmetic:

- It's why a double-click's second click lands on the **code** (not the popover),
  so the native word selection is correct and visible.
- It's why resolving the click point to code is reliable (the failed
  `caretRangeFromPoint` row in §2).

Two more popover behaviors support the double-click upgrade:

- **Outside-click close ignores `e.detail >= 2`** — otherwise the second click of
  a double-click (which lands on the code, *outside* the popover) would dismiss
  the popover before it can be upgraded to a selection.
- **The popover root is `select-none`** — a belt-and-suspenders guard so that if a
  double-click ever does land on it, the browser selects no popover text.

---

## 7. Copy, the flash, and residual costs

**Copy.** On single-click the amber highlight isn't a native selection, so the
popover's keydown handler intercepts Ctrl/Cmd-C and calls
`navigator.clipboard.writeText(symbol)` (deferring to a real selection if the user
made one). On double-click there *is* a native selection, so Ctrl-C copies it
normally. Needs a secure context (localhost / https), which the local app meets.

**No blue flash on single-click.** A click/double-click paints the browser's
native blue selection instantly; the synchronous `removeAllRanges()` in the
handler clears it before the next paint, so single-click shows amber, not blue.

**Residual costs (accepted):**

- **Double-click shows a brief amber → blue flip.** A double-click is two clicks:
  the first (detail 1) opens the popover with amber, the second (detail 2) upgrades
  to the native selection. Removing this flip would require the disambiguation
  timer we deliberately avoid.
- **Single-click is intrusive by nature** — clicking any identifier opens the
  popover. Acceptable in a read-only viewer; the disable gate (§9) turns it off.
- **~1-frame highlight gap** before the amber lands (inherent to §2b's node swap).

---

## 8. Search, jump, and history (supporting pieces)

- **Search** — the popover calls `GET /api/projects/:id/symbol-search?symbol=…`.
  The backend runs a single `git grep` in the worktree and classifies each line
  into `definition` (keyword-prefixed heuristic) vs `reference`. No index, no
  state; follows the existing worktree + remote-proxy path (there's a
  `/api/path/symbol-search` variant for remote execution). Precision is GitHub's
  "search-based" tier — name-based, not semantic.
- **Jump** — clicking a hit calls `jumpTo(file, line)` in `use-file-browser.ts`,
  which opens the file and scrolls to / flashes the line. Line addressing reuses
  `CodeBlock`'s `data-line` + the `.code-line-highlight` style. (`code` is
  `display: grid` so each `.line` is a full-width row — this also fixes a blank
  line that `display:block` line-highlighting would introduce under Shiki's
  trailing `\n`.)
- **History** — tree clicks, search hits, and jumps all funnel through
  `navigate(...)`, which pushes onto a back/forward stack (`goBack` / `goForward`,
  surfaced as arrow buttons in the Files header next to Refresh).

---

## 9. Disabling it

The pieces are decoupled enough that a "disable symbol nav" setting is a **single
early-return** at the top of `handleClick`: when off, none of the custom machinery
runs, and click / double-click fall back to **pure native selection + native
Ctrl-C**, exactly as before the feature existed (the browser does the highlight
and copy; we touch nothing).

---

## 10. File map

| File | Responsibility |
|------|----------------|
| `components/files/file-preview.tsx` | `onClick` trigger + `detail` split, `wordFromPoint`, line+col anchor capture/re-resolve, amber highlight (single) / native selection re-assert (double), native-selection clear |
| `components/files/symbol-nav-popover.tsx` | Popover positioning (gap + flip, never covers symbol), `select-none`, results fetch + Definitions/References UI, outside-click (ignores `detail>=2`)/Esc close, Ctrl-C copy |
| `components/ai-elements/code-block.tsx` | `data-line` stamping, `display:grid` lines, jump-to-line scroll + `.code-line-highlight` |
| `hooks/use-file-browser.ts` | `navigate` / `jumpTo` / `goBack` / `goForward` + history stack |
| `components/files/files-view.tsx` | Wires history + back/forward buttons, passes `projectId`/`branch`/`target` to the preview |
| `routes/file-routes.ts` | `symbol-search` routes (project-scoped + `/api/path/*` remote variant), `git grep` + definition heuristic |
| `app/globals.css` | `.code-line-highlight` (jump target). NB: the `::highlight()` rule is **not** here — it's injected at runtime by `file-preview.tsx` |
