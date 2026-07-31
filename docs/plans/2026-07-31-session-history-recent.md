# Session History Recent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record explicit Session History dropdown selections in the Cmd+K MRU.

**Architecture:** `AgentConversation` receives an optional user-selection
callback from the page. The Session History `onSwitch` handler invokes it
before updating the session URL; automatic fallback paths remain unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library

---

### Task 1: Lock the selection boundary with a regression test

**Files:**
- Test: `apps/vibedeckx-ui/components/agent/agent-conversation.pending-model.test.tsx`

**Step 1: Write the failing test**

Render `AgentConversation` with a mocked `SessionHistoryDropdown`, invoke its
`onSwitch`, and assert `onSessionSelected("selected-session")` and
`setSessionUrlParam("selected-session")` each run once. Invoke its deletion
fallback and assert it does not call `onSessionSelected`.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/vibedeckx-ui test components/agent/agent-conversation.pending-model.test.tsx
```

Expected: FAIL because `AgentConversation` does not accept or invoke
`onSessionSelected`.

### Task 2: Wire explicit dropdown selection to the page MRU

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Write minimal implementation**

Add `onSessionSelected?: (sessionId: string) => void` to the component props.
Invoke it only in `SessionHistoryDropdown.onSwitch`, then pass
`touchRecentSessionOpen` from `page.tsx`.

**Step 2: Run focused and related tests**

Run:

```bash
pnpm --dir apps/vibedeckx-ui test \
  components/agent/agent-conversation.pending-model.test.tsx \
  lib/quick-switcher-cache.test.ts \
  components/search/quick-switcher.test.tsx
```

Expected: all tests pass.

### Task 3: Verify the UI

**Step 1: Run TypeScript**

Run:

```bash
pnpm --dir apps/vibedeckx-ui exec tsc --noEmit
```

Expected: exit 0.

**Step 2: Review the diff**

Run:

```bash
git diff --check
git diff -- apps/vibedeckx-ui docs/plans
```

Expected: no whitespace errors and only the intended callback, test, and plan
changes.
