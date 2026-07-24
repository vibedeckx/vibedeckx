# Quick Switcher Fixed Input Position Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the Cmd+K search input at its full-results vertical position while filtered results shrink beneath it.

**Architecture:** Pass a Quick Switcher-specific positioning class through the existing `CommandDialog` API. Replace content-height-relative vertical centering only for this caller with a fixed full-height anchor, while leaving shared dialog behavior unchanged.

**Tech Stack:** React 19, TypeScript, Radix Dialog, cmdk, Tailwind CSS v4, Vitest, jsdom

---

### Task 1: Add the fixed-position regression test

**Files:**
- Create: `apps/vibedeckx-ui/components/search/quick-switcher.test.tsx`
- Reference: `apps/vibedeckx-ui/components/search/quick-switcher.tsx`

**Step 1: Write the failing test**

Mock the search API, cache helpers, and global event stream hook. Render an
open `QuickSwitcher`, locate `[data-slot="dialog-content"]`, and assert that it
has the fixed top anchor and `translate-y-0` classes.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter vibedeckx-ui test -- components/search/quick-switcher.test.tsx
```

Expected: FAIL because the dialog still has only the shared
`top-[50%] translate-y-[-50%]` positioning.

### Task 2: Anchor only the Quick Switcher

**Files:**
- Modify: `apps/vibedeckx-ui/components/search/quick-switcher.tsx:158-165`
- Test: `apps/vibedeckx-ui/components/search/quick-switcher.test.tsx`

**Step 1: Write the minimal implementation**

Pass this positioning override to `CommandDialog`:

```tsx
className="top-[max(1rem,calc(50%_-_175px))] translate-y-0"
```

The 175px offset is half of the full 350px dialog height (48px input, 300px
list, and two 1px borders).

**Step 2: Run the focused test to verify it passes**

Run:

```bash
pnpm --filter vibedeckx-ui test -- components/search/quick-switcher.test.tsx
```

Expected: PASS.

### Task 3: Verify the frontend

**Files:**
- Verify: `apps/vibedeckx-ui/components/search/quick-switcher.tsx`
- Verify: `apps/vibedeckx-ui/components/search/quick-switcher.test.tsx`

**Step 1: Run frontend type checking**

Run:

```bash
pnpm --dir apps/vibedeckx-ui exec tsc --noEmit
```

Expected: exit code 0.

**Step 2: Run frontend linting**

Run:

```bash
pnpm --filter vibedeckx-ui lint
```

Expected: exit code 0 with no new lint errors.

**Step 3: Review the diff**

Run:

```bash
git diff --check
git diff -- apps/vibedeckx-ui/components/search/quick-switcher.tsx apps/vibedeckx-ui/components/search/quick-switcher.test.tsx
```

Expected: only the scoped positioning override and its regression test.
