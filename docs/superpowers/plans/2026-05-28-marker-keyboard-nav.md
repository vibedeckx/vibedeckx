# Marker Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users press Shift+ArrowUp / Shift+ArrowDown while focused in the agent messages area to jump to the previous / next user-input marker, scroll-position based, with a brief highlight on the landed message.

**Architecture:** Extract the shared `findScrollParent` helper into `lib/scroll.ts`. Add a focused, testable `useMarkerKeyboardNav` hook that reads `[data-user-msg-idx]` elements, picks the nearest marker above/below the current scroll viewport, scrolls to it, and reports a `highlightedIndex` for a transient pulse. Wire it into `agent-conversation.tsx` by making the existing messages container focusable.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind CSS v4. No test framework is configured in this repo — verification is type-check (`tsc --noEmit`) plus targeted manual checks in the dev UI.

---

## Verification Conventions

This repo has no automated test runner. Every task's verification uses:

- **Frontend type-check:** `cd apps/vibedeckx-ui && npx tsc --noEmit`
- **Frontend lint:** `pnpm --filter vibedeckx-ui lint`

Run both from the repo root unless noted. The final task adds a manual UI checklist.

---

## File Structure

- **Create** `apps/vibedeckx-ui/lib/scroll.ts` — shared `findScrollParent` DOM helper.
- **Modify** `apps/vibedeckx-ui/components/agent/user-input-markers.tsx` — import `findScrollParent` from the new module instead of defining it locally.
- **Create** `apps/vibedeckx-ui/hooks/use-marker-keyboard-nav.ts` — the keyboard navigation hook.
- **Modify** `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — make the messages container focusable, wire `onKeyDown`, and apply the highlight pulse class.

---

## Task 1: Extract `findScrollParent` into a shared module

**Files:**
- Create: `apps/vibedeckx-ui/lib/scroll.ts`
- Modify: `apps/vibedeckx-ui/components/agent/user-input-markers.tsx:6-16` (remove local definition), `:1-4` (add import)

- [ ] **Step 1: Create the shared module**

Create `apps/vibedeckx-ui/lib/scroll.ts` with the function moved verbatim from `user-input-markers.tsx`:

```typescript
/**
 * Walks up the DOM from `el` and returns the nearest ancestor whose computed
 * overflow-y allows scrolling (`auto` or `scroll`), or null if none exists.
 */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}
```

- [ ] **Step 2: Update `user-input-markers.tsx` to import it**

In `apps/vibedeckx-ui/components/agent/user-input-markers.tsx`, delete the local `findScrollParent` function (currently lines 6-16) and add this import near the top (after the existing imports on lines 3-4):

```typescript
import { findScrollParent } from "@/lib/scroll";
```

The rest of the file is unchanged — it already calls `findScrollParent(...)`, now resolved from the import.

- [ ] **Step 3: Type-check and lint**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint
```
Expected: no errors. (If `tsc` reports `findScrollParent` is unused anywhere or duplicated, you missed deleting the local copy.)

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/scroll.ts apps/vibedeckx-ui/components/agent/user-input-markers.tsx
git commit -m "refactor(ui): extract findScrollParent into lib/scroll"
```

---

## Task 2: Create the `useMarkerKeyboardNav` hook

**Files:**
- Create: `apps/vibedeckx-ui/hooks/use-marker-keyboard-nav.ts`

- [ ] **Step 1: Write the hook**

Create `apps/vibedeckx-ui/hooks/use-marker-keyboard-nav.ts`:

```typescript
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { findScrollParent } from "@/lib/scroll";

// Treat a marker within this many pixels of the viewport top as "current" so
// repeated Shift+Arrow presses keep advancing instead of re-selecting the
// marker that scrollIntoView just parked at the top edge.
const TOP_EPSILON_PX = 4;

// How long the landed message stays highlighted, in ms.
const HIGHLIGHT_MS = 1000;

interface MarkerNav {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  highlightedIndex: number | null;
}

/**
 * Keyboard navigation between user-input markers in the agent messages area.
 *
 * Shift+ArrowUp jumps to the nearest user message whose top is above the current
 * scroll-viewport top; Shift+ArrowDown to the nearest one below. Navigation is
 * scroll-position based (stateless) so it stays correct after manual scrolling.
 * Stops at the ends. The landed message index is reported via `highlightedIndex`
 * for a transient pulse, then cleared after HIGHLIGHT_MS.
 *
 * Attach `onKeyDown` to the messages container (made focusable with tabIndex={-1});
 * keydown events bubble from focused children, so it fires whenever focus is within
 * the messages area.
 */
export function useMarkerKeyboardNav(
  contentRef: RefObject<HTMLDivElement | null>
): MarkerNav {
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending highlight timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const triggerHighlight = useCallback((index: number) => {
    setHighlightedIndex(index);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHighlightedIndex(null), HIGHLIGHT_MS);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

      const contentEl = contentRef.current;
      if (!contentEl) return;
      const scrollEl = findScrollParent(contentEl);
      if (!scrollEl) return;

      // Default Shift+Arrow extends a text selection in the messages area — we own
      // this combo, so suppress it.
      event.preventDefault();

      const scrollRect = scrollEl.getBoundingClientRect();
      const viewTop = scrollEl.scrollTop;
      const goUp = event.key === "ArrowUp";

      let target: HTMLElement | null = null;
      let targetTop = goUp ? -Infinity : Infinity;

      const els = contentEl.querySelectorAll<HTMLElement>("[data-user-msg-idx]");
      els.forEach((el) => {
        const elRect = el.getBoundingClientRect();
        const top = elRect.top - scrollRect.top + scrollEl.scrollTop;
        if (goUp) {
          // Nearest marker above the viewport top: largest top still < viewTop.
          if (top < viewTop - TOP_EPSILON_PX && top > targetTop) {
            targetTop = top;
            target = el;
          }
        } else {
          // Nearest marker below the viewport top: smallest top still > viewTop.
          if (top > viewTop + TOP_EPSILON_PX && top < targetTop) {
            targetTop = top;
            target = el;
          }
        }
      });

      // Stop at the ends — nothing further in this direction.
      if (!target) return;

      target.scrollIntoView({ block: "start", behavior: "smooth" });

      const idx = Number.parseInt(target.dataset.userMsgIdx ?? "", 10);
      if (!Number.isNaN(idx)) triggerHighlight(idx);
    },
    [contentRef, triggerHighlight]
  );

  return { onKeyDown, highlightedIndex };
}
```

- [ ] **Step 2: Type-check and lint**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint
```
Expected: no errors. The hook is not yet imported anywhere, which is fine — `tsc --noEmit` checks the file on its own.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-marker-keyboard-nav.ts
git commit -m "feat(ui): add useMarkerKeyboardNav hook"
```

---

## Task 3: Wire the hook into the conversation and add the highlight pulse

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` (import + hook call near other hooks ~line 142; messages container ~lines 734-743)

- [ ] **Step 1: Import the hook**

In `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`, add near the other component imports (e.g. after the `UserInputMarkers` import on line 43):

```typescript
import { useMarkerKeyboardNav } from "@/hooks/use-marker-keyboard-nav";
```

- [ ] **Step 2: Call the hook**

Inside the `AgentConversation` component body, after `messagesRef` is declared (currently line 140, `const messagesRef = useRef<HTMLDivElement>(null);`), add:

```typescript
  const { onKeyDown: onMarkerKeyDown, highlightedIndex } = useMarkerKeyboardNav(messagesRef);
```

- [ ] **Step 3: Make the messages container focusable and wire the handler + pulse**

In the same file, the messages list currently renders as (lines 734-743):

```tsx
                <div className="space-y-1" ref={messagesRef}>
                  {messages.map((msg, index) => (
                    <div
                      key={index}
                      data-message-idx={index}
                      {...(msg.type === "user" ? { "data-user-msg-idx": index } : {})}
                    >
                      <AgentMessageItem message={msg} messageIndex={index} />
                    </div>
                  ))}
```

Replace it with:

```tsx
                <div
                  className="space-y-1 outline-none"
                  ref={messagesRef}
                  tabIndex={-1}
                  onKeyDown={onMarkerKeyDown}
                >
                  {messages.map((msg, index) => (
                    <div
                      key={index}
                      data-message-idx={index}
                      {...(msg.type === "user" ? { "data-user-msg-idx": index } : {})}
                      className={cn(
                        "rounded-md transition-colors duration-500",
                        index === highlightedIndex && "bg-primary/10 ring-2 ring-primary/40"
                      )}
                    >
                      <AgentMessageItem message={msg} messageIndex={index} />
                    </div>
                  ))}
```

Notes:
- `cn` is already imported in this file (line 34).
- `tabIndex={-1}` + `outline-none` makes the container click-focusable without a focus ring and without entering the Tab order.
- The `transition-colors duration-500` makes the pulse fade out smoothly when `highlightedIndex` clears.

- [ ] **Step 4: Type-check and lint**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../.. && pnpm --filter vibedeckx-ui lint
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(ui): wire Shift+Arrow marker navigation into conversation"
```

---

## Task 4: Manual verification in the dev UI

**Files:** none (verification only)

- [ ] **Step 1: Start the dev environment**

Run:
```bash
pnpm dev:all
```
Open the frontend (http://localhost:3000), select a project/branch, and open a conversation that has **several user messages** — enough that the messages area overflows and the right-edge markers appear.

- [ ] **Step 2: Walk the checklist**

Click once inside the messages area (on a message), then verify:

- [ ] Shift+ArrowUp scrolls to the previous user message (parked at the top).
- [ ] Shift+ArrowDown scrolls to the next user message.
- [ ] Repeated Shift+ArrowUp keeps climbing message by message (epsilon works — it doesn't stick on the one at the top edge).
- [ ] At the first user message, Shift+ArrowUp does nothing (stops at the end).
- [ ] At the last user message, Shift+ArrowDown does nothing (stops at the end).
- [ ] The landed message shows a brief highlight pulse that fades.
- [ ] After manually scrolling with the mouse, Shift+Arrow navigation picks the correct neighbor relative to the new scroll position.
- [ ] Clicking into the **textarea** and pressing Shift+ArrowUp/Down does NOT navigate markers (it behaves as normal text editing); plain ArrowUp/Down input-history recall still works.
- [ ] The existing click-to-jump markers on the right edge still work unchanged.

- [ ] **Step 3: Record the result**

If everything passes, the feature is complete — no commit needed (no code changed in this task). If a check fails, use superpowers:systematic-debugging before patching.

---

## Self-Review Notes

- **Spec coverage:** Shift+Up/Down nav (Task 2/3), scroll-position based with epsilon (Task 2), stop-at-ends (Task 2), highlight pulse on the message block (Task 2/3), scope to messages area via focusable container + bubbling (Task 3), shared `findScrollParent` (Task 1), manual verification incl. textarea isolation and existing-marker regression (Task 4). All spec sections map to a task.
- **Type consistency:** Hook returns `{ onKeyDown, highlightedIndex }`; consumer destructures `onKeyDown: onMarkerKeyDown` and `highlightedIndex`, both used in Task 3. `data-user-msg-idx` is the same attribute the existing markers and conversation rendering use.
- **No placeholders:** every code step shows full content; no TBD/TODO.
