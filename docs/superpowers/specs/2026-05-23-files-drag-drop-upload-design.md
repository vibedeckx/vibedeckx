# Files page: drag-and-drop file upload

**Date:** 2026-05-23
**Status:** Approved (design)

## Goal

Let users upload files to the workspace by dragging them onto the Files page:

- Drop onto the file tree's empty/root area → upload to the **workspace root**.
- Drop onto a **folder row** → upload into that folder.

Works for both **local** workspaces (and worktrees) and **remote** projects.

## Decisions

- **Conflicts:** overwrite silently. A dropped file replaces any existing file of the same name in the target directory.
- **Scope:** local **and** remote targets, mirroring the existing `browse` / `file-content` / `file-download` proxy pattern.
- **Drop types:** files only (one or many). Dropped directories are ignored in v1 (no `webkitGetAsEntry` recursion).

## Out of scope (v1)

- Folder/directory uploads.
- Per-file upload progress bars.
- Paste-to-upload (a separate `paste-to-file` feature already exists).

## Backend

### New dependency

Add `@fastify/multipart` and register it in `server.ts`. The existing `bodyLimit` is 16MB; multipart file size limits are configured on the plugin/route.

### Route: `POST /api/projects/:id/upload` (project-scoped)

In `packages/vibedeckx/src/routes/file-routes.ts`, following the structure of the `browse` route:

- Auth via `requireAuth`; load project via `storage.projects.getById`.
- Query params: `path` (target directory, relative — empty = root), `branch`, `target` (`"local" | "remote"`).
- `useRemote = target === "remote" || (!target && !project.path)`.

**Local branch:**
1. `basePath = resolveWorktreePath(project.path, branch ?? null)`.
2. `targetDir = path` relative ? `path.resolve(basePath, path)` : `basePath`.
3. Guard with `isPathSafe(basePath, path || ".")` → 403 on traversal.
4. Verify `targetDir` exists and is a directory → 404 otherwise.
5. Stream each multipart file part to `path.join(targetDir, sanitizedFilename)`.
   - Sanitize each filename to its basename (`path.basename`) to prevent any path
     components in the multipart `filename` from escaping the target dir.
   - Overwrite existing files (open with default write flags, truncating).
6. Respond `200 { uploaded: string[] }` (filenames written).

**Remote branch:** read each uploaded file into a Buffer, then forward as JSON to the
path-based remote endpoint via `proxyToRemoteAuto` (this also covers the
reverse-connect tunnel). The existing JSON proxy is reused — no new binary-streaming
proxy is introduced.

Request body to remote:
```json
{
  "path": "<remoteConfig.remotePath>",
  "branch": "<branch?>",
  "relativePath": "<target dir, relative>",
  "files": [{ "name": "foo.png", "contentBase64": "..." }]
}
```
Return `reply.code(proxyStatus(result)).send(result.data)`.

### Route: `POST /api/path/upload` (path-based, for remote execution)

Mirrors the path-based `browse` route. Accepts the JSON body above:
1. `basePath = resolveWorktreePath(path, branch ?? null)`.
2. `targetDir = relativePath` ? `path.resolve(basePath, relativePath)` : `basePath`.
3. `isPathSafe(basePath, relativePath || ".")` guard.
4. For each file: sanitize name to basename, `isPathSafe` re-check, decode base64,
   `fs.writeFile(path.join(targetDir, name), buf)` (overwrites).
5. Respond `200 { uploaded: string[] }`.

### Size limit

Because remote uploads ride the JSON proxy, total request size is bounded by the
16MB `bodyLimit` (and base64 inflates payloads ~33%). Set a per-file/total cap
(e.g. reject if a file exceeds a configured limit) and return a clear 413-style
error. Document this as a known v1 constraint; large/binary-heavy uploads to remote
may need a dedicated streaming proxy later.

## Frontend

### API method (`apps/vibedeckx-ui/lib/api.ts`)

```ts
async uploadFiles(
  projectId: string,
  files: File[],
  targetPath: string,        // relative dir; "" = root
  branch?: string | null,
  target?: "local" | "remote",
): Promise<{ uploaded: string[] }>
```
POST `FormData` (one `file` part per file) to
`/api/projects/{projectId}/upload?path=...&branch=...&target=...`.

### Drop handling

The `useFileBrowser` hook already owns directory state and refresh. Add drag-and-drop
in the Files UI:

- **Root drop zone:** the file-tree container in `file-tree.tsx` / `files-view.tsx`.
  Dropping here uploads to `""` (root).
- **Folder drop target:** each directory `FileTreeNode` row. Dropping onto it uploads
  to that folder's relative path.
- Track the active drop target (root vs a specific folder path) in local state so only
  the hovered target highlights; show a clear drag-over style (border/background).
- Ignore drags that contain no files (e.g. text selections); ignore directory entries.
- While uploading, show a spinner on the target (reuse `Loader2` pattern); on completion
  show a toast and refresh that directory (and expand the folder if collapsed so the new
  files are visible).
- On error, toast the message; no partial UI state left behind.

## Error handling

- Path traversal → 403.
- Missing/!directory target → 404.
- File too large (remote) → 413-style error with a clear message.
- Remote proxy failure → forward `proxyStatus(result)` and remote error body.
- Frontend surfaces all of these via toast.

## Testing

No automated test framework is configured. Manual verification:
1. Drag a single file to root → appears at workspace root.
2. Drag multiple files to a folder → all appear inside it.
3. Drag a file matching an existing name → overwrites, content updated.
4. Drag onto a collapsed folder → uploads and folder expands to show files.
5. Repeat 1–4 against a remote project (`target=remote`).
6. Attempt path traversal via crafted filename → rejected.
