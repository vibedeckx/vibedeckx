# Review Scope Phase 2 — span selector + distill downgrade

**Date:** 2026-07-23
**Status:** Design approved, pending implementation plan
**Builds on:** `2026-07-23-review-scope-snapshot-design.md` (Phase 1, merged into this branch)

## Goal

Let the user choose how wide the review scope is — just the last turn (a fix) or the whole session (an implementation) — and stop the intent-brief distiller from guessing file scope now that the reviewer prompt names the changed files authoritatively.

This is the "Phase 2" slice deliberately deferred by the Phase 1 spec. Scope was narrowed during brainstorming to a clean increment:

- **In:** two-option span selector (`this_turn` / `session_start`), its backend plumbing, and the distill downgrade (drop the "intended scope" item).
- **Out (later phases):** an arbitrary-earlier-turn picker, re-review (reuse-reviewer) scoping, drift-detection reuse of the snapshot dirty map, and remote worker-side snapshot wiring.

## Background

Phase 1 computes review scope as the content-hash delta between a **start boundary** snapshot and a live review-time snapshot, and renders a `## Scope` section in the fresh-reviewer prompt naming the changed files. The start boundary was hardcoded to "the snapshot immediately before the reviewed turn" (`getStartBoundary(sessionId, turnEndIndex)`) — i.e. always "this turn".

The review is triggered from `ReviewDialog` (`apps/vibedeckx-ui/components/agent/review-dialog.tsx`), which calls `api.createWorkflowRun` → `POST /api/workflow-runs` → `WorkflowEngine.startAdhocReview`. The dialog already has a reviewer-agent select (shown only in "new reviewer" mode) and a review-focus input.

## Decisions (from brainstorming)

1. **Two span options only:** `this_turn` (default) and `session_start`. The arbitrary-earlier-turn picker is out — `session_start` covers "review the whole implementation".
2. **Distill downgrade = drop item 3 only.** Do NOT feed `changedFiles` into the distiller: the brief is pre-generated at dialog-open time from the conversation alone (no worktree/snapshots), so feeding real files there would duplicate the engine's scope computation and couple the brief to git state — and it is unnecessary because the reviewer prompt already names the authoritative files.
3. **Span applies to fresh reviews only.** The selector is gated to `reviewerMode === "new"` (mirrors the reviewer-agent select). The re-review prompt (`buildRereviewerPrompt`) is untouched; re-review scoping is a later fast-follow.

## Design

### 1. Types & storage

- Shared type `ReviewSpan = "this_turn" | "session_start"`, default `"this_turn"`. Define it once in the backend types (`storage/types.ts` alongside `WorkflowRun`) and mirror it in the frontend `lib/api.ts`.
- New column on `workflow_runs`: `review_span TEXT NOT NULL DEFAULT 'this_turn'`.
  - `sqlite.ts`: add the column to the `CREATE TABLE` and an idempotent `ALTER TABLE ... ADD COLUMN` migration (existing rows/DBs get the default), following the existing migration pattern in `sqlite.ts`.
  - `schema.ts`: add `review_span: Generated<string>` to `WorkflowRunsTable`.
  - `types.ts`: add `review_span` to `WorkflowRun`, and `review_span?: ReviewSpan` to `workflowRuns.create`'s options.
  - `repositories/workflow-runs.ts`: `create` writes `review_span: opts.review_span ?? "this_turn"`.
- New store method `turnSnapshots.getSessionStart(sessionId): Promise<{ head: string; dirty: Record<string,string> } | undefined>` querying `where session_id = ? and turn_end_index = -1`. (Clearer than relying on `getStartBoundary(sessionId, 0)`.)

### 2. Engine (`startAdhocReview`)

- Add opt `reviewSpan?: ReviewSpan` (default `"this_turn"`).
- In the new-reviewer scope block (added in Phase 1's fix wave, inside the fresh-reviewer branch after the re-review early return), resolve the start snapshot by span:
  ```ts
  const startSnap = reviewSpan === "session_start"
    ? await this.storage.turnSnapshots.getSessionStart(opts.sourceSessionId)
    : await this.storage.turnSnapshots.getStartBoundary(opts.sourceSessionId, turnEndIndex);
  ```
  The end boundary (live `captureSnapshot`) and the `null → "scope unknown"` fallback are unchanged. If `session_start` is chosen for a pre-Phase-1 session (no `-1` snapshot), `getSessionStart` returns `undefined` → `scope = null` → fallback, which is correct.
- Persist the chosen span: pass `review_span: reviewSpan ?? "this_turn"` into `workflowRuns.create`.

### 3. API / route

- `workflow-run-routes.ts`: add `reviewSpan?: ReviewSpan` to both `POST /api/workflow-runs` request-body types (the local handler and the remote-proxy handler), destructure it, and forward it to `startAdhocReview` / the proxied body.
- `lib/api.ts`: add `reviewSpan?: ReviewSpan` to `createWorkflowRun`'s argument type and include it in the request body.
- Back-compat: omitted `reviewSpan` → server defaults `"this_turn"`.

### 4. Frontend (`ReviewDialog`)

- New state `const [reviewSpan, setReviewSpan] = useState<ReviewSpan>("this_turn")`; reset to `"this_turn"` on dialog open (same `useEffect` that resets other fields).
- Render a `Select` **only when `reviewerMode === "new"`**, with a short label (e.g. "审查范围") and two items:
  - `this_turn` → "仅本次 turn（默认）"
  - `session_start` → "整个 session（自起点）"
- Pass `reviewSpan` into the `api.createWorkflowRun({ ... })` call in `start()`.

### 5. Distill downgrade (`review-brief.ts`)

- Remove the item `"3. The intended scope of the changes."` from `SYSTEM_PROMPT` and renumber the trade-offs item from 4 to 3. The distiller now emits goal, constraints/rejected approaches, and accepted trade-offs — the things code cannot show — and no longer guesses files. Update any test asserting the prompt text (`review-brief.test.ts`).

## Components & boundaries

- `getSessionStart` — pure CRUD read; independently testable.
- Span resolution — one ternary in `startAdhocReview`; behavior fully determined by the `reviewSpan` opt.
- The route/API/dialog changes are thin pass-through plumbing of one new optional field.
- The distill change is a prompt-string edit isolated to `review-brief.ts`.

## Testing

- `turnSnapshots.getSessionStart` round-trips the `-1` row and returns `undefined` when absent.
- Engine: `session_start` vs `this_turn` resolve to the correct start snapshot and produce different `changedFiles` when an earlier turn also changed files (integration test with real git + sqlite, extending the Phase 1 scenario harness).
- `buildReviewerPrompt` is unchanged (existing tests still pass).
- `review-brief.ts` `SYSTEM_PROMPT` no longer contains "intended scope"; brief distillation still returns the other sections.
- Frontend: `ReviewDialog` passes the chosen `reviewSpan` to `createWorkflowRun`, defaults to `this_turn`, and hides the selector in reuse mode (extend `review-dialog.test.tsx`).

## Out of scope (later phases)

- Arbitrary-earlier-turn picker (a turn-list UI).
- Re-review (reuse-reviewer) scoping — adding a `## Scope` section to `buildRereviewerPrompt` and deciding whether a re-review reuses the run's stored span.
- Reusing the snapshot `dirty` map to strengthen `captureReviewTarget` drift detection.
- Remote worker-side snapshot capture for `skipDb` sessions.
