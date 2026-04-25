# Quote Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select any text inside the agent chat window and click a floating "Quote" button to insert the selection as a Markdown blockquote at the top of the input box, then send their reply (with the quote intact) to the agent.

**Architecture:** One new self-contained React component (`QuotePopover`) listens for browser selection changes inside the messages container, validates that the selection lives inside a single message, and renders a floating button via React portal. Clicking the button calls back into `agent-conversation.tsx`, which prepends the formatted quote to the textarea state and refocuses the textarea. No backend changes, no new dependencies.

**Tech Stack:** React 19, Next.js 16 (static export), Tailwind v4, lucide-react icons, native browser Selection API, React `createPortal`.

**Spec:** `docs/superpowers/specs/2026-04-25-quote-selection-design.md`

**Repo conventions to know:**
- This repo has **no automated test framework**. Each task verifies by (a) running typecheck/lint and (b) manual UI verification at the end. There is no `pnpm test`.
- Frontend type-check command: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Frontend lint command (must pass): `pnpm --filter vibedeckx-ui lint`
- Backend ESM uses NodeNext (`.js` extensions on local imports). Frontend does NOT — `@/foo` imports map to project root and require no extension.
- Existing component patterns: `agent-conversation.tsx`, `vpaste-chip.tsx`. Match indentation (2 spaces), quote style (double quotes), and Tailwind class ordering.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/vibedeckx-ui/components/agent/quote-popover.tsx` | **Create** | Pure helper `formatAsQuote(text)`. React component `QuotePopover` that detects valid selections inside a target container and renders a floating "Quote" button via portal. |
| `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` | **Modify** | Tag every rendered message with `data-message-idx`. Add a wrapper ref around the textarea so the quote handler can focus it. Add `handleQuote` callback. Mount `<QuotePopover>` inside the messages area. |

No other files are touched. No imports change in any unrelated file.

---

## Task 1: Create `quote-popover.tsx` with the `formatAsQuote` helper

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/quote-popover.tsx`

**Why first:** The formatter is a pure function with no React surface. Locking it down first means Task 2 can use it without ambiguity, and any regression in the formatter is obvious in isolation.

- [ ] **Step 1: Create the file with a single exported helper.**

Create `apps/vibedeckx-ui/components/agent/quote-popover.tsx` with exactly this content:

```tsx
"use client";

/**
 * Format a free-form selection as a Markdown blockquote. Each line is
 * prefixed with "> " so multi-line selections render as a single quote
 * block. A trailing blank line is appended so the caret lands on a fresh
 * line below the quote.
 */
export function formatAsQuote(text: string): string {
  return text.replace(/\r?\n/g, "\n").split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
}
```

- [ ] **Step 2: Verify behavior with a one-shot Node check.**

The repo has no test framework, so verify the helper inline with `node`:

Run from the repo root:

```bash
node --input-type=module -e '
import("./apps/vibedeckx-ui/components/agent/quote-popover.tsx").catch(() => {});
const formatAsQuote = (t) => t.replace(/\r?\n/g, "\n").split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";

const cases = [
  { in: "hello",                           out: "> hello\n\n" },
  { in: "line one\nline two",              out: "> line one\n> line two\n\n" },
  { in: "windows\r\nnewlines",             out: "> windows\n> newlines\n\n" },
  { in: "",                                out: "> \n\n" },
  { in: "trailing\n",                      out: "> trailing\n> \n\n" },
];
for (const c of cases) {
  const got = formatAsQuote(c.in);
  if (got !== c.out) {
    console.error("FAIL", JSON.stringify(c.in), "->", JSON.stringify(got), "expected", JSON.stringify(c.out));
    process.exit(1);
  }
}
console.log("OK");
'
```

Expected output: `OK`

(The dynamic import line is a no-op safety net — TS files cannot be loaded directly by Node. The check is on the inlined copy of the function. If you change the helper in the source file, also change it in the verification command.)

- [ ] **Step 3: Run the frontend type-check.**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`

Expected: no errors. The new file has no JSX yet so it compiles cleanly.

- [ ] **Step 4: Commit.**

```bash
git add apps/vibedeckx-ui/components/agent/quote-popover.tsx
git commit -m "feat(quote): add formatAsQuote helper"
```

---

## Task 2: Implement the `QuotePopover` component

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/quote-popover.tsx`

**What this adds:** Selection-driven floating button. Subscribes to `document`'s `selectionchange`. Validates the selection is non-empty and lives inside a single `[data-message-idx]` element under `containerRef.current`. Portals the button to `document.body`, anchored above the selection's bounding rect. Calls `onQuote(selectedText)` when clicked, then clears the browser selection.

- [ ] **Step 1: Replace the file contents with the helper plus the component.**

Replace the entire contents of `apps/vibedeckx-ui/components/agent/quote-popover.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";

/**
 * Format a free-form selection as a Markdown blockquote. Each line is
 * prefixed with "> " so multi-line selections render as a single quote
 * block. A trailing blank line is appended so the caret lands on a fresh
 * line below the quote.
 */
export function formatAsQuote(text: string): string {
  return text.replace(/\r?\n/g, "\n").split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
}

interface QuotePopoverProps {
  containerRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}

interface SelectionState {
  text: string;
  rect: { top: number; bottom: number; left: number; width: number };
}

/**
 * Walk up from `node` until we find an element with `data-message-idx`.
 * Returns the value of the attribute, or null if none is found before
 * reaching `boundary` (or the document root).
 */
function findMessageIdx(node: Node | null, boundary: HTMLElement): string | null {
  let cur: Node | null = node;
  while (cur && cur !== boundary) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const idx = (cur as HTMLElement).getAttribute("data-message-idx");
      if (idx !== null) return idx;
    }
    cur = cur.parentNode;
  }
  return null;
}

export function QuotePopover({ containerRef, onQuote }: QuotePopoverProps) {
  const [sel, setSel] = useState<SelectionState | null>(null);

  useEffect(() => {
    function recompute() {
      const container = containerRef.current;
      if (!container) {
        setSel(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSel(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        setSel(null);
        return;
      }
      const { anchorNode, focusNode } = selection;
      if (!anchorNode || !focusNode) {
        setSel(null);
        return;
      }
      if (!container.contains(anchorNode) || !container.contains(focusNode)) {
        setSel(null);
        return;
      }
      const anchorIdx = findMessageIdx(anchorNode, container);
      const focusIdx = findMessageIdx(focusNode, container);
      if (anchorIdx === null || focusIdx === null || anchorIdx !== focusIdx) {
        setSel(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSel(null);
        return;
      }
      setSel({
        text,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      });
    }

    document.addEventListener("selectionchange", recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      document.removeEventListener("selectionchange", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [containerRef]);

  if (!sel) return null;
  if (typeof document === "undefined") return null;

  // Position centered above the selection. If the top would be off-screen,
  // flip below. Clamp horizontally to the viewport.
  const BTN_GAP = 8;
  const BTN_HEIGHT = 28;
  const flipBelow = sel.rect.top - BTN_GAP - BTN_HEIGHT < 8;
  const top = flipBelow ? sel.rect.bottom + BTN_GAP : sel.rect.top - BTN_GAP - BTN_HEIGHT;
  const rawLeft = sel.rect.left + sel.rect.width / 2;
  const left = Math.max(8, Math.min(window.innerWidth - 8, rawLeft));

  return createPortal(
    <button
      type="button"
      onMouseDown={(e) => {
        // Prevent the textarea-or-elsewhere focus shift that would clear the
        // browser selection before our handler reads it.
        e.preventDefault();
        const text = sel.text;
        onQuote(text);
        window.getSelection()?.removeAllRanges();
        setSel(null);
      }}
      style={{
        position: "fixed",
        top,
        left,
        transform: "translateX(-50%)",
        zIndex: 50,
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-foreground shadow-md hover:bg-accent"
    >
      <Quote className="h-3 w-3" />
      Quote
    </button>,
    document.body
  );
}
```

- [ ] **Step 2: Run the frontend type-check.**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`

Expected: no errors. Common failure modes if you see one:
- Missing import — confirm `useEffect`, `useState`, `createPortal`, `Quote` are imported as shown.
- "Cannot find module 'react-dom'" — already a transitive dep via Next.js, no install needed; check that the import path is exactly `react-dom`.

- [ ] **Step 3: Run the frontend lint.**

Run: `pnpm --filter vibedeckx-ui lint`

Expected: passes with no warnings or errors in the new file.

- [ ] **Step 4: Commit.**

```bash
git add apps/vibedeckx-ui/components/agent/quote-popover.tsx
git commit -m "feat(quote): add QuotePopover component"
```

---

## Task 3: Wire `QuotePopover` into `agent-conversation.tsx`

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`

**What this changes:**
1. Tag every rendered message with `data-message-idx` (currently only user messages have a wrapper, lines 595–603).
2. Add a `textareaWrapperRef` so `handleQuote` can focus the textarea (the underlying `PromptInputTextarea` does not forward refs, so we wrap it in a div and DOM-query the textarea).
3. Add a `handleQuote` callback that prepends the formatted quote to `input` and focuses the textarea with the caret at the end.
4. Mount `<QuotePopover containerRef={messagesRef} onQuote={handleQuote} />` inside the messages area.

The existing `data-user-msg-idx` attribute on user messages is preserved — `UserInputMarkers` uses it.

- [ ] **Step 1: Add imports and the `formatAsQuote` / `QuotePopover` references.**

In `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`, find the existing block of `./...` imports (around lines 42–43):

```tsx
import { UserInputMarkers } from "./user-input-markers";
import { SessionHistoryDropdown } from "./session-history-dropdown";
```

Add immediately below:

```tsx
import { QuotePopover, formatAsQuote } from "./quote-popover";
```

- [ ] **Step 2: Add the textarea wrapper ref next to the existing `messagesRef`.**

Find line 125:

```tsx
  const messagesRef = useRef<HTMLDivElement>(null);
```

Change it to:

```tsx
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaWrapperRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 3: Add the `handleQuote` callback.**

Find the existing `handleAcceptPlan` function (around lines 199–203):

```tsx
  const handleAcceptPlan = async (planContent: string) => {
    await acceptPlan(planContent);
    setPermissionMode("edit");
    onStatusChange?.();  // Agent will now implement the plan → signal "working"
  };
```

Add immediately after it:

```tsx
  const handleQuote = useCallback((text: string) => {
    setInput((prev) => formatAsQuote(text) + prev);
    requestAnimationFrame(() => {
      const ta = textareaWrapperRef.current?.querySelector("textarea");
      if (!ta) return;
      ta.focus();
      const len = ta.value.length;
      try {
        ta.setSelectionRange(len, len);
      } catch {
        // ignore — textarea may have been unmounted
      }
    });
  }, [setInput]);
```

`useCallback` is already imported at line 3. `formatAsQuote` was added in Step 1.

- [ ] **Step 4: Replace the per-message wrapper to tag every message with `data-message-idx`.**

Find this block (lines 595–603):

```tsx
                  {messages.map((msg, index) =>
                    msg.type === "user" ? (
                      <div key={index} data-user-msg-idx={index}>
                        <AgentMessageItem message={msg} messageIndex={index} />
                      </div>
                    ) : (
                      <AgentMessageItem key={index} message={msg} messageIndex={index} />
                    )
                  )}
```

Replace it with:

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

This keeps the `data-user-msg-idx` attribute (so `UserInputMarkers` still works) and adds `data-message-idx` to every message wrapper.

- [ ] **Step 5: Wrap the textarea with the focus ref.**

Find this block (around lines 667–678):

```tsx
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPasteText={handlePasteText}
                onKeyDown={inputHistory.handleKeyDown}
                placeholder={
                  session
                    ? "Ask the agent to help with your code..."
                    : "Type your first message to start..."
                }
                className="pr-12"
              />
```

Wrap it in a div bound to `textareaWrapperRef`. The wrapper uses `display: contents` so the existing flex layout is unchanged:

```tsx
              <div ref={textareaWrapperRef} className="contents">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPasteText={handlePasteText}
                  onKeyDown={inputHistory.handleKeyDown}
                  placeholder={
                    session
                      ? "Ask the agent to help with your code..."
                      : "Type your first message to start..."
                  }
                  className="pr-12"
                />
              </div>
```

`className="contents"` (Tailwind utility for `display: contents`) keeps the wrapper invisible to the flex layout — the textarea remains the layout child of the surrounding `flex` row, so spacing is preserved.

- [ ] **Step 6: Mount `<QuotePopover>` inside the messages area.**

Find the existing `UserInputMarkers` mount (line 623):

```tsx
        <UserInputMarkers messages={messages} contentRef={messagesRef} />
```

Add immediately after it:

```tsx
        <UserInputMarkers messages={messages} contentRef={messagesRef} />
        <QuotePopover containerRef={messagesRef} onQuote={handleQuote} />
```

- [ ] **Step 7: Run the frontend type-check.**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`

Expected: no errors. If you see one, common causes:
- Forgot to import `QuotePopover` or `formatAsQuote` in Step 1.
- Used `useCallback` without it being in the existing import list — confirm line 3 includes `useCallback` (it does in the current file).

- [ ] **Step 8: Run the frontend lint.**

Run: `pnpm --filter vibedeckx-ui lint`

Expected: passes.

- [ ] **Step 9: Commit.**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(quote): wire QuotePopover into agent conversation"
```

---

## Task 4: Manual UI verification

**Files:** none modified.

This task does not produce a commit. It is a verification gate. Do not skip it — the feature is UI-driven and only manual testing exercises the real selection model, scroll re-anchoring, and submit path.

- [ ] **Step 1: Start the dev stack.**

Run from the repo root:

```bash
pnpm dev:all
```

Expected: backend starts on port 5173, frontend on port 3000. Open `http://localhost:3000` in a browser and load a project that has at least one existing agent conversation with a few messages of mixed types (user, assistant, a Bash tool result, an Edit diff). If you don't have one, send a quick "list files in the repo" prompt to populate the conversation with assistant text and tool output.

- [ ] **Step 2: Quote from a user message.**

- Drag-select a few words inside one of your prior user messages.
- A small "Quote" button should appear above the selection.
- Click it.
- The input box should now start with `> {selected text}\n\n`, followed by a blank line, with the caret at the end.

- [ ] **Step 3: Quote from an assistant message.**

Repeat Step 2 inside an assistant ("Claude" or "Codex") message. Same expected behavior.

- [ ] **Step 4: Quote from a tool output.**

Open a Bash tool result, a Read tool result, or an Edit diff. Drag-select text inside it. Quote button appears. Click. The input gets the quoted text.

- [ ] **Step 5: Multi-line selection.**

Select text that spans multiple visual lines (e.g., two paragraphs of an assistant message, or several lines of a Bash output). Click Quote. Verify each line is prefixed with `> ` in the input.

- [ ] **Step 6: Whitespace-only selection.**

Triple-click an empty area or select only whitespace. The Quote button should NOT appear.

- [ ] **Step 7: Cross-message selection.**

Drag-select starting in one message and ending in another. The Quote button should NOT appear (single-message rule).

- [ ] **Step 8: Selection cleared by clicking elsewhere.**

Make a valid selection (button appears). Click somewhere else in the page (not the button). The Quote button should disappear.

- [ ] **Step 9: Multiple stacked quotes.**

Quote one selection. Without clearing the input, select different text and Quote again. The input should contain TWO `> …\n\n` blocks at the top, in reverse selection order (most recent on top).

- [ ] **Step 10: Quote, type, and submit.**

After a Quote, type "what does this mean?" below it. Press Enter (or click submit). Verify:
- The submitted user message appears in the conversation, rendered as a Markdown blockquote followed by your question (the existing `MessageResponse` markdown renderer handles `>`).
- The agent receives both the quote and your question and can reference both.

- [ ] **Step 11: Scroll while selected.**

Make a long selection that extends past the visible area, OR make a selection then scroll the conversation. The Quote button should track the selection's position as the conversation scrolls (re-anchoring on every scroll event).

- [ ] **Step 12: Oversized quote → paste rollup.**

Quote a chunk of text large enough to push the message over 2000 characters (the `PASTE_TO_FILE_THRESHOLD`). Submit. Verify the existing oversized-message logic in `handleSubmit` rolls the entire text into a single `<vpaste/>` marker and the user message renders as a paste chip — no exception, no truncation. (This confirms the new feature does not bypass the paste-rollup safety net.)

- [ ] **Step 13: Final cleanup.**

Stop the dev stack. The feature is fully verified.

---

## Self-review notes (for the implementer)

- **Spec coverage:** Every section of the spec is implemented — quote format (`formatAsQuote`), all-message scope (uniform `data-message-idx` wrapper), floating popover (Task 2), prepend-on-click + multi-quote + auto-focus (Task 3 Step 3), single-message rule (Task 2's `findMessageIdx` check), oversized-message interaction (Task 4 Step 12 verifies the existing path still works).
- **No backend changes.** No new dependencies. No new test infrastructure.
- **One known limitation by design:** translation mode translates the quote text along with the user's commentary. The spec accepts this. If a user surfaces it, that's a follow-up — do not address it in this plan.
