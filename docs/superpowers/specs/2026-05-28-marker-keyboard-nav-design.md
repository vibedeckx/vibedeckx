# Keyboard Navigation Between User-Input Markers

## Summary

The agent conversation panel renders thin markers down the right edge, one per
user message, that scroll the corresponding message to the top when clicked
(`apps/vibedeckx-ui/components/agent/user-input-markers.tsx`). This feature adds
keyboard navigation: when focus is in the messages area, **Shift+ArrowUp** jumps
to the previous user message and **Shift+ArrowDown** to the next one, relative to
the current scroll position.

## Goals

- Shift+Up / Shift+Down move between user-message markers while the messages area
  has focus.
- Navigation is **scroll-position based**: the reference is the current top of the
  scroll viewport, so it stays correct after manual scrolling or new messages.
- The landed message gets a brief visual highlight for feedback.
- The shortcut is scoped to the messages area — it never fires while typing in the
  textarea or when focus is elsewhere on the page.

## Non-Goals

- No wrap-around at the ends (stop when there is nothing further in that direction).
- No change to the existing click-to-jump marker behavior or rendering.
- No new keyboard shortcuts beyond Shift+Up / Shift+Down.

## Design

### Components & Changes

1. **`apps/vibedeckx-ui/lib/scroll.ts`** (new)
   - Export `findScrollParent(el: HTMLElement): HTMLElement | null`, moved verbatim
     from `user-input-markers.tsx`. The markers component imports it from here so
     both the visual markers and the keyboard-nav hook share one implementation.

2. **`apps/vibedeckx-ui/hooks/use-marker-keyboard-nav.ts`** (new)
   - `useMarkerKeyboardNav(contentRef: RefObject<HTMLDivElement | null>)` returns
     `{ onKeyDown, highlightedIndex }`.
   - `onKeyDown` handles the key events (see Navigation Logic).
   - `highlightedIndex: number | null` is the message index to pulse; cleared by a
     timeout after the highlight window.

3. **`apps/vibedeckx-ui/components/agent/agent-conversation.tsx`**
   - The existing messages container `<div ref={messagesRef}>` becomes focusable:
     add `tabIndex={-1}`, `outline-none` (no focus ring), and `onKeyDown={onKeyDown}`.
     `tabIndex={-1}` keeps it out of the Tab order but focusable on click; keydown
     events bubble up from focused child elements (e.g. tool buttons), so the
     handler fires whenever focus is anywhere within the messages area.
   - Each message wrapper div applies a pulse class when its `index === highlightedIndex`.

### Navigation Logic (scroll-position based)

On `keydown`:

- Act only when `event.key` is `"ArrowUp"` or `"ArrowDown"` **and** `event.shiftKey`
  is true **and** no other modifier (`ctrlKey`, `metaKey`, `altKey`) is held.
  Otherwise return without interfering.
- `event.preventDefault()` (suppress the default Shift+arrow selection extension).
- Resolve the scroll parent via `findScrollParent(contentRef.current)`. If none, no-op.
- Query all `[data-user-msg-idx]` elements inside `contentRef.current`. For each,
  compute its top relative to the scroll viewport top:
  `absoluteTop = elRect.top - scrollRect.top + scrollEl.scrollTop`.
  This is the same math the click markers already use.
- Let `viewTop = scrollEl.scrollTop` and use a small epsilon (e.g. 4px) so a marker
  sitting exactly at the top edge is treated as "current" and repeated presses keep
  moving.
  - **Up:** among markers with `absoluteTop < viewTop - epsilon`, pick the one with
    the **largest** `absoluteTop` (nearest above).
  - **Down:** among markers with `absoluteTop > viewTop + epsilon`, pick the one with
    the **smallest** `absoluteTop` (nearest below).
- **Stop at ends:** if no marker qualifies in that direction, do nothing.
- Scroll the chosen element with
  `el.scrollIntoView({ block: "start", behavior: "smooth" })` — identical to the
  click handler.
- Set `highlightedIndex` to the chosen element's `data-user-msg-idx`.

### Highlight Feedback

- The message block (the wrapper div in `agent-conversation.tsx`) the user lands on
  receives a brief pulse — a ring/background highlight via a Tailwind transition —
  for roughly one second, then clears.
- Implemented by setting `highlightedIndex` and clearing it with a `setTimeout`.
  Re-triggering on the same index resets the timer so consecutive jumps to the same
  message re-pulse cleanly. The timer is cleared on unmount.

### Scope & Focus

- The handler lives on the messages container, so it only fires when focus is within
  the messages area. Clicking a message focuses the container (`tabIndex={-1}`);
  clicking an interactive child focuses that child, and the keydown still bubbles to
  the container.
- The textarea is outside the messages container, so typing there is unaffected, and
  the existing input-history Up/Down handling (`use-input-history.ts`, plain arrows)
  is untouched.

### Edge Cases

- Zero or one user message, or content that does not overflow → no-op (no qualifying
  marker, and `scrollIntoView` would be harmless regardless).
- Stale DOM nodes whose index no longer maps to a message: navigation reads indices
  off the DOM and scrolls the element directly, so a missing `messages[idx]` only
  affects the highlight; guard the highlight lookup the same way the existing marker
  code guards (`if (!messages[idx]) skip`).

## Testing

No test framework is configured in this repo, so verification is manual:

1. Type-check backend and frontend:
   - `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
   - `cd apps/vibedeckx-ui && npx tsc --noEmit`
2. In the dev UI, open a conversation with several user messages so the content
   overflows. Click into the messages area, then:
   - Shift+Up moves to the previous user message; Shift+Down to the next.
   - At the first message Shift+Up does nothing; at the last, Shift+Down does nothing.
   - The landed message pulses briefly.
   - Typing in the textarea with Shift+Up/Down does not trigger navigation.
