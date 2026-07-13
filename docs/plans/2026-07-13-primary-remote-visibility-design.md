# Primary Remote Visibility and Selection

Date: 2026-07-13
Status: Approved

## Problem

A project can be associated with multiple remote servers, but the UI does not
identify which one is the primary remote. Several backend routes, including the
merge-status route for remote-only projects, implicitly choose the first remote
ordered by `sort_order`. This behavior is invisible to users and cannot be
changed directly.

The current representation also permits ambiguous ordering: newly associated
remotes default to `sort_order = 0`, so several remotes may tie for first place.
That makes the effective primary dependent on database row ordering.

Merge-status tooltips currently describe the branch relationship and target,
but not the repository location where the comparison was performed. With
multiple remotes, the result is therefore easy to misinterpret.

## Goals

- Make the primary remote explicit in Project Settings.
- Allow users to choose a different primary remote.
- Guarantee one deterministic primary whenever a project has remotes.
- Make merge-status tooltips state the actual repository location used for the
  comparison: `Local` or the primary remote's server name.
- Keep remote ordering stable when the primary changes.

## Non-goals

- Comparing merge status across every remote.
- Selecting a different repository location per workspace.
- Replacing `sort_order` with a new `is_primary` database column.
- Changing agent or executor target-selection behavior.

## Primary Remote Model

The first project remote ordered by `sort_order` is the primary remote. The
invariant is strengthened so project remotes have a normalized, unique order:
`0..n-1`.

A dedicated endpoint makes the intent explicit:

```http
POST /api/projects/:projectId/remotes/:remoteId/primary
```

The operation verifies project ownership and that the remote association
belongs to the project. In one database transaction it moves the selected
remote to order `0` and preserves the relative order of every other remote,
renumbering them to `1..n-1`.

When a remote is added without an explicit order, it is appended after the
current last remote. It never silently takes over as primary. Removing the
primary naturally promotes the next ordered remote; remaining orders may be
normalized as part of the removal operation.

This avoids a second source of truth such as `is_primary` and avoids the
ambiguous `sort_order = -1` shortcut.

## Settings UI

The Project Settings `Remote Servers` list remains ordered by `sort_order`.

- The first remote displays a visually prominent `Primary` badge.
- Each non-primary remote exposes a `Set as Primary` action.
- The action is disabled while the request is running.
- On success, the list refreshes immediately so the chosen remote moves to the
  first position and receives the badge.
- On failure, the existing form-level error area displays the API error.

The section includes a short explanation:

> The primary remote is used for remote-only projects and default remote
> operations. When a local checkout exists, merge status is computed locally.

Removing the current primary remains allowed; the next remote becomes primary.

## Merge-Status Repository Descriptor

The batch merge-status response includes a repository descriptor alongside the
pair entries:

```ts
type MergeStatusRepository =
  | { kind: "local"; label: "Local" }
  | {
      kind: "remote";
      remoteServerId: string;
      label: string;
    };

interface MergeStatusBatchResponse {
  repository: MergeStatusRepository;
  entries: MergeStatusPairEntry[];
}
```

The project route produces this descriptor from the same routing decision used
to compute or proxy the comparison:

- `project.path` exists: compute locally and return `{ kind: "local",
  label: "Local" }`.
- Remote-only project: choose the primary remote, proxy to its path, and return
  its server ID and server name.

The path-based remote endpoint continues to compute entries only; the
project-facing route owns the user-facing repository identity. This prevents a
frontend inference race when the primary remote changes.

`useMergeStatus` stores the returned descriptor with each successful refresh
and clears it at project boundaries together with branch statuses. Transport
failures retain the previous descriptor for the same project, matching the
existing keep-on-failure behavior.

The sidebar passes the repository label to every merge badge. Tooltip text
becomes, for example:

```text
In sync with main · Local
Merged into main · Remote A
3 commits not in main · Remote B
```

All comparisons in one batch share one repository descriptor.

## Error Handling

- Setting a primary remote that does not belong to the project returns 404.
- A missing project or unauthorized project remains indistinguishable through
  the existing ownership lookup.
- If a remote-only project has no usable remote, merge-status keeps the current
  transport-level error behavior.
- Failed primary changes do not optimistically reorder the UI.
- A failed merge-status refresh for the same project retains the last known
  badges and repository label; switching projects clears both immediately.

## Testing

Backend storage and route tests cover:

- selecting a new primary;
- preserving the relative order of the other remotes;
- deterministic unique `0..n-1` ordering;
- appending new remotes rather than stealing primary;
- promoting the next remote after primary removal;
- rejecting a remote association from another project;
- local merge-status responses returning `Local`;
- remote-only responses returning the selected primary remote ID and name.

Frontend tests cover:

- the Primary badge appears only on the first remote;
- `Set as Primary` invokes the dedicated API and refreshes the list;
- merge-status repository metadata is retained on same-project transport
  failure and cleared on project switch;
- tooltip text includes the actual repository label.

All implementation changes follow red-green-refactor TDD.
