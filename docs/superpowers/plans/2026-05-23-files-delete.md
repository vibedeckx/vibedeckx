# Files Page Delete (Files & Folders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users delete a file or folder from the Files page — a trash button appears on row hover, clicking it confirms via `window.confirm`, then the entry is deleted (recursively for folders) and removed from the tree — for both local and remote projects.

**Architecture:** Mirrors the existing upload feature. Backend adds a shared `deletePath` helper, a path-based `DELETE /api/path/delete` (the remote-proxy target), and a project-scoped `DELETE /api/projects/:id/file` that deletes locally or proxies to the remote via `proxyToRemoteAuto`. Frontend adds `api.deleteFile`, a `deleteEntry` action + `deletingPaths` state in `useFileBrowser`, and a `DeleteButton` in the file tree.

**Tech Stack:** Fastify 5 (backend, ESM/NodeNext — local imports need `.js`), Next.js 16 / React 19 + Tailwind v4 + lucide icons + sonner toasts (frontend).

**Note on testing:** This repo has **no test framework** (see CLAUDE.md). Each backend task is verified with the backend type-check; each frontend task with the frontend type-check; the feature is verified end-to-end manually in the final task. There are no automated test steps because there is no runner — do not scaffold one.

**Type-check commands (used throughout):**
- Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`
  - The frontend has TWO known pre-existing errors unrelated to this work — treat "only these two" as passing:
    - `components/settings/appearance-settings.tsx` (TS7006 implicit any)
    - `components/ui/slider.tsx` (TS2307 missing `@radix-ui/react-slider`)

---

## File Structure

**Backend:**
- Modify: `packages/vibedeckx/src/routes/file-routes.ts` — add `deletePath` helper + two DELETE routes.

**Frontend:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` — add `api.deleteFile`.
- Modify: `apps/vibedeckx-ui/hooks/use-file-browser.ts` — add `deletingPaths` + `deleteEntry`.
- Modify: `apps/vibedeckx-ui/components/files/file-tree.tsx` — add `DeleteButton`, thread props.
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx` — wire the hook into `FileTree`.

---

## Task 1: Backend — `deletePath` helper + path-based delete route

**Files:**
- Modify: `packages/vibedeckx/src/routes/file-routes.ts`

- [ ] **Step 1: Add the `deletePath` helper**

Add it immediately after the `writeUploadedFiles` function closes (after its `return written;` / closing `}`, around line 90), before `async function isBinaryFile`:

```typescript
/**
 * Deletes the file or directory at `relativePath` under `basePath`. Directories
 * are removed recursively. Returns the deleted relative path. Throws on
 * traversal, an attempt to delete the root, or a missing entry (ENOENT).
 */
async function deletePath(basePath: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath === ".") {
    throw Object.assign(new Error("Cannot delete the workspace root"), { statusCode: 400 });
  }
  if (!isPathSafe(basePath, relativePath)) {
    throw Object.assign(new Error("Path traversal not allowed"), { statusCode: 403 });
  }
  const fullPath = path.resolve(basePath, relativePath);
  await fs.rm(fullPath, { recursive: true, force: false }); // throws ENOENT if missing
  return relativePath;
}
```

- [ ] **Step 2: Add the path-based delete route**

Add it immediately after the `/api/path/upload` route closes (after its closing `});`, around line 283), before the `// Browse project directory (project-scoped)` comment:

```typescript
  // Delete a file or directory (path-based, for remote execution).
  fastify.delete<{
    Querystring: { path: string; filePath: string; branch?: string };
  }>("/api/path/delete", async (req, reply) => {
    const projectPath = req.query.path;
    const filePath = req.query.filePath;
    if (!projectPath || !filePath) {
      return reply.code(400).send({ error: "Path and filePath are required" });
    }

    const branch = req.query.branch;
    const basePath = resolveWorktreePath(projectPath, branch ?? null);

    try {
      const deleted = await deletePath(basePath, filePath);
      return reply.code(200).send({ deleted });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "File or directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "path delete failed");
      return reply.code(500).send({ error: "Failed to delete", code });
    }
  });
```

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no output). Note: `deletePath` is referenced by the new route here and again in Task 2 — no "unused" error.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/file-routes.ts
git commit -m "feat(files): add deletePath helper and path-based delete route"
```

---

## Task 2: Backend — project-scoped delete route (local + remote proxy)

**Files:**
- Modify: `packages/vibedeckx/src/routes/file-routes.ts`

- [ ] **Step 1: Add the project-scoped delete route**

Add it as the LAST route in the `routes` plugin — immediately after the `/api/projects/:id/upload` route closes (after its closing `});`, around line 612) and BEFORE the plugin's closing `};`:

```typescript
  // Delete a file or directory in a project (project-scoped). Local: fs.rm.
  // Remote: proxy to the path-based delete route.
  fastify.delete<{
    Params: { id: string };
    Querystring: { path: string; branch?: string; target?: "local" | "remote" };
  }>("/api/projects/:id/file", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    const branch = req.query.branch;
    const target = req.query.target;
    const useRemote = target === "remote" || (!target && !project.path);

    if (useRemote) {
      const remoteConfig = getRemoteConfig(fastify, project);
      if (!remoteConfig) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      const params = [
        `path=${encodeURIComponent(remoteConfig.remotePath)}`,
        `filePath=${encodeURIComponent(filePath)}`,
      ];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        remoteConfig.url,
        remoteConfig.apiKey,
        "DELETE",
        `/api/path/delete?${params.join("&")}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    const basePath = resolveWorktreePath(project.path, branch ?? null);
    try {
      const deleted = await deletePath(basePath, filePath);
      return reply.code(200).send({ deleted });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (status) return reply.code(status).send({ error: (err as Error).message });
      if (code === "ENOENT" || code === "ENOTDIR") {
        return reply.code(404).send({ error: "File or directory not found", code });
      }
      if (code === "EACCES" || code === "EPERM") {
        return reply.code(403).send({ error: "Permission denied", code });
      }
      fastify.log.warn({ err }, "project delete failed");
      return reply.code(500).send({ error: "Failed to delete", code });
    }
  });
```

- [ ] **Step 2: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS. (`proxyToRemoteAuto`, `proxyStatus`, `getRemoteConfig`, `resolveWorktreePath`, `requireAuth` are all already imported/defined in this file.)

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/routes/file-routes.ts
git commit -m "feat(files): add project-scoped delete route (local + remote)"
```

---

## Task 3: Frontend — `api.deleteFile`

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`

- [ ] **Step 1: Add the `deleteFile` method**

In the `api` object, immediately after the `uploadFiles` method closes (after its closing `},`, just before the `// Terminal API` comment, around line 1223), add:

```typescript
  async deleteFile(
    projectId: string,
    filePath: string,
    branch?: string | null,
    target?: "local" | "remote"
  ): Promise<{ deleted: string }> {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set("branch", branch);
    if (target) params.set("target", target);

    const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/file?${params.toString()}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || "Delete failed");
    }
    return res.json();
  },
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: ONLY the two known pre-existing errors (`appearance-settings.tsx`, `slider.tsx`). No new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(files): add deleteFile API method"
```

---

## Task 4: Frontend — `deleteEntry` + `deletingPaths` in `useFileBrowser`

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-file-browser.ts`

- [ ] **Step 1: Add `deletingPaths` state**

After the `uploadingDirs` state declaration (line 24, `const [uploadingDirs, setUploadingDirs] = useState<Set<string>>(new Set());`), add:

```typescript
  // Track which entry paths are currently being deleted
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Add the `deleteEntry` callback**

After the `uploadFiles` callback closes (after its closing `}, [projectId, branch, target, refreshDirectory]);`, around line 149), and before the `return {` block, add:

```typescript
  // Delete a file or directory, then refresh its parent and clear the preview
  // if the deleted entry (or something inside it) was selected.
  const deleteEntry = useCallback(async (entryPath: string) => {
    if (!projectId || !entryPath) return;
    setDeletingPaths(prev => new Set(prev).add(entryPath));
    try {
      await api.deleteFile(projectId, entryPath, branch, target);
      setSelectedFile(prev => {
        if (prev === entryPath || (prev && prev.startsWith(`${entryPath}/`))) {
          setFileContent(null);
          return null;
        }
        return prev;
      });
      const parent = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
      await refreshDirectory(parent);
      toast.success("Deleted");
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingPaths(prev => {
        const next = new Set(prev);
        next.delete(entryPath);
        return next;
      });
    }
  }, [projectId, branch, target, refreshDirectory]);
```

- [ ] **Step 3: Return the new values**

Update the `return { ... }` block to add `deletingPaths` and `deleteEntry`. The full block becomes:

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
    deletingPaths,
    fetchRoot,
    toggleDirectory,
    selectFile,
    uploadFiles,
    refreshDirectory,
    deleteEntry,
  };
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: ONLY the two known pre-existing errors. No new errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-file-browser.ts
git commit -m "feat(files): add deleteEntry + deletingPaths to useFileBrowser"
```

---

## Task 5: Frontend — delete button in the file tree

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/file-tree.tsx`

- [ ] **Step 1: Add `Trash2` to the lucide import**

Change the import line (line 4) from:

```typescript
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileCode, FileText, Loader2, Copy, Check } from "lucide-react";
```
to:
```typescript
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileCode, FileText, Loader2, Copy, Check, Trash2 } from "lucide-react";
```

- [ ] **Step 2: Add the `DeleteButton` component**

Add it immediately after the `CopyPathButton` component closes (after its closing `}`, around line 91), before `interface FileTreeNodeProps`:

```typescript
function DeleteButton({
  entryPath,
  type,
  deleting,
  onDeleteEntry,
}: {
  entryPath: string;
  type: "file" | "directory";
  deleting: boolean;
  onDeleteEntry: (entryPath: string, type: "file" | "directory") => void;
}) {
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const name = entryPath.includes("/") ? entryPath.slice(entryPath.lastIndexOf("/") + 1) : entryPath;
    const message = type === "directory"
      ? `Delete "${name}" and all its contents? This can't be undone.`
      : `Delete "${name}"? This can't be undone.`;
    if (!window.confirm(message)) return;
    onDeleteEntry(entryPath, type);
  }, [entryPath, type, onDeleteEntry]);

  if (deleting) {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }

  return (
    <button
      onClick={handleDelete}
      className="p-0.5 rounded hover:bg-destructive/20 transition-colors"
      title={`Delete ${entryPath}`}
      aria-label={`Delete ${entryPath}`}
    >
      <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
    </button>
  );
}
```

- [ ] **Step 3: Add the two new props to `FileTreeNodeProps`**

Update `interface FileTreeNodeProps` to add `deletingPaths` and `onDeleteEntry`. The full interface becomes:

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
  deletingPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
  onSetDragOverPath: (path: string | null) => void;
  onDeleteEntry: (entryPath: string, type: "file" | "directory") => void;
}
```

- [ ] **Step 4: Destructure the new props in `FileTreeNode`**

Update the `FileTreeNode` parameter destructuring to add `deletingPaths` and `onDeleteEntry`. The full destructuring becomes:

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
  deletingPaths,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
  onSetDragOverPath,
  onDeleteEntry,
}: FileTreeNodeProps) {
```

- [ ] **Step 5: Add `isDeleting` in the directory branch and render the delete button**

Inside `if (entry.type === "directory") {`, after the line `const isUploading = uploadingDirs.has(nodePath);`, add:

```typescript
    const isDeleting = deletingPaths.has(nodePath);
```

Then replace the folder row's action slot — currently:

```typescript
          <div className="shrink-0 hidden group-hover:block ml-1">
            <CopyPathButton path={nodePath} />
          </div>
```
with:
```typescript
          <div className={cn("shrink-0 ml-1 items-center gap-1", isDeleting ? "flex" : "hidden group-hover:flex")}>
            <CopyPathButton path={nodePath} />
            <DeleteButton entryPath={nodePath} type="directory" deleting={isDeleting} onDeleteEntry={onDeleteEntry} />
          </div>
```

- [ ] **Step 6: Pass the new props in the recursive `FileTreeNode` call**

In the children `.map(...)`, update the recursive `<FileTreeNode ... />` to add the two props. The full element becomes:

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
                  deletingPaths={deletingPaths}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                  onUploadFiles={onUploadFiles}
                  onSetDragOverPath={onSetDragOverPath}
                  onDeleteEntry={onDeleteEntry}
                />
```

- [ ] **Step 7: Add `isDeleting` in the file branch and render the delete button**

In the file branch (after the directory `if` block returns), after the line `const parentPath = nodePath.includes("/") ? nodePath.slice(0, nodePath.lastIndexOf("/")) : "";`, add:

```typescript
  const isDeleting = deletingPaths.has(nodePath);
```

Then replace the file row's action slot — currently:

```typescript
      <div className="shrink-0 flex items-center gap-2 ml-1">
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.mtime && formatRelativeTime(entry.mtime)}
        </span>
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.size != null && formatFileSize(entry.size)}
        </span>
        <div className="hidden group-hover:block">
          <CopyPathButton path={nodePath} />
        </div>
      </div>
```
with:
```typescript
      <div className="shrink-0 flex items-center gap-2 ml-1">
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.mtime && formatRelativeTime(entry.mtime)}
        </span>
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.size != null && formatFileSize(entry.size)}
        </span>
        <div className={cn("items-center gap-1", isDeleting ? "flex" : "hidden group-hover:flex")}>
          <CopyPathButton path={nodePath} />
          <DeleteButton entryPath={nodePath} type="file" deleting={isDeleting} onDeleteEntry={onDeleteEntry} />
        </div>
      </div>
```

- [ ] **Step 8: Add the two props to `FileTreeProps`**

Update `interface FileTreeProps` to add `deletingPaths` and `onDeleteEntry`. The full interface becomes:

```typescript
interface FileTreeProps {
  entries: BrowseEntry[];
  expandedDirs: Set<string>;
  directoryContents: Map<string, BrowseEntry[]>;
  loadingDirs: Set<string>;
  selectedFile: string | null;
  uploadingDirs: Set<string>;
  rootLoading: boolean;
  deletingPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
  onDeleteEntry: (entryPath: string, type: "file" | "directory") => void;
}
```

- [ ] **Step 9: Destructure the new props in `FileTree` and pass them to the top-level `FileTreeNode`**

Update the `FileTree` function destructuring to add `deletingPaths` and `onDeleteEntry`:

```typescript
export function FileTree({
  entries,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  uploadingDirs,
  rootLoading,
  deletingPaths,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
  onDeleteEntry,
}: FileTreeProps) {
```

Then in the top-level `entries.map(...)`, update the `<FileTreeNode ... />` to pass the two props. The full element becomes:

```typescript
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
                deletingPaths={deletingPaths}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                onUploadFiles={onUploadFiles}
                onSetDragOverPath={setDragOverPath}
                onDeleteEntry={onDeleteEntry}
              />
```

- [ ] **Step 10: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: `files-view.tsx` will now report missing `deletingPaths`/`onDeleteEntry` props on `<FileTree>` (resolved in Task 6). Otherwise ONLY the two known pre-existing errors and that expected `files-view.tsx` error. No errors inside `file-tree.tsx` itself.

- [ ] **Step 11: Commit**

```bash
git add apps/vibedeckx-ui/components/files/file-tree.tsx
git commit -m "feat(files): add hover delete button to file tree rows"
```

---

## Task 6: Frontend — wire the hook into `FilesView`

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx`

- [ ] **Step 1: Destructure the new hook values**

Add `deletingPaths` and `deleteEntry` to the `useFileBrowser` destructuring. The full destructuring becomes:

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
    deletingPaths,
    fetchRoot,
    toggleDirectory,
    selectFile,
    uploadFiles,
    deleteEntry,
  } = useFileBrowser({
    projectId,
    branch: selectedBranch,
    target,
  });
```

- [ ] **Step 2: Pass the new props into `FileTree`**

Update the `<FileTree>` element to add `deletingPaths` and `onDeleteEntry`. The full element becomes:

```typescript
          <FileTree
            entries={rootEntries}
            expandedDirs={expandedDirs}
            directoryContents={directoryContents}
            loadingDirs={loadingDirs}
            selectedFile={selectedFile}
            uploadingDirs={uploadingDirs}
            rootLoading={rootLoading}
            deletingPaths={deletingPaths}
            onToggleDirectory={toggleDirectory}
            onSelectFile={selectFile}
            onUploadFiles={uploadFiles}
            onDeleteEntry={deleteEntry}
          />
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: ONLY the two known pre-existing errors. The previous `files-view.tsx` "missing props on FileTree" error is gone, and no new errors.

- [ ] **Step 4: Lint the frontend**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new lint errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/files/files-view.tsx
git commit -m "feat(files): wire delete handler into FilesView"
```

---

## Task 7: End-to-end manual verification

**Files:** none (manual).

This task cannot be automated (no test runner; requires interactive UI). The implementer should report it as REQUIRING USER VERIFICATION rather than marking it passed.

- [ ] **Step 1: Build the backend and confirm both routes are bundled**

Run from repo root:
```bash
pnpm build:main && grep -o '/api/projects/:id/file"' packages/vibedeckx/dist/bin.js | head -1 && grep -o '/api/path/delete' packages/vibedeckx/dist/bin.js | head -1
```
Expected: both strings print. (Reminder from prior session: the dev server does not hot-reload backend code — a running `:5173` server must be restarted from this branch's build for the new routes to exist.)

- [ ] **Step 2: Manual checks (user-driven)**

Run `pnpm dev:all`, open the Files page on a local project, and verify:
- Hover a file row → trash icon appears on the right next to the copy button.
- Click it → `window.confirm` shows the file message → confirm → row disappears, toast "Deleted"; if that file was open in the preview, the preview clears.
- Hover a folder row → trash icon appears → confirm shows the "and all its contents" message → confirm → folder and its contents disappear.
- Cancelling the confirm leaves everything unchanged.
- (If a remote project is available) repeat on a remote project and confirm deletes work.
- Confirm there is no way to delete the workspace root itself (no trash button on the root area; the backend rejects empty path).

---

## Self-Review Notes

- **Spec coverage:** trash on hover (Task 5), confirm via `window.confirm` with file/folder wording (Task 5 Step 2), recursive folder delete (`fs.rm recursive`, Task 1), local+remote (Tasks 1+2), root guard (Task 1 `deletePath`), preview-clear + parent refresh + deleting spinner (Task 4 + Task 5), API method (Task 3), wiring (Task 6), manual E2E (Task 7). All covered.
- **Type consistency:** `deletePath(basePath, relativePath)`, `api.deleteFile(projectId, filePath, branch?, target?)`, hook `deleteEntry(entryPath)` + `deletingPaths`, component prop `onDeleteEntry(entryPath, type)` + `deletingPaths` — names consistent across tasks. `deleteEntry` ignores the `type` arg the button passes (harmless; the button's signature carries `type` for the confirm wording).
- **No placeholders.**
