# Schedule Run Split View Design

## Goal

Make schedule run results quick to browse without opening a modal or navigating
away from the selected schedule.

## Layout

Keep the existing schedule header, configuration summary, and actions at the top
of the page. Replace the run table plus result dialog with a resizable split view
below them:

- The left panel contains the run history and defaults to 33% width.
- The right panel contains the selected run result and defaults to 67% width.
- Reuse the same resizable panel components and interaction used by Workspace.
- Persist one shared panel ratio for the Schedule run view.

On desktop, both panels remain visible. The panel minimum sizes should preserve a
usable run list and readable output area.

## Run Selection

Selecting a run updates the right panel in place. Skipped runs remain
non-selectable because they have no captured result. When a schedule is opened or
its run history changes, select the newest selectable run if the current selection
is absent. Preserve the current selection across run-list refreshes when possible.

The selected row receives an active style so the list and detail remain visually
connected. While the selected result is loading, the detail panel shows a loading
state. A failed result request shows an inline retryable error without disrupting
the run list.

## Result Content

Do not add an inferred health summary or attention indicator.

The right panel header shows the run timestamp, status, duration, and exit code.
For prompt runs with a report, render the Markdown report first and keep raw output
in a collapsed disclosure. For command runs or runs without a report, show cleaned
raw output directly. The detail panel uses its full available height and scrolls
independently from the run list.

When there are no runs, or no selectable result, show a quiet empty state in the
right panel.

## Data Flow

The run list continues to load from `getScheduleRuns`. Selecting a run loads its
full output through `getScheduleRun`; list responses do not include output or
report content. Guard asynchronous responses so switching schedules or selecting
another run cannot display stale output.

Existing schedule SSE-driven refresh behavior remains unchanged.

## Verification

Component tests should cover default run selection, selection changes, stale or
failed detail requests, skipped runs, report/raw-output rendering, and removal of
the dialog interaction. Existing type checking and UI tests must continue to pass.
