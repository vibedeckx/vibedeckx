# Merge-Status Git Ref Watcher — Phase 2 Design

Date: 2026-07-13
Status: Designed, NOT built (deferred until the phase-1 triggers prove insufficient)
Prerequisite reading: `docs/superpowers/specs/2026-07-12-branch-merge-status-design.md`

## Problem

The sidebar merge badges refresh only when a frontend trigger fires. After the
phase-1 trigger set (project switch, worktree change, agent turn end, executor
stop, window focus, visible-tab backstop polling), the worst-case staleness is
one poll interval (~60s). Git operations that change branch/target tips can
come from **any** source the triggers cannot see directly:

- `git rebase` / `git merge` / `git commit` typed into the app's built-in
  terminal (the window is already focused, so the focus trigger never fires);
- executor runs on a **remote** server observed only via forwarded events;
- external tools operating on the same repo (IDE, scripts, cron).

Polling closes these gaps with latency; this design closes them with a push.

## Design

Backend watches the project repo's git refs; any tip movement emits a
project-scoped event on the existing event bus, which already flows to the
frontend over `/api/events` SSE. The frontend treats it as one more refetch
trigger.

```
git ref write (any source)
  → fs.watch on .git/refs/heads + .git/packed-refs   (debounced ~300ms)
  → eventBus.emit({ type: "git:refs-changed", projectId })
  → /api/events SSE (existing per-tenant filtering applies)
  → useMergeStatusAutoRefresh refetches the batch merge-status POST
```

No payload beyond `projectId` is needed: the batch endpoint recomputes all
pairs and the tip-SHA cache makes unchanged pairs nearly free, so "something
changed, refetch everything" is both simple and cheap.

## What to watch

All worktrees share the main repo's ref store, so **one watcher per project
repo covers every workspace branch**:

| Path | Why |
| --- | --- |
| `<repo>/.git/refs/heads/` (recursive) | loose refs — every commit/merge/rebase/reset writes here; recursive because branch names with `/` create subdirectories |
| `<repo>/.git/packed-refs` | `git pack-refs` / `gc` moves tips here; also written by some porcelain |
| `<repo>/.git/worktrees/*/HEAD` | branch *switch inside a worktree* (`git checkout` in a worktree changes which branch the workspace row represents, not any tip) |

Not watched, by design:

- **Working-tree files (dirty state).** Dirty changes don't touch refs, and
  watching entire worktrees is noisy and expensive. Dirty staleness stays on
  the poll/focus/turn-end triggers — acceptable for a secondary indicator.
- `.git/HEAD` of the main repo — the main workspace row shows no badge.

Platform note: `fs.watch({ recursive: true })` on Linux requires Node ≥ 20
(the project already targets modern Node). Fallback if that ever regresses:
non-recursive watch on `refs/heads` + `packed-refs` and accept missing
slash-subdirectory branches, or re-`watch()` subdirectories on discovery.

## Debounce

A rebase rewrites refs many times in quick succession; `git commit` touches
lock files that fire spurious watch events. Debounce per project (~300ms
trailing) and coalesce into at most one `git:refs-changed` per window. The
frontend additionally coalesces naturally: `refetch()` bumps a nonce; the
effect's in-flight guard (`cancelled`) means overlapping bumps collapse into
the latest fetch.

## Watcher lifecycle

Watchers must not accumulate for projects nobody is looking at:

- **Start** lazily on the first merge-status POST for a project (the signal
  that some client is showing badges). Keep a `Map<projectId, watcher>`.
- **Stop** after an idle TTL (e.g. 10 min with no merge-status request and no
  `/api/events` subscriber) — the next request restarts it. TTL, not
  subscriber-count, because SSE consumers are global (not per-project) and
  reconnect churn would thrash watchers.
- **Cap** total watchers (e.g. 20, LRU eviction) as a runaway guard for
  many-project installs.
- Watcher errors (repo deleted, EMFILE) log and drop the watcher — the
  feature degrades back to polling, never breaks the request path.

## Remote projects

The watcher runs where the repo lives — on the **remote** vibedeckx server.
The emitted `git:refs-changed` rides the existing remote→local event
forwarding (the same path `executor:stopped` from a remote already takes,
via the reverse-connect / remote status bridge). The local server re-emits it
on its own bus with the local `projectId`, so the frontend is origin-agnostic.

Version skew: an older remote simply never emits the event — the frontend's
polling backstop still applies, so the feature degrades gracefully.

## Frontend

One addition to `useMergeStatusAutoRefresh`: subscribe (via the existing
`useGlobalEventStream`) to `git:refs-changed` for the current project →
`refetch()`. Once this ships, the visible-tab backstop poll can be slowed
substantially (e.g. 5 min) — kept as belt-and-braces for missed events rather
than removed.

## Testing

- Unit: temp git repo + real watcher — commit / branch / rebase / pack-refs
  each produce exactly one debounced event; idle TTL stops the watcher; cap
  evicts LRU.
- The existing auto-refresh hook behavior tests gain one case: a
  `git:refs-changed` event for the current project refetches; for another
  project it doesn't.

## Why deferred

Phase-1 triggers (executor stop + visible-tab 60s backstop) bound staleness
at ~60s for the in-app-terminal case and make executor-driven changes
near-instant. The watcher adds real complexity — lifecycle management,
remote forwarding, platform quirks — that is only worth paying if the ~60s
lag proves annoying in practice.
