# Session Expiry Alert Width Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the session-expiry alert exactly with the Clerk sign-in card and shorten its recovery message.

**Architecture:** Keep the existing authentication state flow intact. Apply the same responsive `w-full max-w-[400px]` constraint to the alert and Clerk root box, center both, and update only the displayed copy.

**Tech Stack:** React 19, TypeScript, Clerk React, Tailwind CSS, Vitest, jsdom

---

### Task 1: Align the expiry alert with Clerk

**Files:**
- Modify: `apps/vibedeckx-ui/components/auth/auth-wrapper.test.tsx`
- Modify: `apps/vibedeckx-ui/components/auth/auth-wrapper.tsx:102-126`

**Step 1: Write the failing test**

Update the Clerk mock to expose its `rootBox` classes. In the expiry-state test, assert the exact shortened copy and verify that both the alert and Clerk root contain `w-full` and `max-w-[400px]`.

**Step 2: Run the focused test to verify RED**

Run: `pnpm --filter vibedeckx-ui exec vitest run components/auth/auth-wrapper.test.tsx`

Expected: FAIL because the old copy remains and neither element has the shared 400px width class.

**Step 3: Implement the minimal change**

Change the alert text to `Session expired. Sign in again to continue.`, add `mx-auto w-full max-w-[400px]` to its classes, and change Clerk's `rootBox` appearance class to `mx-auto w-full max-w-[400px]`.

**Step 4: Verify GREEN and frontend health**

Run the focused test, frontend TypeScript check, the full frontend test suite, and lint on the changed files while accounting for the documented pre-existing `react-hooks/set-state-in-effect` error at `auth-wrapper.tsx:83`.

**Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/auth/auth-wrapper.tsx apps/vibedeckx-ui/components/auth/auth-wrapper.test.tsx docs/plans/2026-07-21-session-expiry-alert-width.md
git commit -m "fix(auth): align session expiry alert"
```

