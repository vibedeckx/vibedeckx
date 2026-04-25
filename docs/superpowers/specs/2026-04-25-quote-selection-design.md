# Quote Selected Chat Text — Design

**Date:** 2026-04-25
**Scope:** Frontend only (`apps/vibedeckx-ui`)
**Status:** Approved for implementation planning

## Problem

When a user selects text inside the agent chat window, there is no way to ask
the agent about that specific text. Today the user has to copy, paste, and
manually format a quote. We want a one-click "Quote" affordance that turns the
selection into a Markdown blockquote inside the input box, ready for the user
to add commentary and send.

## User-facing behavior

1. User drag-selects text anywhere inside the conversation area (user, assistant,
   tool input, tool output, thinking, error, system, or approval messages).
2. A small floating "Quote" button appears anchored just above the selection.
3. Clicking the button:
   - Inserts the selected text as a Markdown blockquote (`> text` per line) at
     the **top** of the input textarea.
   - Appends a blank line after the quote so the caret lands on a fresh line.
   - Focuses the textarea with the caret at the end.
   - Clears the browser selection.
4. The user types their message below the quote.
5. On submit, the entire textarea content (quote + commentary) is sent through
   the existing `handleSubmit` path. The Markdown `>` prefix preserves the
   "quoted" state for the agent.
6. Selecting and clicking Quote again **prepends** another quote block; multiple
   quotes are supported.
7. If the selection spans more than one message, the Quote button does not appear.

## Non-goals

- Rich-text editing inside the textarea.
- A first-class "quote" data structure separate from Markdown text.
- Server-side quote tracking.
- Cross-message stitched quotes.
- Source attribution (no "From Claude:" header inserted automatically).

## Architecture

### New component: `apps/vibedeckx-ui/components/agent/quote-popover.tsx`

A self-contained component responsible for selection detection and rendering
the floating button.

```tsx
interface QuotePopoverProps {
  containerRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}
```

**Internals:**

- Subscribes to `document`'s `selectionchange` event.
- On change, reads `window.getSelection()` and validates:
  - Selection is a Range (not collapsed Caret).
  - `selection.toString().trim()` is non-empty.
  - `selection.anchorNode` and `selection.focusNode` are both descendants of
    `containerRef.current`.
  - Both nodes share the same nearest `[data-message-idx]` ancestor element.
- If valid, computes `range.getBoundingClientRect()` and renders a floating
  button via `createPortal` to `document.body`, positioned centered above the
  selection (top = `rect.top - 36`, left = `rect.left + rect.width/2 - btnW/2`,
  clamped to viewport).
- Re-anchors on `scroll` (capture phase, passive) and `resize` so the button
  tracks the selection while the conversation scrolls.
- On click: invokes `onQuote(selection.toString())`, then `selection.removeAllRanges()`.
- Cleans up all listeners on unmount.

### Quote formatter

A pure helper colocated in `quote-popover.tsx`:

```ts
export function formatAsQuote(text: string): string {
  return text.replace(/\r?\n/g, "\n").split("\n").map(l => `> ${l}`).join("\n") + "\n\n";
}
```

- Normalizes line endings.
- Prefixes every line with `> ` so multi-line selections produce a valid
  Markdown blockquote.
- Appends a trailing blank line so the user's caret lands below the quote.

### Modifications to `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`

1. **Wrap every message with a `data-message-idx` element.** Today only user
   messages have a wrapper (`<div data-user-msg-idx={index}>`, lines 595–603).
   Replace the conditional wrap with a single uniform wrapper for all messages,
   while preserving `data-user-msg-idx` on user messages so `UserInputMarkers`
   keeps working:

   ```tsx
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

2. **Add a textarea ref** so the quote handler can focus the textarea after
   inserting. If `PromptInputTextarea` does not forward refs, fall back to
   focusing via a `requestAnimationFrame` lookup against the rendered DOM (a
   one-line `containerRef.current?.querySelector("textarea")?.focus()`); we'll
   confirm which path applies during implementation.

3. **Add `handleQuote`:**

   ```tsx
   const handleQuote = useCallback((text: string) => {
     setInput(prev => formatAsQuote(text) + prev);
     // focus textarea + place caret at end on the next frame
   }, [setInput]);
   ```

4. **Mount the popover** inside the messages area:

   ```tsx
   <QuotePopover containerRef={messagesRef} onQuote={handleQuote} />
   ```

   `messagesRef` already exists at line 125.

## Interaction with existing features

| Feature | Interaction |
|---|---|
| Workspace draft (`useWorkspaceDraft`) | Quoted text is plain textarea content; persists automatically. |
| Input history (`useInputHistory`) | Folded into the text; no special handling. |
| Paste-to-file threshold (2000 chars) | If the resulting message exceeds the threshold, existing `materializePastes` / oversized-message logic in `handleSubmit` rolls it into a single paste — no change needed. |
| Translate mode | Translates the entire input including the `>` prefix. Acceptable default. |
| Image attachments | Independent; no interaction. |
| Plan-mode / edit-mode | Independent; quote works in both. |

## Edge cases

- **Whitespace-only selection** — gated by `.trim()`; button hidden.
- **Selection collapsed by clicking elsewhere** — `selectionchange` fires with a
  collapsed range; button hides.
- **Selection across two messages** — fails the shared-`[data-message-idx]`
  check; button hides. User must quote each message separately.
- **Selection inside a `<pre>`/code block** — `selection.toString()` preserves
  internal newlines; the line-by-line prefixer produces `> code` per line. Not
  a fenced code block, but the agent reads it correctly.
- **Selection inside an interactive widget** (e.g., `AskUserQuestion` buttons)
  — buttons aren't selectable; surrounding prose still is. No conflict.
- **User scrolls while selected** — capture-phase scroll listener updates the
  button position so it tracks the selection.
- **Mobile / touch selection** — `selectionchange` fires on touch text selection
  on iOS/Android; positioning via `getBoundingClientRect` works. No special
  handling unless an issue surfaces in manual testing.
- **Component unmount mid-selection** — listener cleanup hides the button.

## Files touched

- **New:** `apps/vibedeckx-ui/components/agent/quote-popover.tsx` (~80–100 LOC).
- **Modified:** `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`:
  - Replace the per-user-message wrapper with a uniform `data-message-idx`
    wrapper for all messages.
  - Add `handleQuote` callback.
  - Mount `<QuotePopover>` inside the messages area.
  - Add textarea focus path (ref or DOM lookup).

No backend changes. No new dependencies. Existing patterns reused: React portal,
Tailwind classes, `Button` component, lucide icons (`Quote`).

## Testing (manual)

This repo has no automated test framework. Verification is manual:

1. Select text in a user message → Quote button appears → click → input shows
   `> text\n\n` and is focused.
2. Same for an assistant message, a Bash output, a Read result, an Edit diff,
   and a thinking block.
3. Drag-select across two messages → no button.
4. Whitespace-only selection → no button.
5. Click elsewhere to clear selection → button disappears.
6. Quote, type a follow-up, submit → user message arrives at agent containing
   both the `>`-prefixed quote and the typed commentary.
7. Quote twice in a row → two stacked `> …` blocks at the top of the input.
8. Quote text long enough to exceed the paste-to-file threshold → existing
   oversized-message logic converts the whole message into a single `<vpaste/>`
   on submit.
9. Scroll the conversation while text is selected → button stays anchored to
   the selection.

## Open questions

None. All decisions confirmed during brainstorming:

- Quote format: Markdown blockquote (`> `).
- Scope: any selectable text in the conversation area.
- Button: floating popover above the selection.
- Insertion: prepend to existing input; multi-quote allowed; auto-focus.
- Cross-message selections: not supported.
