# Schedule Run Split View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the schedule run result dialog with a Workspace-consistent resizable run-list and result-detail split view.

**Architecture:** `SchedulesView` continues to own the run-list request and adds an explicit selected-run id plus independently guarded detail loading state. The existing `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle` components provide the 33/67 layout and persisted sizing; the right panel renders the same report/raw-output content that currently lives in the dialog.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, react-resizable-panels wrapper, Vitest, jsdom.

---

### Task 1: Specify run selection and split layout

**Files:**
- Create: `apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx`
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.tsx`

**Step 1: Write the failing component tests**

Add a jsdom test harness that mocks `api.getScheduleRuns`,
`api.getScheduleRun`, `ScheduleFormDialog`, and the resizable primitives. Render
one schedule with two completed runs and verify:

```tsx
expect(container.querySelector("[data-panel-group-direction='horizontal']")).not.toBeNull();
expect(api.getScheduleRun).toHaveBeenCalledWith("run-new");
expect(container.textContent).toContain("new output");
```

Click the older row and verify the right panel loads and displays `old output`.
Assert that no element with `role="dialog"` is created for run output.

**Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: FAIL because the current component has no split panel and does not
select a run until its row opens a dialog.

**Step 3: Implement selected-run state and the split shell**

In `schedules-view.tsx`:

- Import `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle`.
- Replace `viewRun` with `selectedRunId`, `selectedRun`, `runLoading`, and
  `runError` state.
- After each run-list refresh, retain the selected id when it remains selectable;
  otherwise select the first non-skipped run.
- Render the history and result areas inside a horizontal panel group with
  `autoSaveId="schedule-run-panels"`, left `defaultSize={33}` and right
  `defaultSize={67}`.
- Mark the selected table row with `bg-muted/50` and `aria-selected`.
- Remove the result `Dialog`.

**Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/schedule/schedules-view.tsx apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx
git commit -m "feat(ui): add schedule run split view"
```

### Task 2: Guard asynchronous detail loading and render states

**Files:**
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx`
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.tsx`

**Step 1: Write the failing behavior tests**

Add tests that:

- Resolve an older detail request after a newer selection and verify the older
  result never replaces the newer output.
- Reject the selected detail request and verify an inline error plus a Retry
  button appears.
- Verify a skipped row is disabled/non-selectable and does not request details.

Use deferred promises to control request completion order.

**Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: FAIL on stale-response and error-state assertions.

**Step 3: Implement guarded loading**

Load details in an effect keyed by `selectedRunId`. Use an effect cleanup flag so
late responses cannot update `selectedRun`, `runLoading`, or `runError`. Reset
stale result content at request start and expose a retry nonce used by the inline
Retry button.

When selection is unavailable, render `Select a run to view its output`; while
loading, render `Loading run output…`; on failure, render the error and Retry.

**Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/schedule/schedules-view.tsx apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx
git commit -m "fix(ui): guard schedule run detail loading"
```

### Task 3: Verify report and raw-output presentation

**Files:**
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx`
- Modify: `apps/vibedeckx-ui/components/schedule/schedules-view.tsx`

**Step 1: Write the failing rendering tests**

Verify a run with `report` displays the report, keeps `Raw output` in a collapsed
`details`, and includes timestamp, status, duration, and exit code in the detail
header. Verify a run without a report displays ANSI-cleaned output directly.

**Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: FAIL until the full detail header and content hierarchy are present.

**Step 3: Complete the detail presentation**

Move the existing `Streamdown`, raw-output disclosure, and cleaned `<pre>` markup
into an independently scrolling, full-height right panel. Add a compact header
with the selected run metadata; do not add inferred health or attention content.

**Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/schedule/schedules-view.tsx apps/vibedeckx-ui/components/schedule/schedules-view.test.tsx
git commit -m "test(ui): cover schedule run result rendering"
```

### Task 4: Run final verification

**Files:**
- Modify only if verification reveals an in-scope defect.

**Step 1: Run schedule component tests**

Run: `pnpm --filter vibedeckx-ui test -- components/schedule/schedules-view.test.tsx`

Expected: PASS.

**Step 2: Run UI type checking**

Run: `pnpm --filter vibedeckx-ui exec tsc --noEmit`

Expected: PASS.

**Step 3: Run lint for changed source and test files**

Run: `pnpm --filter vibedeckx-ui exec eslint components/schedule/schedules-view.tsx components/schedule/schedules-view.test.tsx`

Expected: PASS.

**Step 4: Run the full UI test suite**

Run: `pnpm --filter vibedeckx-ui test`

Expected: PASS.

**Step 5: Commit any verification-only fixes**

If required, commit only the scoped fixes with a descriptive message.
