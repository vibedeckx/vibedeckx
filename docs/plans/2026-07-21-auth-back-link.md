# Authentication Back Link Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep session-expiry recovery focused by hiding Back, while moving the deliberate sign-in return action below the Clerk form as a centered `Back to home` link.

**Architecture:** Preserve `AuthGate`'s existing `showSignIn` and `sessionExpired` state. Render the return control only when `sessionExpired` is false, after the `SignIn` component, and reuse the existing state-reset click behavior. Cover both entry paths by mocking Clerk's hooks and listener in a jsdom component test.

**Tech Stack:** React 19, TypeScript, Clerk React, Vitest, jsdom

---

### Task 1: Cover the two sign-in entry states

**Files:**
- Create: `apps/vibedeckx-ui/components/auth/auth-wrapper.test.tsx`
- Modify: `apps/vibedeckx-ui/components/auth/auth-wrapper.tsx:95-132`

**Step 1: Write the failing tests**

Create a jsdom test that mocks `useAuth`, `useClerk`, `ClerkProvider`, `SignIn`, `useAppConfig`, and the landing page. Capture Clerk's session listener so the test can simulate an expired session. Assert that deliberate sign-in renders the Clerk stub followed by `Back to home`, clicking it returns to the landing stub, and an expired transition renders the expiry message without `Back to home`.

**Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter vibedeckx-ui exec vitest run components/auth/auth-wrapper.test.tsx`

Expected: FAIL because the current label is `Back`, the control precedes the Clerk form, and it remains visible during expiry.

**Step 3: Implement the minimal render change**

In `AuthGate`, remove the existing unconditional button above the expiry notice. After `<SignIn />`, render the same ghost button only under `!sessionExpired`, center it with a full-width flex wrapper, use subdued link-like spacing, and label it `Back to home` with the existing left-arrow icon. Its click handler must continue to set `showSignIn` and `sessionExpired` to false.

**Step 4: Run focused verification**

Run: `pnpm --filter vibedeckx-ui exec vitest run components/auth/auth-wrapper.test.tsx`

Expected: PASS.

**Step 5: Run frontend verification**

Run: `pnpm --filter vibedeckx-ui exec tsc --noEmit`

Expected: exit 0.

Run: `pnpm --filter vibedeckx-ui exec eslint components/auth/auth-wrapper.tsx components/auth/auth-wrapper.test.tsx`

Expected: exit 0.

**Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/auth/auth-wrapper.tsx apps/vibedeckx-ui/components/auth/auth-wrapper.test.tsx docs/plans/2026-07-21-auth-back-link.md
git commit -m "fix(auth): clarify sign-in back navigation"
```

