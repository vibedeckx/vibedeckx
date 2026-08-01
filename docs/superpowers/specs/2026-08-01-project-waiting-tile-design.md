# Project dashboard: Failed tile → Waiting tile

Date: 2026-08-01
Status: approved, ready to implement

## Problem

The project Home dashboard opens with a three-tile strip:

```
[ Running  2 ][ Failed  0 ][ Next schedule  8/1 09:00 ]
```

The middle tile earns nothing.

**It is mislabelled.** `summary.failed` is `countAttentionByProject` — which counts
`status = 'error'` *plus* `status = 'stopped'` sessions whose last user message has
no completion after it. The second half is not a failure; it is "you asked
something and the turn stopped before answering". Both render in destructive red.

**It is a duplicate.** The same predicate feeds `listAttentionByProject`, which
draws the Attention Required card lower on the same page. The tile is a count of a
list the user can already see.

**It is rarely non-zero.** Sessions seldom fail outright; schedules fail more, but
not often. A tile that reads `0` almost every visit teaches the eye to skip the
whole strip — which costs the Running tile its readership too.

## Decision

Keep the strip. Replace the middle tile with **Waiting** — how many unread
attention milestones this project has for you.

The strip is a glance surface. The most valuable answer at a glance in this
product is "is anything waiting on me?", not "did anything break?". Waiting for a
human happens constantly here; breaking does not.

`session_failed` and `workflow_failed` are two of the four milestone kinds, so
the failure signal is not dropped — it is absorbed into a truer count.

Out of scope, deliberately: Running and Next schedule tiles, the five cards below,
and click-through from the tile.

## Data source: the bell, not the backend

The count is derived on the client from `useCompletionNotifications` — the same
state that drives the bell menu — filtered to this project and `read_at === null`.

`useCompletionNotifications` is already mounted in `app/page.tsx` (one instance,
in the tree that renders `ProjectInfoView`). The count threads down as a prop.
Do not mount a second instance of the hook: it plays completion sounds.

The alternative — a new `summary.waiting` field on `/api/projects/:id/activity` —
is rejected. `useProjectActivity` refetches on events matching
`/^(session|schedule|task):/`, and marking a notification read emits nothing at
all (the bus has `notification:created` only). The tile would freeze at a stale
number until an unrelated event happened to land. Server-side accuracy would cost
a new `notification:read` event and a new subscription to buy a worse-behaved
tile.

Accepted limitation: the bell hydrates the newest 100 notifications, so unread
items past that window are not counted. Strict agreement with the bell matters
more here than the 101st row.

## Tile

- Label `Waiting`. `title` / `aria-label`: "Unread updates waiting for you".
- Value: unread milestone count for this project, all four kinds
  (`session_result_ready`, `review_ready`, `session_failed`, `workflow_failed`).
- Colour: amber when `> 0`, default foreground at `0`. Not destructive red —
  "something is waiting" is not "something is broken".
- Not clickable. Navigation lands with A2 (below).

## Accepted inconsistency

The strip can read `Waiting 2` while Attention Required below reads "All clear",
and vice versa. That is correct: they now answer different questions — unread
progress versus failed-or-interrupted sessions. This is the price of removing the
duplication, and it is deliberate.

## Backend cleanup

`summary.failed` becomes dead the moment the tile stops reading it, so it goes,
along with its three now-unreferenced sources:

- `ProjectActivity.summary.failed` (`project-activity.ts`)
- `agentSessions.countAttentionByProject` — repository, `Storage` interface, and
  its call site. `listAttentionByProject` **stays**; the Attention Required card
  is untouched.
- the `scheduledTaskRuns.countByProjectStatuses(projectId, ["failed","timeout"])`
  call (the method itself stays — `["starting","running"]` still uses it)
- the `failed` column of `searchCache.countRemoteSessionActivityByProject`, whose
  return type narrows to `{ running: number }`

## Future: A2

A later change adds "an agent is blocked on you right now" — sessions parked on a
permission prompt or `AskUserQuestion`. That needs durable state that does not
exist yet (`AgentSessionStatus` is `running | stopped | error`; the waiting-ness
lives only in the in-memory `RunningSession`, and remote sessions would need to
sync it over the tunnel).

Whether A2 becomes a fourth tile or splits Waiting in two is decided then. **This
change adds no abstraction on its behalf.**

## Tests

- `project-activity-view.test.tsx`: drop the `failed` assertions; add the Waiting
  count and its zero / non-zero colour cases.
- `project-info-view.activity.test.tsx`: confirm the prop reaches the tile.
- `project-activity-routes.test.ts` and any storage test asserting `failed`:
  drop those assertions (`search-cache.test.ts` covers the narrowed return type).
