# Review scope via per-turn git snapshots

**Date:** 2026-07-23
**Status:** Design approved, pending implementation plan

## Problem

When a review session is started via the workflow engine, the reviewer often
audits the wrong code. In the motivating case, a source session fixed a login
bug in `app/signin/actions.ts`, but the reviewer flagged two issues that had
nothing to do with the fix:

- a pre-existing, unrelated uncommitted change in `lib/request-url.ts` (a
  `publicOrigin()` header-trust concern from earlier work), and
- a stale e2e assertion in `e2e/home.spec.ts`.

The actual fix got one approving sentence. The user had to explicitly redirect
the reviewer to focus on the fix.

### Root causes

1. **Scope is not pinned to the change under review.** `buildReviewerPrompt`
   hands the reviewer a whole dirty worktree and says "inspect the workspace,
   run `git diff`/`git status`/`git log`." Whenever the worktree carries
   unrelated pre-existing uncommitted changes (common in this repo's dev flow),
   the reviewer audits them too.
2. **The review target mislabels scope.** `review-target.ts` reports
   `diffStat` from `git diff --shortstat`, which counts only tracked, unstaged
   changes. In the motivating case it said "2 files changed" while `git status`
   showed 4 paths (untracked `lib/request-url.ts` + its test were excluded).
3. **The distilled intent brief guessed the wrong files.** The brief's
   "intended scope" said to modify `app/api/auth/verify/route.ts`, but the fix
   landed in `app/signin/actions.ts`. The distiller blended early
   investigation (explored-then-abandoned paths) from the conversation head with
   the final summary. The one signal meant to focus the reviewer pointed at the
   wrong file.

### Why not just parse tool calls

An earlier idea was to derive the changed-file set from the reviewed turn's
`Edit`/`Write` tool calls. Rejected as hacky and because it does not survive the
source agent committing its work. The chosen approach uses git-native snapshots.

### Why scope must not be classified

"Focus on the fix" is only one scenario; another is reviewing a whole feature
implementation, where broad scope is correct. We deliberately do **not** build a
classifier (least of all an LLM one) to decide fix-vs-implementation. Instead,
scope is computed as the delta the reviewed unit actually produced — small when
the work is small, large when the work is large. Scope follows the work.

## Approach

Capture a lightweight git snapshot at each turn boundary. The change under
review is the **delta between two snapshots**: a start boundary chosen by span,
and the current (review-time) state as the end boundary. This is robust to
committed work, uncommitted work, and mixed states, and — crucially — isolates
one turn's changes from a *prior* turn's still-uncommitted changes, which git
alone cannot do when nothing was committed between them.

### Data model — `turn_snapshots` table

New table in `packages/vibedeckx/src/storage/sqlite.ts` (style matches existing
`CREATE TABLE IF NOT EXISTS`), plus a `turnSnapshots` sub-store on the `Storage`
interface in `storage/types.ts`:

```
turn_snapshots(
  session_id      TEXT     NOT NULL,
  turn_end_index  INTEGER  NOT NULL,   -- turn_end entry index; session-start sentinel = -1
  head            TEXT     NOT NULL,   -- git rev-parse HEAD at the boundary
  dirty           TEXT     NOT NULL,   -- JSON: { <path>: <blobSha | "∅"> }, uncommitted files only
  captured_at     INTEGER  NOT NULL,
  PRIMARY KEY (session_id, turn_end_index)
)
```

The snapshot is **not** stored on the `turn_end` entry: `turn_end` entries are
serialized into JSON patches pushed to the frontend over WebSocket, and the
`dirty` map does not belong on the wire.

### Snapshot capture — `captureSnapshot(worktreePath)`

A single helper returns `{ head, dirty }`:

- `head` = `git rev-parse HEAD`
- `dirty` = for each path in `git status --porcelain` (modified / staged /
  untracked / deleted): its content hash via `git hash-object <path>`. A
  deletion (`D` status) is recorded as the **absence sentinel `∅`**, not
  hashed (the file is gone from disk).

Blob shas from `git hash-object` share git's blob namespace, so they compare
directly against committed blob shas obtained via `git rev-parse <commit>:<path>`
during scope computation.

Captured at three points, all running where the worktree lives (worker-side for
remote sessions, exactly like the existing `captureReviewTarget`):

1. **Session start** — one `turn_end_index = -1` snapshot, before the first turn.
   Enables the "since session start" span and gives turn 1 a "before".
2. **Each turn end** — in `agent-session-manager.ts` `endActiveTurn` (the sole
   constructor of `turn_end` entries, ~line 1402), after the entry index is
   known, write a snapshot keyed by that index.
3. **Review time** — extend `captureReviewTarget` (`utils/review-target.ts`) to
   also produce the `dirty` blob-sha map. It already runs `git status
   --porcelain`; we add `git hash-object` for the dirty files. This is the
   "end" boundary of the delta and also strengthens drift detection.

### Scope computation — `computeScope(startSnap, endSnap)`

```
candidates =
    git diff --name-only <startSnap.head> <endSnap.head>   // committed part
  ∪ { p : p ∈ startSnap.dirty ∪ endSnap.dirty }            // uncommitted overlay part

for each F in candidates:
  startSha = startSnap.dirty[F] ?? blobShaOrAbsent(startSnap.head, F)
  endSha   = endSnap.dirty[F]   ?? blobShaOrAbsent(endSnap.head, F)
  include F in scope  ⟺  startSha ≠ endSha

blobShaOrAbsent(head, F) = git rev-parse <head>:F, or "∅" if absent
```

Comparison is by **content hash, not git status**. This makes the following all
resolve correctly:

- **Pre-existing dirty file untouched by this turn** (the motivating bug): same
  blob sha at both boundaries → excluded.
- **Manual commit of prior-turn uncommitted work between turns**: the committed
  blob equals the previously-stored dirty blob → same sha → excluded.
- **Staging churn** (`git add`, commit-same-content, stage-then-revert): final
  content unchanged → excluded.
- **Deletion**: real blob → `∅` (or `∅` → `∅` when a prior
  deletion is merely committed later) → correctly included / excluded.
- **Rename** (no `-M`): appears as delete-old + add-new, both in scope. A
  display-layer `git diff -M` over the scope files can render it as a rename;
  this does not affect scope correctness.

**Known limitation:** the delta captures every repo mutation in the interval,
including changes a human makes manually *between* agent turns. A genuinely new
manual edit between turns folds into the next turn's scope. This is inherent to
any boundary-diff model; harm is low (a human edit between turns getting
reviewed is defensible) and it is documented, not fixed.

### Span selection — default last turn, "from turn X inclusive"

The span moves the **start** boundary only; the **end** boundary is always the
review-time snapshot (frozen into `workflow_runs.review_target` at review start,
so a still-running source session cannot shift this review's scope — existing
`hasDrifted` handles staleness).

Semantics: selecting turn X means "review from turn X onward, **inclusive of
X**", so the start boundary is the snapshot *before* X (= turn X−1's end):

| Selection            | Start snapshot            | Scope                         |
|----------------------|---------------------------|-------------------------------|
| **This turn** (default) | previous turn's end     | only the last turn            |
| Earlier **turn X**   | turn X−1's end            | turn X … now (inclusive of X) |
| **Since session start** | `turn_end_index = -1`   | the whole session             |

"This turn" is just the special case X = last turn, so all three share one
code path.

- Engine resolves the end-boundary snapshot from `source_turn_end_index`, and
  the start-boundary snapshot from the chosen span.
- The span is persisted on the run (new `workflow_runs.review_span` column) and
  passed from the review-start entry point.
- **Phase 1 hardcodes "this turn"** (no UI). The selector UI is Phase 2.

### Reviewer prompt — name the scope, add scope discipline

In `buildReviewerPrompt` (`workflow-engine.ts`):

- **Name the scope:** "The change under review touches exactly these files:
  `<changedFiles>`. It starts from commit `<startHead>` — use `git diff
  <startHead> -- <files>` and `git log <startHead>..HEAD` to see the content."
- **Scope discipline:** "Confine your review to those files and changes. Other
  uncommitted or pre-existing changes in the worktree, or changes from other
  turns, are out of scope unless this change depends on them."
- **Fallback:** when snapshots are missing (sessions predating this feature, or
  a capture failure), do not name files; fall back to current behavior and state
  "scope unknown — judge the relevant range yourself."

### Distill downgrade — intent only

In `review-brief.ts` `SYSTEM_PROMPT`, drop item 3 ("The intended scope of the
changes"). File scope is now supplied objectively by snapshot delta and must not
be guessed from prose. The brief keeps goal, constraints/rejected approaches,
and accepted trade-offs — the things code cannot show. Optionally, pass the real
`changedFiles` to the distiller as a constraint ("do not name files outside this
list") to prevent the wrong-file failure from recurring.

## Components and boundaries

- **`captureSnapshot(worktreePath)`** (`utils/review-target.ts` or a sibling) —
  pure git read → `{ head, dirty }`. No storage, no engine knowledge.
- **`computeScope(startSnap, endSnap, worktreePath)`** — pure function over two
  snapshots + git reads → `{ changedFiles: string[], startHead: string }`.
  Independently unit-testable with fixture repos.
- **`turnSnapshots` store** — CRUD only; `create`, `get(sessionId, index)`,
  `getSessionStart(sessionId)`, `getLatestBefore(sessionId, index)`.
- **`endActiveTurn` hook** — one call to capture + persist; failure is
  non-fatal (log and continue; scope falls back).
- **Engine** — resolves start/end snapshots by span, calls `computeScope`,
  feeds `buildReviewerPrompt`.

## Phasing

- **Phase 1 (core, fixes the reported bug):** table + store + `captureSnapshot`
  at session-start and turn-end + `captureReviewTarget` extension +
  `computeScope` + prompt scope-naming/discipline + fallback. Span hardcoded to
  "this turn".
- **Phase 2:** span selector UI + `review_span` persistence + distill downgrade
  (and optional changedFiles constraint into the distiller).

## Testing

- `computeScope` unit tests over temp git repos covering: pre-existing dirty
  untouched (excluded); fix-only turn (only fix file); committed work; manual
  commit of prior uncommitted work (excluded); staging churn (excluded);
  deletion (included); deletion committed later (excluded); rename (both paths);
  span = session start vs this turn.
- `captureSnapshot` unit tests: clean tree → empty dirty; untracked file →
  hashed; deletion → sentinel.
- Snapshot-missing fallback: engine produces a valid prompt with no scope
  naming.
- End-to-end: reproduce the motivating scenario (pre-existing dirty
  `request-url.ts` + fix in `actions.ts`) and assert the prompt names only the
  fix file.

## Non-goals

- Exact line-level isolation when the same file is left uncommitted across
  multiple turns (documented over-report; the scope *file set* is still exact).
- Distinguishing human vs agent authorship of between-turn edits.
- Classifying reviews as fix vs implementation.
