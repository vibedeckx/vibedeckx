# Quote Append Order — Design

**Date:** 2026-07-12
**Scope:** Frontend only (`apps/vibedeckx-ui`)
**Status:** Approved

## Problem

The Quote action currently prepends each newly selected quote to the input. As
a result, repeated Quote actions display selections in reverse order. New
quotes must instead appear below the input's existing content.

## Behavior

- An empty input receives the formatted Markdown blockquote directly.
- A non-empty input receives the new blockquote at the end.
- If the existing input does not already end with a blank line, the append
  operation inserts only the newline characters needed to create one.
- Existing trailing newlines are preserved rather than removed.
- Repeated Quote actions therefore retain selection order.
- The textarea remains focused with its caret at the end after insertion.

## Implementation

Add a pure `appendQuote(input, text)` helper beside `formatAsQuote`. It chooses
the separator based on whether `input` ends with zero, one, or at least two
newline characters, then appends the formatted quote. Update `handleQuote` to
use the helper instead of prepending `formatAsQuote(text)`.

Keep the change frontend-only. The selection popover, Markdown formatting,
draft persistence, submission path, and backend remain unchanged.

## Testing

Add focused unit tests for empty input, ordinary text, one trailing newline,
an existing blank line, and repeated quotes. Run the focused test first to
demonstrate the regression, then run the complete frontend test, type-check,
and lint suites after the fix.
