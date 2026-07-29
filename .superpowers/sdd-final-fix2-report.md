# Fix report: frame-wins guard for reviewer run state

Commit: `bec980ccf1408d5400479c19ae0f11aed4e459f5`
Branch: `dev6`

## What changed

**New file `apps/vibedeckx-ui/hooks/use-reviewer-run.ts`** — extracts the
whole `reviewerRun` concern (REST seed + WS frame merge) out of
`agent-conversation.tsx` into a standalone hook, `useReviewerRun(projectId,
branch, sessionId, runUpdate)`, returning `WorkflowRun | null`.

Behavior (frame-wins), same contract as specified in the finding:
- A `frameSeqRef` counter increments every time a `workflowRunUpdated` WS
  frame lands for the current session.
- The REST GET seed (`api.getActiveWorkflowRuns`) captures the counter
  value when it starts (`seqAtStart`). When the response resolves, it only
  applies (`setRun`) if `frameSeqRef.current === seqAtStart` — i.e. no frame
  arrived while the REST call was in flight. A stale, slow REST response
  can no longer clobber a newer frame's state.
- Session/workspace switches clear the run up front so a stale run never
  leaks across sessions while the new seed is loading.

**Deviation from the literal snippet in the finding**: the exact
effect-based shape given (`setReviewerRun(...)` called synchronously inside
a `useEffect` body) trips this repo's `react-hooks/set-state-in-effect`
lint rule (flags effects whose body is pure derived-state-from-props, no
external subscription). My first rewrite avoided that using
`useRef`-based previous-value comparisons at render time, but that in turn
tripped `react-hooks/refs` (no ref read/write during render). Final shape:
- The two synchronous derivations (frame arrival, session-switch clear) are
  done as **render-time state adjustments** — comparing against a `useState`
  copy of the previous props and calling `setState` directly in the render
  body, not in an effect. This is the same pattern already used elsewhere
  in this codebase (`components/diff/diff-panel.tsx`'s
  `seenCompareNonce`/`seenBranch`), confirmed via `grep -rn
  "set-state-in-effect"`.
- The frame-sequence **ref** bump (`frameSeqRef.current++`) was moved into
  its own tiny `useEffect` that only mutates a ref and never calls
  `setState` — the rule explicitly allows ref reads/writes inside effects,
  just not during render.
- The REST-seed effect is unchanged in shape (subscribes to an external
  system, applies the result only inside the `.then()` callback), which is
  exactly the pattern this lint rule endorses.

Race semantics, comments (bilingual), and the public hook signature are
unchanged from the finding's design; only the internal implementation of
the two purely-synchronous derivations moved from effect-body `setState` to
render-time `setState`, to satisfy the repo's lint rules with 0 errors.

**`apps/vibedeckx-ui/components/agent/agent-conversation.tsx`**:
- Removed the local `RUN_ACTIVE` constant, the `reviewerRun` `useState`,
  and both effects (REST seed + WS frame merge).
- Replaced with `const reviewerRun = useReviewerRun(projectId, branch,
  activeSessionId, workflowRunUpdate);`, placed after `activeSessionId` is
  declared.
- Added `import { useReviewerRun } from "@/hooks/use-reviewer-run";`.
- Removed `WorkflowRun` from the `@/lib/api` type import (now unused in
  this file — it lives in the hook). `api` itself is still imported/used
  (`handleFinalize` calls `api.workflowRunGate`).
- `handleFinalize`: since `reviewerRun` is now a derived value (no local
  setter), removed the old `setReviewerRun(run)` call after
  `api.workflowRunGate(...)`. Verified this doesn't regress: the backend's
  `requestFinalVerdict` (`packages/vibedeckx/src/workflow-engine.ts:821`)
  always calls `emitRunUpdated(updated)` right after the finalize
  transition, which broadcasts a `workflowRunUpdated` frame to both
  participant sessions — so the hook picks up the post-finalize status from
  that frame, same as any other transition. `handleFinalize`,
  `isFinalizing`, and all `TurnEndDivider` props are otherwise untouched.

**New file `apps/vibedeckx-ui/hooks/use-reviewer-run.test.tsx`** — 3 tests,
createRoot + act + `vi.mock("@/lib/api")`, deferred REST promise, same
style as `components/conversation/review-run-panel.test.tsx`:
1. **frame-wins**: mount with `runUpdate=null` (REST pending) → rerender
   with a `discussing` frame for `s-rev` → resolve the deferred REST with a
   stale `waiting_feedback` run → assert the rendered status is still
   `discussing`, not clobbered by the stale seed.
2. **seed lands when no frame arrived**: mount with `runUpdate=null` →
   resolve REST with an active run for `s-rev` → assert its status shows.
3. **terminal frame clears**: render with a `discussing` frame → rerender
   with a `completed`-status frame → assert `none`.

## Red-verification (frame-wins guard)

Per instructions, temporarily neutered the guard in
`use-reviewer-run.ts`'s REST `.then()`:

```diff
- if (stale || frameSeqRef.current !== seqAtStart) return; // frame-wins
+ if (stale) return; // TEMP: frame-wins guard removed for red-verification
```

Ran `vitest run hooks/use-reviewer-run.test.tsx` — the frame-wins test
failed as expected, reproducing exactly the bug in the finding:

```
FAIL hooks/use-reviewer-run.test.tsx > useReviewerRun > frame-wins: a later WS frame is not overwritten by a slow, stale REST response
AssertionError: expected 'waiting_feedback' to be 'discussing'
Expected: "discussing"
Received: "waiting_feedback"
```

The other two tests still passed (2/3). Restored the guard, re-ran — all
3 tests green again. Did this twice: once against the first (ref-based)
implementation, once again against the final (render-time-state)
implementation, to confirm the guard is load-bearing in the shipped code,
not just in an intermediate draft.

## Test counts

- `hooks/use-reviewer-run.test.tsx`: 3/3 passed
- `components/agent/turn-end-divider.test.tsx`: 4/4 passed
- `components/conversation/review-run-panel.test.tsx`: 2/2 passed
- `components/agent/agent-conversation.pending-model.test.tsx` (existing,
  exercises `AgentConversation` directly): 6/6 passed
- Full frontend suite (`vitest run`, no filter): 332/332 passed, 48 files

## Verification commands run

```
pnpm --filter vibedeckx-ui exec vitest run hooks/use-reviewer-run.test.tsx \
  components/agent/turn-end-divider.test.tsx \
  components/conversation/review-run-panel.test.tsx   # 9/9 pass

cd apps/vibedeckx-ui && npx tsc --noEmit                # clean, no output

npx eslint hooks/use-reviewer-run.ts hooks/use-reviewer-run.test.tsx \
  components/agent/agent-conversation.tsx               # 0 errors

pnpm --filter vibedeckx-ui exec vitest run               # 332/332 pass (full suite sanity check)
```

## Commit

`bec980ccf1408d5400479c19ae0f11aed4e459f5` — "fix(review): frame-wins
guard for reviewer run state (extract useReviewerRun)"
