# Branch Merge Status — Design

Date: 2026-07-12
Status: Approved (brainstorm with Jesse)

## Problem

The team's workflow is: work in a workspace (git worktree / branch), then merge the result
into another branch (usually `main`, sometimes another dev branch). Today there is no way
to see, per workspace, whether its changes have already landed in the target branch. Users
have to run git commands manually to find out.

## Goal

A per-workspace badge in the sidebar that answers "is this branch merged into its target
branch yet?", with a one-click path to inspect the unmerged changes in the Diff tab.

## Non-goals

- A full "branch × target merge matrix" view (sidebar badge is sufficient).
- Recording merge events in the database (git is the source of truth).
- Squash-merge content detection via `git merge-tree` (deferred to phase 2, see below).

## Key semantics

- The comparison is **the branch currently checked out in each worktree** vs **a target
  branch name**. Worktree → branch mapping is dynamic (users switch branches inside a
  worktree with git commands), so it is re-read live from `git worktree list` on every
  request — never persisted.
- The target is a **branch name**, never a workspace. Each workspace remembers its own
  target (different workspaces can merge to different destinations, e.g. dev3 → main,
  dev4 → dev1).

## Merge detection algorithm (tiered)

For each worktree branch (skipping detached HEAD and branch == target):

1. **Ancestor check** — `git merge-base --is-ancestor <branch> <target>`. Hit ⇒ `merged`.
   Covers normal merges and fast-forwards. Milliseconds; run for all branches.
2. **Patch-id check** — `git cherry <target> <branch>`. Covers rebase / cherry-pick merges.
   - all `-` ⇒ `merged`
   - mixed ⇒ `partial` (unmergedCount = number of `+` lines)
   - all `+` ⇒ `unmerged` (unmergedCount = number of `+` lines)
   - empty output ⇒ `no-unique-commits`
3. **Dirty check** — `git status --porcelain` in the worktree directory, reported as an
   independent boolean (a dirty worktree can still be `merged`).

Known limitation (accepted for phase 1): squash merges and conflict-resolved merges make
`git cherry` report `+` for commits whose content actually landed — the badge is
conservative (shows unmerged when in doubt), never falsely shows merged.

**Phase 2 (not in this spec's implementation):** add a content-level check with
`git merge-tree --write-tree <target> <branch>` (git ≥ 2.38; detect version at startup,
silently skip if unsupported): if the simulated merge tree equals the target's tree, the
branch content is fully contained ⇒ `merged`.

## Backend

### New route file: `packages/vibedeckx/src/routes/merge-status-routes.ts`

Modeled on `branch-activity-routes.ts` (project route + `/api/path/` variant + remote proxy).

**`GET /api/path/branches/merge-status?path=<repo>&target=<branch>`**

- Enumerates worktrees via existing `parseGitWorktreeList` from `utils/worktree-paths.ts`.
- `target` optional; when absent, auto-detect the default branch: `main` if it exists,
  else `master`, else 400.
- If `target` names a branch that does not exist ⇒ 400.
- Response:

```json
{
  "target": "main",
  "entries": [
    { "branch": "dev3", "status": "merged", "unmergedCount": 0, "dirty": true },
    { "branch": "dev4", "status": "partial", "unmergedCount": 2, "dirty": false }
  ]
}
```

`status ∈ merged | partial | unmerged | no-unique-commits`. Detached-HEAD worktrees and
the worktree checked out on `target` itself are omitted.

**`GET /api/projects/:id/branches/merge-status?target=<branch>`**

- `requireAuth` + project ownership via `storage.projects.getById(id, userId)` (same as
  the worktrees route).
- Local project ⇒ compute locally; remote-only project ⇒ `proxyToRemoteAuto` to the
  `/api/path/` variant (same pattern as `/api/projects/:id/worktrees`).

### Git invocation safety

All git calls use `execFileSync("git", [args...])` — never string-interpolated `execSync` —
because `target` is user-supplied. Additionally validate `target` with
`git rev-parse --verify refs/heads/<target>` (the existing pattern in worktree-routes.ts)
before use; its failure doubles as the 400 for nonexistent branches.

### Caching

In-memory `Map` keyed by `repoPath + "\0" + branch`, value
`{ branchTip, targetTip, status, unmergedCount }`. On each request, resolve both tips
(`git rev-parse`); if both match the cached entry, reuse the status and skip tiers 1–2.
`dirty` is always recomputed (working-tree changes don't move tips). No TTL needed —
tip equality is the invalidation.

### Diff route: new "vs target" mode

In `diff-routes.ts`, add an optional `compareTo=<branch>` query param to both
`GET /api/path/diff` and `GET /api/projects/:id/diff` (mutually exclusive with `commit`):

- Runs `git diff <compareTo>...HEAD --no-color` (three-dot: everything the branch would
  bring to the target since their merge-base) via `execFileSync`.
- `compareTo` validated with `rev-parse --verify` like above.
- No untracked-file injection in this mode (it compares committed content only).

## Frontend

### Hook: `hooks/use-merge-status.ts`

`useMergeStatus(projectId, targetsByBranch)` — fetches
`/api/projects/:id/branches/merge-status` once per **distinct target** among the visible
workspaces (typically 1–2 requests), merges results into
`Map<branch, { status, unmergedCount, dirty }>`. Refreshes alongside the existing
worktrees refresh cadence (same triggers as `use-worktrees`).

### Per-workspace target persistence

localStorage key `vibedeckx:mergeTarget:<projectId>:<branch>` → target branch name.
Absent ⇒ use the backend's auto-detected default (the response's `target` field). Follows
the existing persisted-tab pattern in `right-panel.tsx`.

### Sidebar badge (`app-sidebar.tsx`)

At the end of each workspace row (before the row menu):

- `merged` → muted gray check icon
- `partial` / `unmerged` → amber count (`unmergedCount`)
- `no-unique-commits` → no badge
- `dirty` → small dot overlaid on whatever badge is shown (including the check), meaning
  "uncommitted changes present"

Clicking the badge selects that workspace and opens the **Diff tab** preset to
"vs `<target>`" mode (uses the same programmatic tab-switch mechanism as the existing
`setActiveTab("files")` file-open path in `right-panel.tsx`). A fully merged branch opens
an empty diff ("No changes") — consistent behavior, no special case.

### Workspace row menu

Replace the bare hover trash button (`app-sidebar.tsx:385-396`) with a hover-visible `⋯`
button opening a shadcn `DropdownMenu`:

1. **Compare against →** submenu: branch list from existing
   `/api/projects/:id/branches`, current target checked; selecting writes the
   localStorage key and refreshes that row's badge.
2. **Delete worktree** — destructive styling, same `onDeleteWorktree` flow as today.

### Diff tab (`components/diff/`)

`CommitSelector` gains a "vs `<target>`" entry alongside "Uncommitted changes" and the
commit list. Selecting it calls the diff API with `compareTo=<target>`. The badge's
deep-link presets this selection.

## Edge cases

- Detached HEAD worktree ⇒ omitted from response, no badge.
- Branch == its target ⇒ omitted (covers the main worktree vs default target).
- Target branch deleted after being persisted ⇒ backend 400; frontend falls back to the
  auto-detected default and clears the stale localStorage key.
- git < 2.38 ⇒ irrelevant in phase 1 (merge-tree is phase 2).
- Large repos: `git status --porcelain` per worktree runs only when the sidebar fetches;
  no background polling is added.

## Testing

Vitest, following the temp-git-repo fixture style of `projects.test.ts` /
`one-shot-exec.test.ts`. Unit-test the status computation function against fixtures:

- normal merge ⇒ `merged` (tier 1)
- rebase-then-merge ⇒ `merged` (tier 2)
- some commits cherry-picked ⇒ `partial` with correct count
- no commits merged ⇒ `unmerged`
- branch with no unique commits ⇒ `no-unique-commits`
- dirty worktree ⇒ `dirty: true` independent of status
- detached HEAD ⇒ omitted
- nonexistent target ⇒ 400
- cache: same tips ⇒ cached; moved tip ⇒ recomputed
- diff `compareTo` mode returns three-dot diff, rejects invalid branch names
