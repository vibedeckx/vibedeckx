# Files Page Drag-and-Drop Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag files from their OS onto the Files page and upload them — to the workspace root when dropped on the tree's root area, or into a folder when dropped on that folder's row — for both local and remote projects.

**Architecture:** Add `@fastify/multipart` to the backend. A new project-scoped `POST /api/projects/:id/upload` accepts multipart files; for local targets it writes them to the resolved worktree directory, and for remote targets it reads each file into a buffer and forwards them (base64) as JSON to a new path-based `POST /api/path/upload` over the existing `proxyToRemoteAuto` proxy/reverse-connect tunnel. The frontend adds an `api.uploadFiles` method, an `uploadFiles` action in `useFileBrowser` that refreshes the affected directory, and native HTML5 drag-and-drop handlers on the file tree.

**Tech Stack:** Fastify 5 + `@fastify/multipart` 9 (backend, ESM/NodeNext — local imports need `.js`), Next.js 16 / React 19 + Tailwind v4 + sonner toasts (frontend).

**Note on testing:** This repo has **no test framework** (see CLAUDE.md). Each backend task is verified with the backend type-check; each frontend task with the frontend type-check; the feature is verified end-to-end manually in the final task. There are no automated test steps because there is no runner to execute them — do not scaffold one.

**Type-check commands (used throughout):**
- Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`

---

## File Structure

**Backend (`packages/vibedeckx/`):**
- `package.json` — add `@fastify/multipart` dependency.
- `src/server.ts` — register the multipart plugin (before route registration).
- `src/routes/file-routes.ts` — add `writeUploadedFiles` helper, `POST /api/path/upload` (path-based, remote-side writer), and `POST /api/projects/:id/upload` (project-scoped, local write + remote proxy).

**Frontend (`apps/vibedeckx-ui/`):**
- `lib/api.ts` — add `UploadResponse` interface and `api.uploadFiles(...)`.
- `hooks/use-file-browser.ts` — add `refreshDirectory`, `uploadFiles`, and `uploadingDirs`.
- `components/files/file-tree.tsx` — drag-and-drop handlers + drag/upload visuals; thread new props through `FileTree` and `FileTreeNode`.
- `components/files/files-view.tsx` — pass `uploadFiles` and `uploadingDirs` from the hook into `FileTree`.

---

## Task 1: Add and register `@fastify/multipart`

**Files:**
- Modify: `packages/vibedeckx/package.json`
- Modify: `packages/vibedeckx/src/server.ts:225` (after `server.register(fastifyWebsocket);`)

- [ ] **Step 1: Install the dependency**

Run from the repo root:
```bash
pnpm --filter vibedeckx add @fastify/multipart@^9.0.0
```
Expected: `package.json` gains `"@fastify/multipart": "^9.x"` under `dependencies` and the lockfile updates.

- [ ] **Step 2: Import the plugin in server.ts**

In `packages/vibedeckx/src/server.ts`, add this import next to the other `@fastify/*` imports near the top of the file (e.g. just after the existing `import fastifyStatic from "@fastify/static";` / `import fastifyWebsocket from "@fastify/websocket";` lines):
```typescript
import fastifyMultipart from "@fastify/multipart";
```

- [ ] **Step 3: Register the plugin**

In `packages/vibedeckx/src/server.ts`, immediately after the line `server.register(fastifyWebsocket);` (around line 225), add:
```typescript
  // Multipart uploads (Files page drag-and-drop). 50MB per-file cap; the
  // remote-upload path is further bounded by the 16MB JSON bodyLimit.
  server.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 50 },
  });
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no errors). `@fastify/multipart` ships its own types and augments `FastifyRequest` with `files()`/`parts()`.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/package.json pnpm-lock.yaml packages/vibedeckx/src/server.ts
git commit -m "feat(files): register @fastify/multipart for uploads"
```

---

## Task 2: Backend — shared writer helper + path-based remote upload route

This task adds the file-writing helper (shared by both routes) and the path-based `POST /api/path/upload` that the remote proxy targets. The remote side receives files as base64 JSON (the existing proxy only forwards JSON), so this route is JSON, not multipart.

**Files:**
- Modify: `packages/vibedeckx/src/routes/file-routes.ts` (add helper near the other top-level helpers ~line 50–98; add route inside the `routes` plugin, e.g. after the path-based `/api/path/file-download` handler near line 204)

- [ ] **Step 1: Add the `writeUploadedFiles` helper**

In `packages/vibedeckx/src/routes/file-routes.ts`, add after the `isPathSafe` function (after line 50):
```typescript
const MAX_REMOTE_UPLOAD_BYTES = 12 * 1024 * 1024; // base64 of these fits under the 16MB JSON bodyLimit

/**
 * Writes uploaded files into `relativeDir` under `basePath`, overwriting any
 * existing file of the same name. Each filename is reduced to its basename and
 * re-checked against path traversal. Returns the list of filenames written.
 * Throws on traversal, a non-directory target, or a missing target dir.
 */
async function writeUploadedFiles(
  basePath: string,
  relativeDir: string,
  files: { name: string; data: Buffer }[],
): Promise<string[]> {
  if (!isPathSafe(basePath, relativeDir || ".")) {
    throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
  }
  const targetDir = relativeDir ? path.resolve(basePath, relativeDir) : basePath;

  const stat = await fs.stat(targetDir); // throws ENOENT/ENOTDIR — mapped by caller
  if (!stat.isDirectory()) {
    throw Object.assign(new Error("Target is not a directory"), { statusCode: 400 });
  }

  const written: string[] = [];
  for (const file of files) {
    const name = path.basename(file.name);
    if (!name || name === "." || name === "..") {
      throw Object.assign(new Error(`Invalid filename: ${file.name}`), { statusCode: 400 });
    }
    if (!isPathSafe(targetDir, name)) {
      throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
    }
    await fs.writeFile(path.join(targetDir, name), file.data); // overwrites
    written.push(name);
  }
  return written;
}
```

- [ ] **Step 2: Add the path-based upload route**

In the same file, inside the `routes` plugin, after the `/api/path/file-download` handler (near line 204, before the project-scoped `/api/projects/:id/browse` route), add:
```typescript
  // Upload files (path-based, for remote execution). Receives files as base64
  // JSON because the remote proxy only forwards JSON bodies.
  fastify.post<{
    Body: {
      path: string;
      branch?: string;
      relativePath?: string;
      files: { name: string; contentBase64: string }[];
    };
  }>("/api/path/upload", async (req, reply) => {
    const { path: projectPath, branch, relativePath, files } = req.body;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({ error: "No files provided" });
    }

    const basePath = resolveWorktreePath(projectPath, branch ?? null);
    const decoded = files.map((f) => ({ name: f.name, data: Buffer.from(f.contentBase64, "base64") }));

    try {
      const uploaded = await writeUploadedFiles(basePath, relativePath || "", decoded);
      return reply.code(200).send({ uploaded });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Target directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "path upload failed");
      return reply.code(500).send({ error: "Failed to write files", code });
    }
  });
```

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/file-routes.ts
git commit -m "feat(files): add path-based upload route and shared writer"
```

---

## Task 3: Backend — project-scoped upload route (local multipart + remote proxy)

**Files:**
- Modify: `packages/vibedeckx/src/routes/file-routes.ts` (add route after the project-scoped `/api/projects/:id/file-download` handler, near line 445, before `};` closing the plugin)

- [ ] **Step 1: Add the project-scoped upload route**

In `packages/vibedeckx/src/routes/file-routes.ts`, after the `/api/projects/:id/file-download` handler closes (line 445) and before the plugin's closing `};` (line 446), add:
```typescript
  // Upload files into a project directory (project-scoped). Local: multipart
  // write. Remote: read files into memory and forward as base64 JSON.
  fastify.post<{
    Params: { id: string };
    Querystring: { path?: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/upload", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const relativePath = req.query.path || "";
    const branch = req.query.branch;
    const target = req.query.target;
    const useRemote = target === "remote" || (!target && !project.path);

    // Collect uploaded file parts into buffers.
    const collected: { name: string; data: Buffer }[] = [];
    try {
      for await (const part of req.files()) {
        const data = await part.toBuffer();
        collected.push({ name: part.filename, data });
      }
    } catch (err) {
      // @fastify/multipart throws when fileSize limit is exceeded.
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "File too large" });
      }
      return reply.code(400).send({ error: "Failed to read upload" });
    }
    if (collected.length === 0) {
      return reply.code(400).send({ error: "No files provided" });
    }

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const totalBytes = collected.reduce((sum, f) => sum + f.data.length, 0);
      if (totalBytes > MAX_REMOTE_UPLOAD_BYTES) {
        return reply.code(413).send({
          error: `Upload too large for remote (max ${Math.floor(MAX_REMOTE_UPLOAD_BYTES / (1024 * 1024))}MB total)`,
        });
      }
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "POST",
        "/api/path/upload",
        {
          path: remoteConfig.remotePath,
          branch,
          relativePath,
          files: collected.map((f) => ({ name: f.name, contentBase64: f.data.toString("base64") })),
        },
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    try {
      const uploaded = await writeUploadedFiles(basePath, relativePath, collected);
      return reply.code(200).send({ uploaded });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "Target directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "project upload failed");
      return reply.code(500).send({ error: "Failed to write files", code });
    }
  });
```

- [ ] **Step 2: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS. (`req.files()` is provided by the `@fastify/multipart` type augmentation registered in Task 1.)

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/routes/file-routes.ts
git commit -m "feat(files): add project-scoped upload route (local + remote)"
```

---

## Task 4: Frontend — `api.uploadFiles`

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (add interface near the other file types; add method after `getFileDownloadUrl`, ~line 1188)

- [ ] **Step 1: Add the response interface**

In `apps/vibedeckx-ui/lib/api.ts`, near the existing `BrowseResponse` / `FileContentResponse` interfaces, add:
```typescript
export interface UploadResponse {
  uploaded: string[];
}
```

- [ ] **Step 2: Add the `uploadFiles` method**

In the `api` object, immediately after the `getFileDownloadUrl` method (after line 1188), add:
```typescript
  async uploadFiles(
    projectId: string,
    files: File[],
    targetPath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<UploadResponse> {
    const params = new URLSearchParams();
    if (targetPath) params.set("path", targetPath);
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);
    const query = params.toString() ? `?${params.toString()}` : "";

    const form = new FormData();
    for (const file of files) {
      form.append("file", file, file.name);
    }

    // Do NOT set Content-Type — the browser sets the multipart boundary.
    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/upload${query}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Upload failed");
    }
    return res.json();
  },
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(files): add uploadFiles API method"
```

---

## Task 5: Frontend — upload + refresh in `useFileBrowser`

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-file-browser.ts`

- [ ] **Step 1: Add upload state**

In `apps/vibedeckx-ui/hooks/use-file-browser.ts`, after the `loadingDirs` state declaration (line 22), add:
```typescript
  // Track which directories are currently receiving an upload ("" = root)
  const [uploadingDirs, setUploadingDirs] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Add `refreshDirectory` and `uploadFiles` callbacks**

In the same file, after the `selectFile` callback (after line 104), add:
```typescript
  // Re-fetch a single directory's listing without resetting tree state.
  // dirPath "" refreshes the root.
  const refreshDirectory = useCallback(async (dirPath: string) => {
    if (!projectId) return;
    if (dirPath === "") {
      const result = await api.browseProjectDirectory(projectId, undefined, branch, target);
      setRootEntries(result.items);
    } else {
      const result = await api.browseProjectDirectory(projectId, dirPath, branch, target);
      setDirectoryContents(prev => {
        const next = new Map(prev);
        next.set(dirPath, result.items);
        return next;
      });
    }
  }, [projectId, branch, target]);

  // Upload files into dirPath ("" = root), then refresh that directory.
  const uploadFiles = useCallback(async (dirPath: string, files: File[]) => {
    if (!projectId || files.length === 0) return;
    setUploadingDirs(prev => new Set(prev).add(dirPath));
    try {
      const { uploaded } = await api.uploadFiles(projectId, files, dirPath, branch, target);
      // Expand the folder so newly uploaded files are visible.
      if (dirPath !== "") {
        setExpandedDirs(prev => new Set(prev).add(dirPath));
      }
      await refreshDirectory(dirPath);
      toast.success(`Uploaded ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.error("Failed to upload files:", err);
      toast.error("Upload failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingDirs(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [projectId, branch, target, refreshDirectory]);
```

- [ ] **Step 3: Export the new values**

In the `return { ... }` block (lines 106–118), add `uploadingDirs`, `uploadFiles`, and `refreshDirectory` to the returned object:
```typescript
  return {
    rootEntries,
    directoryContents,
    expandedDirs,
    selectedFile,
    fileContent,
    fileLoading,
    rootLoading,
    loadingDirs,
    uploadingDirs,
    fetchRoot,
    toggleDirectory,
    selectFile,
    uploadFiles,
    refreshDirectory,
  };
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-file-browser.ts
git commit -m "feat(files): add upload + targeted refresh to useFileBrowser"
```

---

## Task 6: Frontend — drag-and-drop UI in the file tree

Adds native HTML5 drag-and-drop: a root drop zone on the tree container and per-folder drop targets, with highlight on the active target and a spinner while uploading. A single `dragOverPath` state (`null` = none, `""` = root, otherwise a folder path) is held in `FileTree` and threaded down. Folder rows call `stopPropagation` so the root handler doesn't override the folder target; the root container clears `dragOverPath` on a true leave (relatedTarget outside the container) and on drop.

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/file-tree.tsx`

- [ ] **Step 1: Add drag helpers and new props to `FileTree`**

In `apps/vibedeckx-ui/components/files/file-tree.tsx`, add `useState` is already imported (line 3). Add these module-level helpers after the `formatRelativeTime` function (after line 45):
```typescript
function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

function dragFiles(e: React.DragEvent): File[] {
  return Array.from(e.dataTransfer.files);
}
```

Update the `FileTreeProps` interface (lines 179–187) to add the upload props:
```typescript
interface FileTreeProps {
  entries: BrowseEntry[];
  expandedDirs: Set<string>;
  directoryContents: Map<string, BrowseEntry[]>;
  loadingDirs: Set<string>;
  selectedFile: string | null;
  uploadingDirs: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
}
```

- [ ] **Step 2: Rewrite the `FileTree` component body with the root drop zone**

Replace the entire `FileTree` function (lines 189–227) with:
```typescript
export function FileTree({
  entries,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  uploadingDirs,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
}: FileTreeProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const isRootDragOver = dragOverPath === "";
  const isRootUploading = uploadingDirs.has("");

  return (
    <div
      className={cn(
        "py-1 min-h-full transition-colors",
        isRootDragOver && "bg-accent/30 outline-2 -outline-offset-2 outline-dashed outline-primary/50",
      )}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDragOverPath("");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverPath(null);
        }
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDragOverPath(null);
        const files = dragFiles(e);
        if (files.length) onUploadFiles("", files);
      }}
    >
      {isRootUploading && (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Uploading…
        </div>
      )}
      {entries.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          {isRootDragOver ? "Drop files to upload" : "No files found. Drop files here to upload."}
        </div>
      ) : (
        entries.map(entry => {
          const entryPath = entry.name;
          return (
            <FileTreeNode
              key={entryPath}
              entry={entry}
              path={entryPath}
              depth={0}
              expandedDirs={expandedDirs}
              directoryContents={directoryContents}
              loadingDirs={loadingDirs}
              selectedFile={selectedFile}
              uploadingDirs={uploadingDirs}
              dragOverPath={dragOverPath}
              onToggleDirectory={onToggleDirectory}
              onSelectFile={onSelectFile}
              onUploadFiles={onUploadFiles}
              onSetDragOverPath={setDragOverPath}
            />
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the new props to `FileTreeNodeProps`**

Update the `FileTreeNodeProps` interface (lines 72–82) to:
```typescript
interface FileTreeNodeProps {
  entry: BrowseEntry;
  path: string;
  depth: number;
  expandedDirs: Set<string>;
  directoryContents: Map<string, BrowseEntry[]>;
  loadingDirs: Set<string>;
  selectedFile: string | null;
  uploadingDirs: Set<string>;
  dragOverPath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
  onSetDragOverPath: (path: string | null) => void;
}
```

- [ ] **Step 4: Wire drag-and-drop into the directory branch of `FileTreeNode`**

Update the `FileTreeNode` function signature (lines 84–94) to destructure the new props:
```typescript
function FileTreeNode({
  entry,
  path: nodePath,
  depth,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  uploadingDirs,
  dragOverPath,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
  onSetDragOverPath,
}: FileTreeNodeProps) {
```

In the directory branch, replace the folder row `<div>` (lines 105–122) with a version that has drag handlers, a drag-over highlight, and an upload spinner:
```typescript
    const isDragOver = dragOverPath === nodePath;
    const isUploading = uploadingDirs.has(nodePath);

    return (
      <div>
        <div
          className={cn(
            "group flex items-center w-full px-2 py-1 text-sm rounded-sm transition-colors cursor-pointer",
            isDragOver ? "bg-primary/15 outline-2 -outline-offset-2 outline-dashed outline-primary/60" : "hover:bg-accent",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => onToggleDirectory(nodePath)}
          onDragOver={(e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            onSetDragOverPath(nodePath);
          }}
          onDrop={(e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            onSetDragOverPath(null);
            const files = dragFiles(e);
            if (files.length) onUploadFiles(nodePath, files);
          }}
        >
          <div className="flex items-center gap-1 min-w-0 flex-1">
            {isUploading || isLoading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <FolderIcon className="h-4 w-4 shrink-0 text-blue-500" />
            <span className="truncate">{entry.name}</span>
          </div>
          <div className="shrink-0 hidden group-hover:block ml-1">
            <CopyPathButton path={nodePath} />
          </div>
        </div>
```

(The `isExpanded && children` block that follows stays as-is, except for the recursive `<FileTreeNode>` call updated in the next step.)

- [ ] **Step 5: Pass the new props through the recursive call**

In the children-rendering block of the directory branch, update the recursive `<FileTreeNode>` (lines 128–139) to forward the new props:
```typescript
                <FileTreeNode
                  key={childPath}
                  entry={child}
                  path={childPath}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  directoryContents={directoryContents}
                  loadingDirs={loadingDirs}
                  selectedFile={selectedFile}
                  uploadingDirs={uploadingDirs}
                  dragOverPath={dragOverPath}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                  onUploadFiles={onUploadFiles}
                  onSetDragOverPath={onSetDragOverPath}
                />
```

(The file branch of `FileTreeNode` — lines 148–176 — needs no changes. Files are not drop targets; a drop on a file row bubbles to the nearest folder/root handler.)

- [ ] **Step 6: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/files/file-tree.tsx
git commit -m "feat(files): drag-and-drop upload targets in file tree"
```

---

## Task 7: Frontend — wire the hook into `FilesView`

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx`

- [ ] **Step 1: Destructure the new hook values**

In `apps/vibedeckx-ui/components/files/files-view.tsx`, add `uploadingDirs` and `uploadFiles` to the `useFileBrowser` destructuring (lines 24–40):
```typescript
  const {
    rootEntries,
    directoryContents,
    expandedDirs,
    selectedFile,
    fileContent,
    fileLoading,
    rootLoading,
    loadingDirs,
    uploadingDirs,
    fetchRoot,
    toggleDirectory,
    selectFile,
    uploadFiles,
  } = useFileBrowser({
    projectId,
    branch: selectedBranch,
    target,
  });
```

- [ ] **Step 2: Pass them into `FileTree`**

Update the `<FileTree>` element (lines 84–92) to pass the new props:
```typescript
              <FileTree
                entries={rootEntries}
                expandedDirs={expandedDirs}
                directoryContents={directoryContents}
                loadingDirs={loadingDirs}
                selectedFile={selectedFile}
                uploadingDirs={uploadingDirs}
                onToggleDirectory={toggleDirectory}
                onSelectFile={selectFile}
                onUploadFiles={uploadFiles}
              />
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Lint the frontend**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: PASS (no new errors in the touched files).

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/files/files-view.tsx
git commit -m "feat(files): pass upload handlers into FilesView"
```

---

## Task 8: End-to-end manual verification

No automated tests exist; verify the feature by running the app.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev servers**

Run: `pnpm dev:all`
Expected: backend on 5173, frontend on 3000.

- [ ] **Step 2: Verify root upload (local project)**

Open `http://localhost:3000`, select a **local** project, open the Files page. Drag one file from your OS onto the tree's root area. Expected: the root area highlights while dragging; on drop a success toast appears and the file shows up at the workspace root.

- [ ] **Step 3: Verify folder upload**

Drag two files onto a folder row. Expected: the folder highlights on hover; on drop the folder shows a spinner, then expands and lists both new files; success toast shows "Uploaded 2 files".

- [ ] **Step 4: Verify overwrite**

Drag a file whose name matches an existing file in the target directory. Expected: no prompt; the file is replaced. Click it in the preview pane and confirm the content reflects the newly uploaded file.

- [ ] **Step 5: Verify drop onto a collapsed folder**

Collapse a folder, then drop a file onto it. Expected: it uploads and the folder auto-expands to reveal the file.

- [ ] **Step 6: Verify remote project (if one is configured)**

Select a **remote** project, open the Files page, and repeat Steps 2–3. Expected: same behavior; files land in the remote workspace and appear after refresh. (If no remote project is available, note this step as skipped.)

- [ ] **Step 7: Verify rejection of oversized remote upload (if remote available)**

Drag a file larger than 12MB onto a remote project. Expected: an error toast ("Upload too large for remote …"); no file written.

- [ ] **Step 8: Final confirmation**

Confirm there are no console errors in the browser or backend logs during the above. Report which steps passed and any that were skipped (e.g. no remote project).
```
