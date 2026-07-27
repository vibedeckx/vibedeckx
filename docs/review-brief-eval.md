# Review-Brief Live Eval

How to run and read the behavioural eval for the review intent-brief
distillation pipeline (`packages/vibedeckx/src/utils/review-brief.ts`). The
eval lives at `packages/vibedeckx/src/utils/review-brief.eval.test.ts`; it is
opt-in, costs real API calls, and never runs in CI (skipped unless
`REVIEW_BRIEF_EVAL` is set).

## Why it exists

Unit tests can only assert that the distillation prompts *say* the right
things. Whether a real model *follows* them — extracts the dominant question,
classifies `[settled]` vs `[tentative]` by user-evidence rather than vibes,
survives compaction without losing attribution — is an empirical question.
This eval answers it with live model calls against fixture conversations.

It has already earned its keep: six rounds of live runs found three real
production bugs (evidence tags bound to one heading and lost after compaction;
`finishReason` never checked, so reasoning models could silently truncate or
return empty text; judgment-call timeout too tight for slow reasoning models).

## Commands

Run from the repo root. **Do not add `-- --run` — that breaks vitest's file
filter and runs the entire 80+-file suite around the eval.** The plain file
argument is enough:

```bash
# Smoke run: fast lane (deepseek-v4-flash), 1 repetition
REVIEW_BRIEF_EVAL=1 DEEPSEEK_API_KEY=sk-… \
  pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts

# Stability run: 3 repetitions per scenario (recommended for any comparison)
REVIEW_BRIEF_EVAL=1 REVIEW_BRIEF_EVAL_REPS=3 DEEPSEEK_API_KEY=sk-… \
  pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts

# Compare the main lane: same reps, judgment model overridden
REVIEW_BRIEF_EVAL=1 REVIEW_BRIEF_EVAL_REPS=3 REVIEW_BRIEF_EVAL_MODEL=deepseek-v4-pro \
  DEEPSEEK_API_KEY=sk-… \
  pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts

# Print every generated brief for human inspection (green runs otherwise
# show only the score table)
REVIEW_BRIEF_EVAL=1 REVIEW_BRIEF_EVAL_VERBOSE=1 DEEPSEEK_API_KEY=sk-… \
  pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts
```

Equivalent from `packages/vibedeckx/`: `REVIEW_BRIEF_EVAL=1 … npx vitest run
src/utils/review-brief.eval.test.ts`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `REVIEW_BRIEF_EVAL=1` | Enables the eval (otherwise all scenarios skip). |
| `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` | Provider credentials. DeepSeek wins when both are set. |
| `REVIEW_BRIEF_EVAL_MODEL` | Overrides the **judgment** model only (see lane split below). Default: the provider's default model (`deepseek-v4-flash`). |
| `REVIEW_BRIEF_EVAL_REPS` | Repetitions per scenario (default 1). LLM output is nondeterministic — use ≥3 for any model comparison. |
| `REVIEW_BRIEF_EVAL_VERBOSE=1` | Appends every rep's full model output (brief, reversal list, compacted input) to the score table. |

## Lane split mirrors production

Production (`generateIntentBrief`) runs **judgment calls** (reversal pre-pass
+ final brief distillation) on the user's **main** chat model and **slice
compression** on the **fast** model. The eval mirrors this:
`REVIEW_BRIEF_EVAL_MODEL` changes only the judgment lane; compaction stays
pinned to the provider default (= the fast lane's default). One lane varies
at a time, and the compaction scenario exercises the exact model pairing
production uses. The table header names both lanes:

```
=== review-brief eval — judgment: deepseek-v4-pro, compaction: deepseek-v4-flash, reps: 3 ===
```

## Scenarios and rubric

Three fixture conversations, each scored as named checks (the score table
prints at the end of the run even when tests fail):

1. **mixed-evidence** — one conversation carrying four evidence tiers at
   once: a core goal stated exactly once (reproducible CSV exports), a
   user-stated hard constraint (never delete audit rows), an explicitly
   accepted non-goal (IE11 → must be `[settled]`), and an agent proposal the
   user never answered (Windows paths → must be `[tentative]`).
2. **reversal** — a long early design (IndexedDB caching) killed by one late
   user sentence. The reversal pre-pass must catch it; the brief must report
   the final approach and never present IndexedDB as adopted.
3. **compaction-survival** — the mixed-evidence conversation padded so the
   older turns go through the slice compactor; the `[settled]`/`[tentative]`
   attribution must survive the extra compression hop.

Shared checks per brief: generated (non-null), not cut by token/char cap,
under the length budget (≤600 words).

## Reading the results

Compare two runs on two axes:

- **TOTAL pass-rate** — quality. This is what a model buys you.
- **Checks strictly between 0 and full marks** (e.g. `2/3`) — stability.
  These are worse than the rate suggests: production gets one shot per
  review, so a 2/3 check means one review in three gets a defective brief.

Failure messages carry full diagnostics: the complete brief, the module's
`console.warn` lines (the production code deliberately swallows errors into
`null`; the eval un-swallows them), and named errors for timeouts/overflows.

Known strictness caveat: the "IndexedDB only as rejected" check is
line-granular — a legitimate chronological narrative line like "the agent
proposed an IndexedDB caching layer" (with the rejection on the next line)
counts as a miss. This is deliberate: the strictness is what made the
flash/pro difference visible. Read a 1-point miss there with the verbose
output before concluding the model is wrong.

## Reference results (2026-07-27, REPS=3)

| Judgment lane | Score | Wall time (3 scenarios × 3 reps) |
| --- | --- | --- |
| deepseek-v4-flash | 62/63 (98%) | ~145s |
| deepseek-v4-pro | 63/63 (100%) | ~302s |

Flash's single miss was mostly the line-granularity caveat above, though its
verbose output also showed one genuine loose tag (a user-rejected plan marked
`[tentative]` instead of `[settled]`). Verdict: both lanes are
production-viable; main=pro buys perfect tags at ~1–2 min extra pre-generation
per review start, main=flash is 98% at half the latency. Cost per rep is
roughly 7 model calls across the three scenarios.

## When to re-run

- After any change to `SYSTEM_PROMPT`, `REVERSAL_SYSTEM_PROMPT`, or
  `COMPACT_SYSTEM_PROMPT` in `review-brief.ts` — these are behavioural
  contracts that unit tests cannot verify.
- After changing token budgets, timeouts, or the model lane split.
- When evaluating a new provider/model for either lane.
