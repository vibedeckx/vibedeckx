# Quote Append Order Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Append each newly selected chat quote below the input's existing content while preserving a blank-line boundary and selection order.

**Architecture:** Add one pure string-composition helper next to the existing quote formatter and cover it with focused Vitest cases. The conversation handler will call that helper; selection handling, draft persistence, focus restoration, and submission remain unchanged.

**Tech Stack:** TypeScript, React 19, Vitest 4

---

### Task 1: Specify append ordering and spacing

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/quote-popover.test.ts`
- Test: `apps/vibedeckx-ui/components/agent/quote-popover.test.ts`

**Step 1: Write the failing tests**

Add tests that import `appendQuote` from `./quote-popover` and assert:

```ts
expect(appendQuote("", "first")).toBe("> first\n\n");
expect(appendQuote("draft", "first")).toBe("draft\n\n> first\n\n");
expect(appendQuote("draft\n", "first")).toBe("draft\n\n> first\n\n");
expect(appendQuote("draft\n\n", "first")).toBe("draft\n\n> first\n\n");

const first = appendQuote("", "first");
expect(appendQuote(first, "second")).toBe("> first\n\n> second\n\n");
```

**Step 2: Run the focused test and verify RED**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/quote-popover.test.ts`

Expected: FAIL because `appendQuote` is not exported.

**Step 3: Commit the failing test**

```bash
git add apps/vibedeckx-ui/components/agent/quote-popover.test.ts
git commit -m "test(ui): cover quote append order"
```

### Task 2: Append new quotes below existing content

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/quote-popover.tsx:13-15`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx:51,337-350`
- Test: `apps/vibedeckx-ui/components/agent/quote-popover.test.ts`

**Step 1: Implement the minimal helper**

Add this pure helper below `formatAsQuote`:

```ts
export function appendQuote(input: string, text: string): string {
  const separator = input.length === 0 || input.endsWith("\n\n")
    ? ""
    : input.endsWith("\n")
      ? "\n"
      : "\n\n";
  return input + separator + formatAsQuote(text);
}
```

**Step 2: Use the helper in the conversation handler**

Import `appendQuote` and replace the prepend expression with:

```ts
setInput(appendQuote(input, text));
```

Keep the existing focus and caret restoration logic unchanged.

**Step 3: Run the focused test and verify GREEN**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/quote-popover.test.ts`

Expected: PASS.

**Step 4: Run frontend verification**

Run:

```bash
pnpm --filter vibedeckx-ui test
pnpm --filter vibedeckx-ui exec tsc --noEmit
pnpm --filter vibedeckx-ui lint
```

Expected: all commands pass with no new errors.

**Step 5: Commit the implementation**

```bash
git add apps/vibedeckx-ui/components/agent/quote-popover.tsx apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "fix(ui): append quotes below existing input"
```
