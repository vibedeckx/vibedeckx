# Create Folder in Remote Directory Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create a new folder directly in the remote directory browser when picking a project directory.

**Architecture:** A new `mkdir` request flow mirrors the existing `browse` flow at every layer (UI → API client → orchestrator route → reverse-connect proxy → remote server route → `fs.mkdir`). The UI change lives entirely in the shared `RemoteDirectoryBrowser` component, so it appears in both the Create New Project dialog and Project Settings. Interaction is type-then-create: an inline editable row appears, and the folder is created only on confirm.

**Tech Stack:** Fastify (backend ESM, NodeNext — local imports need `.js` extensions), Next.js 16 / React 19 (frontend), Tailwind v4, shadcn/ui, Lucide icons. No automated test framework — verification is type-checks plus manual browser testing.

**Spec:** `docs/superpowers/specs/2026-05-26-remote-create-folder-design.md`

**Type-check commands:**
- Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`

**Note on commits:** This project's convention is to commit only when the user explicitly asks. The "Commit" steps below are written for completeness; if the user has not authorized commits, skip them and leave changes staged/unstaged for review instead.

---

## File Structure

- **Modify** `packages/vibedeckx/src/routes/project-routes.ts` — add `POST /api/mkdir` route on the remote server (creates the directory via `fs.mkdir`). Sits next to the existing `GET /api/browse` route.
- **Modify** `packages/vibedeckx/src/server.ts` — add `/api/mkdir` to `REMOTE_PROVIDER_EXACT` so it is reachable through the reverse-connect tunnel.
- **Modify** `packages/vibedeckx/src/routes/remote-server-routes.ts` — add `POST /api/remote-servers/:id/mkdir` orchestrator route that proxies to the remote `/api/mkdir`. Sits next to the existing `/browse` proxy route.
- **Modify** `apps/vibedeckx-ui/lib/api.ts` — add `createRemoteServerDirectory()` method on the `api` object, next to `browseRemoteServerDirectory()`.
- **Modify** `apps/vibedeckx-ui/components/project/remote-directory-browser.tsx` — add the new-folder icon button and the inline create row.

---

## Task 1: Remote server `POST /api/mkdir` route

**Files:**
- Modify: `packages/vibedeckx/src/routes/project-routes.ts` (add route after the `/api/browse` route, which currently ends around line 69)

- [ ] **Step 1: Add the `/api/mkdir` route**

Insert the following immediately after the closing `});` of the existing `/api/browse` route (around line 69). The existing route already imports `readdir` from `node:fs/promises` and `path`; add `mkdir` to the `fs/promises` import if it is not already imported (check the top of the file — if it imports `{ readdir }`, change to `{ readdir, mkdir }`).

```ts
  // Create a directory (used by the remote directory browser's "new folder")
  fastify.post<{
    Body: { parentPath?: string; name?: string };
  }>("/api/mkdir", async (req, reply) => {
    const parentPath = req.body?.parentPath;
    const rawName = req.body?.name;

    if (!parentPath || !rawName) {
      return reply.code(400).send({ error: "parentPath and name are required" });
    }

    // Reduce to a single path segment and reject traversal / separators.
    const name = path.basename(rawName.trim());
    if (!name || name === "." || name === ".." || name !== rawName.trim()) {
      return reply.code(400).send({ error: "Invalid folder name" });
    }

    const fullPath = path.join(parentPath, name);

    try {
      await mkdir(fullPath); // non-recursive: duplicate name throws EEXIST
      return reply.code(201).send({ path: fullPath, name, type: "directory" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        return reply.code(409).send({ error: "A folder with that name already exists" });
      }
      return reply.code(400).send({ error: "Failed to create directory" });
    }
  });
```

- [ ] **Step 2: Verify the import**

Open the top of `packages/vibedeckx/src/routes/project-routes.ts` and confirm `mkdir` is imported from `node:fs/promises` (alongside `readdir`). If the file imports the whole module (e.g. `import fs from "node:fs/promises"`), call `fs.mkdir(...)` instead of `mkdir(...)` in the code above to match the existing style.

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit** (only if commits are authorized — see note in header)

```bash
git add packages/vibedeckx/src/routes/project-routes.ts
git commit -m "feat(backend): add /api/mkdir route to remote server"
```

---

## Task 2: Allow `/api/mkdir` through the reverse-connect tunnel

**Files:**
- Modify: `packages/vibedeckx/src/server.ts:71`

- [ ] **Step 1: Add `/api/mkdir` to `REMOTE_PROVIDER_EXACT`**

The current line 71 is:

```ts
const REMOTE_PROVIDER_EXACT = new Set(["/api/browse", "/api/execute-one-shot"]);
```

Change it to:

```ts
const REMOTE_PROVIDER_EXACT = new Set(["/api/browse", "/api/mkdir", "/api/execute-one-shot"]);
```

- [ ] **Step 2: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit** (only if commits are authorized)

```bash
git add packages/vibedeckx/src/server.ts
git commit -m "feat(backend): route /api/mkdir through reverse-connect tunnel"
```

---

## Task 3: Orchestrator `POST /api/remote-servers/:id/mkdir` proxy route

**Files:**
- Modify: `packages/vibedeckx/src/routes/remote-server-routes.ts` (add route after the `/api/remote-servers/:id/browse` route, which ends around line 181)

- [ ] **Step 1: Add the proxy route**

Insert immediately after the closing `);` of the existing `/api/remote-servers/:id/browse` route (around line 181):

```ts
  // POST /api/remote-servers/:id/mkdir — create a directory on the remote server
  fastify.post<{ Params: { id: string } }>(
    "/api/remote-servers/:id/mkdir",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { parentPath, name } =
        (request.body as { parentPath?: string; name?: string }) ?? {};
      const server = fastify.storage.remoteServers.getById(id, userId);
      if (!server) return reply.code(404).send({ error: "Server not found" });

      try {
        const result = await proxyToRemoteAuto(
          id,
          server.url ?? "",
          server.api_key ?? "",
          "POST",
          "/api/mkdir",
          { parentPath, name },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        return reply.code(proxyStatus(result)).send(result.data);
      } catch (err) {
        return reply.code(502).send({ error: "Failed to create remote directory" });
      }
    }
  );
```

- [ ] **Step 2: Verify imports**

Confirm `proxyToRemoteAuto`, `proxyStatus`, and `requireAuth` are already imported in this file (the existing `/browse` route uses `proxyToRemoteAuto` and `requireAuth`). Add `proxyStatus` to the import from `../utils/remote-proxy.js` if it is not already present.

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit** (only if commits are authorized)

```bash
git add packages/vibedeckx/src/routes/remote-server-routes.ts
git commit -m "feat(backend): add remote-servers/:id/mkdir proxy route"
```

---

## Task 4: API client `createRemoteServerDirectory`

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (add method after `browseRemoteServerDirectory`, which ends around line 936)

- [ ] **Step 1: Add the method**

Insert immediately after the `browseRemoteServerDirectory` method (after its closing `},` around line 936):

```ts
  async createRemoteServerDirectory(
    serverId: string,
    parentPath: string,
    name: string
  ): Promise<RemoteBrowseItem> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${serverId}/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentPath, name }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "Failed to create directory");
    }
    return res.json();
  },
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors. (`RemoteBrowseItem` is already exported from this file, so no new import is needed.)

- [ ] **Step 3: Commit** (only if commits are authorized)

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(ui): add createRemoteServerDirectory api client method"
```

---

## Task 5: New-folder UI in `RemoteDirectoryBrowser`

**Files:**
- Modify: `apps/vibedeckx-ui/components/project/remote-directory-browser.tsx`

- [ ] **Step 1: Update imports**

Change the React import (line 3) to include `useRef`:

```ts
import { useState, useEffect, useRef } from "react";
```

Change the lucide-react import (line 6) to add `FolderPlus`:

```ts
import { Folder, FolderPlus, ChevronRight, ChevronUp, Loader2 } from "lucide-react";
```

- [ ] **Step 2: Refactor the directory fetch into a reusable function and add create state**

Replace the existing state declarations and `useEffect` (lines 20–46) with the following. This hoists the fetch into a `refresh` callback so the create handler can re-fetch after a successful mkdir, and adds state for the inline create row.

```ts
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<RemoteBrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    if (!serverId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.browseRemoteServerDirectory(serverId, currentPath);
      setItems(result.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load directory");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Cancel any in-progress create when the directory changes.
    setCreating(false);
    setNewName("");
    setCreateError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, currentPath]);

  // Focus + select the input when the create row appears.
  useEffect(() => {
    if (creating) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [creating]);
```

- [ ] **Step 3: Add the create handlers**

Insert these handlers after the existing `handleSelect` function (around line 59):

```ts
  const startCreate = () => {
    setCreateError("");
    setNewName("New Folder");
    setCreating(true);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError("");
  };

  const commitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const item = await api.createRemoteServerDirectory(serverId, currentPath, name);
      setCreating(false);
      setNewName("");
      await refresh();
      onSelect(item.path);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create folder");
    } finally {
      setCreateBusy(false);
    }
  };
```

- [ ] **Step 4: Add the new-folder button to the header row**

The header row currently is (lines 71–81):

```tsx
      <div className="flex items-center gap-2 p-2 border-b bg-muted/50">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGoUp}
          disabled={currentPath === "/" || loading}
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <span className="text-sm font-mono truncate flex-1">{currentPath}</span>
      </div>
```

Add a `FolderPlus` button after the path span, before the closing `</div>`:

```tsx
      <div className="flex items-center gap-2 p-2 border-b bg-muted/50">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGoUp}
          disabled={currentPath === "/" || loading}
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <span className="text-sm font-mono truncate flex-1">{currentPath}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={startCreate}
          disabled={loading || creating}
          title="New folder"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>
```

- [ ] **Step 5: Render the inline create row**

The body currently chooses between loading / error / empty / list states (lines 83–122). The empty-state branch (`items.length === 0`) hides the list, which would hide the create row while creating in an empty directory. Restructure so the create row always renders above the list.

Replace the loading/error/empty/list block (lines 83–122) with:

```tsx
      {loading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="p-4 text-sm text-red-500">{error}</div>
      ) : (
        <ScrollArea className="h-[200px]">
          <div className="p-1">
            {creating && (
              <div className="flex flex-col gap-1 p-2">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    ref={inputRef}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitCreate();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelCreate();
                      }
                    }}
                    onBlur={() => {
                      // Blur confirms, unless a request is already running.
                      if (!createBusy) void commitCreate();
                    }}
                    disabled={createBusy}
                    className="flex-1 bg-background border rounded px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                  {createBusy && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  )}
                </div>
                {createError && (
                  <span className="text-xs text-red-500 pl-6">{createError}</span>
                )}
              </div>
            )}
            {items.length === 0 && !creating ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                No directories found
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.path}
                  className={`flex items-center gap-2 p-2 rounded-md cursor-pointer hover:bg-muted ${
                    selectedPath === item.path ? "bg-muted" : ""
                  }`}
                >
                  <button
                    className="flex items-center gap-2 flex-1 text-left"
                    onClick={() => handleSelect(item)}
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm truncate">{item.name}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleNavigate(item.path)}
                    title="Open folder"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      )}
```

- [ ] **Step 6: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Lint the frontend**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no errors in `remote-directory-browser.tsx`.

- [ ] **Step 8: Commit** (only if commits are authorized)

```bash
git add apps/vibedeckx-ui/components/project/remote-directory-browser.tsx
git commit -m "feat(ui): add new-folder creation to remote directory browser"
```

---

## Task 6: Manual end-to-end verification

**No automated test framework exists in this repo**, so verify manually against a connected remote server.

- [ ] **Step 1: Build / run dev**

Run: `pnpm dev:all` (backend on 5173, frontend on 3000) and connect a remote server.

- [ ] **Step 2: Verify the happy path in Create New Project**

1. Open Create New Project → add a remote → reach the "Select Directory" step.
2. Click the new-folder (FolderPlus) icon in the path header.
3. Confirm an inline row appears with `New Folder` pre-selected.
4. Type a unique name, press Enter.
5. Expected: spinner briefly shows, the folder appears in the list, and "Selected: <path>" updates to the new folder.

- [ ] **Step 3: Verify duplicate-name handling**

1. Click new-folder again, type the same name you just created, press Enter.
2. Expected: a red inline message "A folder with that name already exists"; the row stays in edit mode; no duplicate appears.

- [ ] **Step 4: Verify cancel paths**

1. Click new-folder, press Escape → row disappears, nothing created.
2. Click new-folder, clear the input, press Enter → row disappears, nothing created (no request sent).

- [ ] **Step 5: Verify Project Settings reuse**

Open an existing remote project's Settings → remote directory browser → confirm the new-folder icon and flow work identically.

- [ ] **Step 6: Verify in an empty directory**

Navigate into a directory with no subfolders ("No directories found"), click new-folder, and confirm the inline row still renders and creation works.

---

## Self-Review Notes

- **Spec coverage:** mkdir route (Task 1), tunnel allowlist (Task 2), orchestrator proxy (Task 3), API client (Task 4), UI button + inline row + Enter/blur/Escape + select-on-success + error display (Task 5), manual testing incl. both host components and empty-dir case (Task 6). All spec sections mapped.
- **Type consistency:** `createRemoteServerDirectory(serverId, parentPath, name)` is used identically in Task 4 (definition) and Task 5 (call). The remote route returns `{ path, name, type: "directory" }`, matching `RemoteBrowseItem`, so `onSelect(item.path)` is valid.
- **Empty-state interaction:** Task 5 Step 5 explicitly restructures the original empty-state branch so the create row is not hidden when the directory has no subfolders.
