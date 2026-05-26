# Create Folder in Remote Directory Browser — Design

**Date:** 2026-05-26

## Problem

In the Create New Project dialog, when picking a directory on a remote server, users can only navigate into and select *existing* folders. There is no way to create a new folder. Users must create the folder out-of-band (SSH, etc.) before they can point a project at it.

## Goal

Let the user create a new folder directly in the remote directory browser. A "new folder" icon appears in the current-path row; clicking it inserts an inline editable row in the list below where the user types the folder name. On confirm, the folder is created on the remote and selected.

## Scope

The feature lives entirely inside the shared `RemoteDirectoryBrowser` component, so it appears in both places that component is used:

- Create New Project dialog (`create-project-dialog.tsx`)
- Project Settings form (`project-settings-form.tsx`)

Local (non-remote) directory selection uses a different mechanism and is out of scope.

## Interaction model: type-then-create

Clicking the new-folder icon inserts an inline editable row at the top of the list, pre-filled with a default name (`New Folder`, text selected). The folder is only created on the remote when the user confirms. This avoids a separate rename endpoint and never leaves an orphaned folder if the user cancels.

- **Enter / blur** → create on the remote with the typed name.
- **Escape** → cancel, discard the row, nothing created.

## Architecture

The new `mkdir` flow mirrors the existing `browse` flow at every layer.

### Browse flow (existing, for reference)

```
RemoteDirectoryBrowser
  → api.browseRemoteServerDirectory(serverId, path)
  → POST /api/remote-servers/:id/browse            (remote-server-routes.ts, orchestrator)
  → proxyToRemoteAuto → GET /api/browse?path=...    (tunnel / direct)
  → /api/browse route                               (project-routes.ts, remote server)
  → fs.readdir
```

### Mkdir flow (new)

```
RemoteDirectoryBrowser
  → api.createRemoteServerDirectory(serverId, parentPath, name)
  → POST /api/remote-servers/:id/mkdir             (remote-server-routes.ts, orchestrator)
  → proxyToRemoteAuto → POST /api/mkdir            (tunnel / direct)
  → /api/mkdir route                               (project-routes.ts, remote server)
  → fs.mkdir
  → returns { path, name, type: "directory" }
```

## Components

### 1. Remote server route — `POST /api/mkdir` (`project-routes.ts`)

- Body: `{ parentPath: string, name: string }`.
- Validate: reduce `name` to `path.basename(name)`; reject when empty, `.`, `..`, or containing a path separator (400).
- `await fs.mkdir(path.join(parentPath, name))` — non-recursive, so a duplicate name fails with `EEXIST`.
- On `EEXIST` return 409 ("A folder with that name already exists"); other errors return 400.
- On success return `{ path: <joined path>, name, type: "directory" }` — same shape as a browse item so the frontend can select it directly.

This route browses the remote's own filesystem with no base-path restriction, matching the existing unrestricted `/api/browse` route on the remote server.

### 2. `REMOTE_PROVIDER_EXACT` (`server.ts`)

Add `/api/mkdir` to the `REMOTE_PROVIDER_EXACT` set alongside `/api/browse` so the route is reachable through the reverse-connect tunnel.

### 3. Orchestrator route — `POST /api/remote-servers/:id/mkdir` (`remote-server-routes.ts`)

Mirrors the existing `/browse` proxy route:

- `requireAuth`; load server by id + userId; 404 if missing.
- `proxyToRemoteAuto(id, server.url, server.api_key, "POST", "/api/mkdir", { parentPath, name }, { reverseConnectManager })`.
- Forward the remote's status/body; 502 on proxy failure.

### 4. API client — `createRemoteServerDirectory` (`lib/api.ts`)

```ts
async createRemoteServerDirectory(
  serverId: string,
  parentPath: string,
  name: string,
): Promise<RemoteBrowseItem>
```

POSTs `{ parentPath, name }` to `/api/remote-servers/:id/mkdir`. Throws an `Error` carrying the server's error message on a non-OK response (so the UI can show duplicate-name / validation messages).

### 5. `RemoteDirectoryBrowser` UI

- Add a **FolderPlus icon button** in the header row, to the right of the current-path text. Disabled while `loading`.
- Local state `creating: boolean` and `createError: string`.
- Clicking the button sets `creating = true`, rendering an **inline editable row at the top of the list**: folder icon + auto-focused text `<input>` pre-filled with `New Folder` (text selected).
- **Enter / blur**: trim the value; empty cancels. Otherwise call `api.createRemoteServerDirectory(serverId, currentPath, name)`. Show a spinner on the row while in flight.
  - Success: refetch the current directory, clear `creating`/`createError`, and call `onSelect(result.path)` so the new folder is the selected path.
  - Failure: set `createError` to the message, show it inline next to the input, keep the row in edit mode.
- **Escape**: discard the row, clear `createError`, nothing created.

## Error handling

| Case | Layer | Behavior |
| --- | --- | --- |
| Empty / `.` / `..` / separator in name | remote `/api/mkdir` | 400 |
| Duplicate name (`EEXIST`) | remote `/api/mkdir` | 409 "A folder with that name already exists" |
| Other fs error | remote `/api/mkdir` | 400 "Failed to create directory" |
| Proxy/transport failure | orchestrator | 502 |
| Any non-OK | UI | inline message next to input, stay in edit mode |
| Empty after trim | UI | cancel silently (no request) |

## Testing

No test framework is configured in this repo; verification is manual against a connected remote server:

1. Click the new-folder icon → inline row appears with `New Folder` selected.
2. Type a name + Enter → folder is created, appears in the list, and is selected.
3. Try a duplicate name → inline 409 message, row stays editable.
4. Empty name + Enter → row cancels, nothing created.
5. Escape → row cancels, nothing created.
6. Confirm it works in both Create New Project and Project Settings (same component).
