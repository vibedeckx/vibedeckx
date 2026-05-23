# Files page: delete files and folders

**Date:** 2026-05-23
**Status:** Approved (design)

## Goal

Let users delete a file or folder from the Files page: hovering a row reveals a
trash button on the right; clicking it (after a confirmation) deletes the entry
and removes it from the tree.

Works for both **local** workspaces (and worktrees) and **remote** projects,
mirroring the existing browse / file-content / file-download / upload routes.

## Decisions

- **Confirmation:** a `window.confirm` dialog before every delete (files and
  folders), matching the existing delete pattern in
  `components/agent/session-history-dropdown.tsx`. Folder text warns that all
  contents are removed. (We deliberately reuse `window.confirm` rather than add
  the shadcn `alert-dialog` component + `@radix-ui/react-alert-dialog`
  dependency — it keeps the feature consistent with the codebase.)
- **Recursive:** deleting a folder removes everything inside it (`fs.rm` with
  `recursive: true`).
- **Scope:** local **and** remote targets.
- **Root guard:** the workspace root itself cannot be deleted (empty relative
  path is rejected).

## Out of scope

- Multi-select / bulk delete.
- Trash / undo.
- Keyboard `Delete` shortcut.

## Backend (`packages/vibedeckx/src/routes/file-routes.ts`)

### Shared helper `deletePath(basePath, relativePath)`

Placed near `writeUploadedFiles`. Behavior:

- Reject empty/`.` relative path → throw `Error` with `statusCode: 400`
  ("Cannot delete the workspace root").
- Guard with `isPathSafe(basePath, relativePath)` → throw `statusCode: 403` on
  traversal.
- `fullPath = path.resolve(basePath, relativePath)`.
- `await fs.rm(fullPath, { recursive: true, force: false })` — deletes a file or
  a directory tree; throws `ENOENT` if missing (mapped by caller to 404).
- Returns the deleted relative path.

### Route: `DELETE /api/path/delete` (path-based, for remote proxy)

- Querystring `{ path: string; filePath: string; branch?: string }`.
- 400 if `path` or `filePath` missing.
- `basePath = resolveWorktreePath(path, branch ?? null)`; call
  `deletePath(basePath, filePath)`.
- Error mapping: `statusCode` thrown → that code + message; `ENOENT`/`ENOTDIR`
  → 404; `EACCES`/`EPERM` → 403; else 500. Mirrors `/api/path/upload`.
- Success → `200 { deleted: filePath }`.

### Route: `DELETE /api/projects/:id/file` (project-scoped)

- `requireAuth`; load project via `storage.projects.getById`; 404 if not found.
- Querystring `{ path: string; branch?: string; target?: "local" | "remote" }`
  where `path` is the entry's relative path.
- 400 if `path` missing.
- `useRemote = target === "remote" || (!target && !project.path)`.
- **Remote:** `getRemoteConfig`; 400 if null; proxy a `DELETE` to
  `/api/path/delete?path=<remotePath>&filePath=<path>&branch=<branch>` via
  `proxyToRemoteAuto` (with `reverseConnectManager`); relay status + data.
- **Local:** 400 if no `project.path`; `basePath = resolveWorktreePath(...)`;
  call `deletePath(basePath, path)`; same error mapping as the path route.
- Success → `200 { deleted: path }`.

## Frontend

### `api.deleteFile` (`apps/vibedeckx-ui/lib/api.ts`)

```
async deleteFile(
  projectId: string,
  filePath: string,
  branch?: string | null,
  target?: "local" | "remote",
): Promise<{ deleted: string }>
```

Builds `DELETE /api/projects/:id/file?path=…&branch=…&target=…` via `authFetch`
+ `getApiBase()`; throws `Error(error.error || "Delete failed")` on non-ok.
Mirrors the existing `uploadFiles` method shape.

### `useFileBrowser` (`apps/vibedeckx-ui/hooks/use-file-browser.ts`)

Add a `deletingPaths: Set<string>` state and a `deleteEntry(entryPath)` callback
(deps include `projectId`, `branch`, `target`, `refreshDirectory`):

- add `entryPath` to `deletingPaths`.
- `await api.deleteFile(projectId, entryPath, branch, target)`.
- On success: if `selectedFile === entryPath` **or** `selectedFile` starts with
  `entryPath + "/"` (lived inside a deleted folder), clear the selection
  (`setSelectedFile(null)` and clear `fileContent`).
- Refresh the parent directory: `parent = entryPath.includes("/") ?
  entryPath.slice(0, lastIndexOf("/")) : ""`, then `await
  refreshDirectory(parent)`.
- `toast.success("Deleted …")`; on error `toast.error(...)`.
- finally: remove `entryPath` from `deletingPaths`.

Return `deletingPaths` and `deleteEntry` alongside the existing values.

### File tree (`apps/vibedeckx-ui/components/files/file-tree.tsx`)

- New props threaded through `FileTree` → `FileTreeNode`: `deletingPaths:
  Set<string>` and `onDeleteEntry: (entryPath: string, type: "file" |
  "directory") => void`.
- A `DeleteButton` (lucide `Trash2`), shown in the same `hidden
  group-hover:block` slot next to `CopyPathButton` on both file and folder rows.
  - `onClick`: `e.stopPropagation()` (don't select/toggle the row), then
    `window.confirm` with file vs folder wording; if confirmed call
    `onDeleteEntry(nodePath, type)`.
  - While `deletingPaths.has(nodePath)`, show a small `Loader2` spinner in place
    of the trash icon (folder rows already use a spinner for loading; the
    delete spinner is in the action slot, not the chevron slot).

### Wiring (`apps/vibedeckx-ui/components/files/files-view.tsx`)

Destructure `deletingPaths` and `deleteEntry` from `useFileBrowser` and pass
`deletingPaths={deletingPaths}` and `onDeleteEntry={deleteEntry}` to `<FileTree>`.

## Verification

No test framework (per CLAUDE.md). Gates are the type-checks:
- Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit` (only the two known
  pre-existing errors — `appearance-settings.tsx`, `slider.tsx` — are allowed).

Manual end-to-end: hover a file → trash appears → confirm → row disappears,
preview clears if it was open; same for a folder (with its contents); verify on
a remote project; verify root cannot be deleted.
