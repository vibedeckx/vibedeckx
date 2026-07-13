# Primary Remote Visibility and Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a project's primary remote deterministic, visible, and user-selectable, and identify the actual repository location in every merge-status tooltip.

**Architecture:** Continue using normalized `sort_order` as the single source of truth: order `0` is primary. Storage transactions append, remove, and promote remotes without ties; a dedicated project-owned API performs promotion. The merge-status project route returns a repository descriptor derived from the same local/primary-remote routing decision used for computation, and the frontend threads that descriptor to badges instead of inferring it.

**Tech Stack:** TypeScript, Kysely/SQLite, Fastify, React 19, Next.js, Vitest, shadcn/ui.

**Design:** `docs/plans/2026-07-13-primary-remote-visibility-design.md`

---

## Global constraints

- Follow `@superpowers:test-driven-development` for every behavior change: write a failing test, run it and confirm the expected failure, then write production code.
- No new dependencies.
- Backend ESM imports retain `.js` extensions.
- Do not add an `is_primary` column; normalized `sort_order` remains the only source of truth.
- Primary selection must verify both project ownership and association membership.
- Merge-status repository metadata must come from the backend routing decision, not frontend inference.
- Preserve same-project merge-status data on transport failure; clear it synchronously on project switch.

### Task 1: Normalize project-remote ordering in storage

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/remote-servers.ts`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts`
- Test: `packages/vibedeckx/src/storage/projects.test.ts`

**Step 1: Write failing storage tests**

Add tests to the `projectRemotes` section of `projects.test.ts`:

```ts
it("appends remotes by default without replacing the primary", async () => {
  await storage.projects.create({ id: "p1", name: "proj", path: null });
  const s1 = await storage.remoteServers.create({ name: "s1", url: "http://s1" });
  const s2 = await storage.remoteServers.create({ name: "s2", url: "http://s2" });

  await storage.projectRemotes.add({ project_id: "p1", remote_server_id: s1.id, remote_path: "/a" });
  await storage.projectRemotes.add({ project_id: "p1", remote_server_id: s2.id, remote_path: "/b" });

  const rows = await storage.projectRemotes.getByProject("p1");
  expect(rows.map((r) => [r.server_name, r.sort_order])).toEqual([
    ["s1", 0],
    ["s2", 1],
  ]);
});

it("promotes a remote and preserves the relative order of the others", async () => {
  // create s1, s2, s3 in that order
  const promoted = await storage.projectRemotes.setPrimary("p1", remote3.id);
  expect(promoted).toBe(true);
  const rows = await storage.projectRemotes.getByProject("p1");
  expect(rows.map((r) => [r.server_name, r.sort_order])).toEqual([
    ["s3", 0],
    ["s1", 1],
    ["s2", 2],
  ]);
});

it("refuses to promote an association from another project", async () => {
  expect(await storage.projectRemotes.setPrimary("p1", remoteFromP2.id)).toBe(false);
});

it("removing the primary promotes and renumbers the remaining remotes", async () => {
  await storage.projectRemotes.remove(primary.id);
  const rows = await storage.projectRemotes.getByProject("p1");
  expect(rows.map((r) => r.sort_order)).toEqual([0, 1]);
  expect(rows[0].server_name).toBe("s2");
});
```

Also add a SQLite startup test that inserts tied legacy rows directly, closes and reopens storage, and expects deterministic `0..n-1` order. Use insertion order as the tie-breaker where SQLite `rowid` is available.

**Step 2: Run tests and confirm RED**

Run:

```bash
cd packages/vibedeckx
npx vitest run src/storage/projects.test.ts
```

Expected: FAIL because `setPrimary` does not exist and default additions both receive order `0`.

**Step 3: Extend the storage interface**

Add to `Storage["projectRemotes"]` in `storage/types.ts`:

```ts
setPrimary(projectId: string, remoteId: string): Promise<boolean>;
```

Keep existing method signatures source-compatible.

**Step 4: Implement transactional ordering**

In `storage/repositories/remote-servers.ts`, introduce an internal transaction helper:

```ts
async function renumberProjectRemotes(
  trx: Transaction<DB>,
  projectId: string,
  orderedIds: string[],
): Promise<void> {
  for (const [sortOrder, id] of orderedIds.entries()) {
    await trx.updateTable("project_remotes")
      .set({ sort_order: sortOrder })
      .where("id", "=", id)
      .where("project_id", "=", projectId)
      .execute();
  }
}
```

Implement these invariants in transactions:

- `add`: read existing IDs ordered by `sort_order`, then `id`; clamp an explicit insertion order to `0..length`, default to `length`, insert, and renumber the combined list.
- `setPrimary`: read the project's ordered IDs, return `false` if `remoteId` is absent, move it to the front, renumber, return `true`.
- `remove`: read the association to obtain its project, delete it, renumber the remaining project remotes, and preserve the existing boolean result.
- `getByProject`: add `id ASC` as a deterministic secondary order.

In `storage/sqlite.ts`, after the legacy multi-remote migration, normalize existing rows once per startup with a small SQLite transaction ordered by `project_id`, `sort_order`, then `rowid`. The pass is idempotent.

**Step 5: Run storage tests and typecheck**

```bash
cd packages/vibedeckx
npx vitest run src/storage/projects.test.ts
cd ../..
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: all tests pass; typecheck exits 0.

**Step 6: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts \
  packages/vibedeckx/src/storage/repositories/remote-servers.ts \
  packages/vibedeckx/src/storage/sqlite.ts \
  packages/vibedeckx/src/storage/projects.test.ts
git commit -m "feat: deterministic primary remote ordering"
```

### Task 2: Add the dedicated Set Primary API

**Files:**
- Modify: `packages/vibedeckx/src/routes/project-remote-routes.ts`
- Create: `packages/vibedeckx/src/routes/project-remote-routes.test.ts`
- Modify: `apps/vibedeckx-ui/lib/api.ts`

**Step 1: Write failing route tests**

Follow the Fastify injection setup in `routes/remote-server-routes.test.ts`: create temporary SQLite storage, decorate Fastify with `storage`, register `projectRemoteRoutes`, and create two owned projects plus remotes.

Add tests:

```ts
it("sets an associated remote as primary", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/projects/p1/remotes/${remote2.id}/primary`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ success: true });
  expect((await storage.projectRemotes.getByProject("p1"))[0].id).toBe(remote2.id);
});

it("returns 404 when the association belongs to another project", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/projects/p1/remotes/${remoteFromP2.id}/primary`,
  });
  expect(res.statusCode).toBe(404);
});
```

Use the repo's auth-disabled test convention; if auth is enabled in the test fixture, inject the matching user header and ensure project ownership is checked through `projects.getById(id, userId)`.

**Step 2: Confirm RED**

```bash
cd packages/vibedeckx
npx vitest run src/routes/project-remote-routes.test.ts
```

Expected: FAIL/404 because the route does not exist.

**Step 3: Implement the route**

Add to `project-remote-routes.ts`:

```ts
fastify.post<{ Params: { id: string; rid: string } }>(
  "/api/projects/:id/remotes/:rid/primary",
  async (request, reply) => {
    const userId = requireAuth(request, reply);
    if (userId === null) return;
    const project = await fastify.storage.projects.getById(request.params.id, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const promoted = await fastify.storage.projectRemotes.setPrimary(
      project.id,
      request.params.rid,
    );
    if (!promoted) return reply.code(404).send({ error: "Project remote not found" });
    return reply.send({ success: true });
  },
);
```

**Step 4: Add the frontend API method**

In `apps/vibedeckx-ui/lib/api.ts`:

```ts
async setProjectRemotePrimary(projectId: string, remoteId: string): Promise<void> {
  const res = await authFetch(
    `${getApiBase()}/api/projects/${projectId}/remotes/${remoteId}/primary`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? "Failed to set primary remote");
  }
},
```

**Step 5: Verify and commit**

```bash
cd packages/vibedeckx
npx vitest run src/routes/project-remote-routes.test.ts src/storage/projects.test.ts
cd ../..
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui
npx tsc --noEmit
cd ../..
git add packages/vibedeckx/src/routes/project-remote-routes.ts \
  packages/vibedeckx/src/routes/project-remote-routes.test.ts \
  apps/vibedeckx-ui/lib/api.ts
git commit -m "feat: set project primary remote API"
```

### Task 3: Return the actual merge-status repository location

**Files:**
- Modify: `packages/vibedeckx/src/routes/merge-status-routes.ts`
- Create or modify: `packages/vibedeckx/src/routes/merge-status-routes.test.ts`
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx`

**Step 1: Write failing backend tests**

Add route-level Fastify tests for the project endpoint:

```ts
it("labels a local merge-status response as Local", async () => {
  const res = await postBatch(localProjectId, [{ branch: "dev1", target: "main" }]);
  expect(res.statusCode).toBe(200);
  expect(res.json().repository).toEqual({ kind: "local", label: "Local" });
});

it("labels a remote-only response with the primary remote identity", async () => {
  // Stub proxyToRemoteAuto or register a minimal path endpoint as established
  // by other remote-proxy route tests.
  expect(res.json().repository).toEqual({
    kind: "remote",
    remoteServerId: primaryServer.id,
    label: "Remote A",
  });
});
```

Also promote Remote B and repeat the request to prove the descriptor follows the routing decision.

**Step 2: Confirm backend RED**

```bash
cd packages/vibedeckx
npx vitest run src/routes/merge-status-routes.test.ts
```

Expected: FAIL because `repository` is absent.

**Step 3: Implement the backend descriptor**

Add:

```ts
export type MergeStatusRepository =
  | { kind: "local"; label: "Local" }
  | { kind: "remote"; remoteServerId: string; label: string };
```

Extend `getRemoteConfig` with `serverName`. For the local branch return:

```ts
reply.code(200).send({
  repository: { kind: "local", label: "Local" },
  entries: computeMergeStatusPairs(project.path, comparisons),
});
```

For a successful remote proxy response, return:

```ts
reply.code(200).send({
  repository: {
    kind: "remote",
    remoteServerId: remoteConfig.serverId,
    label: remoteConfig.serverName,
  },
  entries: result.data.entries ?? [],
});
```

Preserve the remote error status/body unchanged for non-success responses. The path endpoint remains `{ entries }` because repository identity is owned by the project route.

**Step 4: Write failing frontend hook tests**

In `use-merge-status.behavior.test.tsx`, expose `repositoryLabel` from the probe and add:

```ts
it("stores the repository label from a successful batch", async () => {
  getMergeStatus.mockResolvedValueOnce({
    ok: true,
    repository: { kind: "remote", remoteServerId: "r1", label: "Remote A" },
    entries: [],
  });
  await render("p1", worktrees);
  expect(latest?.repositoryLabel).toBe("Remote A");
});

it("keeps the label on same-project transport failure and clears it on project switch", async () => {
  // success p1 -> failure p1 retains Remote A -> failure p2 clears to null
});
```

Run and confirm failure because the hook exposes no repository metadata.

**Step 5: Implement frontend types and hook state**

In `lib/api.ts` add `MergeStatusRepository` and include it in the successful `MergeStatusBatchResult`:

```ts
export type MergeStatusBatchResult =
  | { ok: true; repository: MergeStatusRepository; entries: MergeStatusPairEntry[] }
  | { ok: false; status: number };
```

Parse `data.repository` in `getMergeStatus`.

In `useMergeStatus.ts` add:

```ts
const [repositoryLabel, setRepositoryLabel] = useState<string | null>(null);
```

- On successful response: `setRepositoryLabel(result.repository.label)`.
- On project switch and no-project/empty-worktree reset: clear it.
- On same-project transport failure: leave it untouched.
- Return `repositoryLabel` from the hook.

**Step 6: Verify and commit**

```bash
cd packages/vibedeckx
npx vitest run src/routes/merge-status-routes.test.ts
cd ../../apps/vibedeckx-ui
npx vitest run hooks/use-merge-status.behavior.test.tsx
npx tsc --noEmit
cd ../..
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/routes/merge-status-routes.ts \
  packages/vibedeckx/src/routes/merge-status-routes.test.ts \
  apps/vibedeckx-ui/lib/api.ts \
  apps/vibedeckx-ui/hooks/use-merge-status.ts \
  apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx
git commit -m "feat: report merge-status repository location"
```

### Task 4: Show Primary controls and repository-aware tooltips

**Files:**
- Modify: `apps/vibedeckx-ui/components/project/project-settings-form.tsx`
- Create: `apps/vibedeckx-ui/components/project/project-settings-form.primary-remote.test.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx`
- Create: `apps/vibedeckx-ui/components/layout/workspace-merge-badge.test.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Write failing settings tests**

Use the repo's `createRoot` + `act` jsdom pattern and mock `useProjectRemotes` plus the API method. Render `ProjectSettingsForm` with two remotes and assert:

```ts
expect(container.textContent).toContain("Primary");
expect(container.textContent).toContain("Set as Primary");
```

Click the second remote's action and assert:

```ts
expect(api.setProjectRemotePrimary).toHaveBeenCalledWith("p1", "remote-link-2");
expect(refreshRemotes).toHaveBeenCalledTimes(1);
```

Add an error test proving a rejected API call does not call refresh and renders the message.

**Step 2: Confirm settings RED**

```bash
cd apps/vibedeckx-ui
npx vitest run components/project/project-settings-form.primary-remote.test.tsx
```

Expected: FAIL because neither label nor action exists.

**Step 3: Implement Settings UI**

In `project-settings-form.tsx`:

- Import `Badge` and a small `Crown` or `Star` icon.
- Add `settingPrimaryRemoteId` state.
- Implement `handleSetPrimaryRemote(remoteId)` that clears the form error, awaits `api.setProjectRemotePrimary`, refreshes remotes, reports failure through `error`, and clears pending state in `finally`.
- Treat `index === 0` as primary because `useProjectRemotes` returns normalized order.
- Render a `Primary` badge beside the first server name.
- Render a visible `Set as Primary` ghost/outline button for non-primary rows.
- Add the explanatory copy from the design below the section label.

Do not optimistically reorder the list.

**Step 4: Write failing badge tooltip tests**

Render `WorkspaceMergeBadge` inside `TooltipProvider`. Prefer extracting and testing a pure label helper if Radix portals make tooltip interaction brittle:

```ts
expect(mergeBadgeAriaLabel(info, "Remote A")).toBe(
  "In sync with main · Remote A",
);
expect(mergeBadgeAriaLabel(dirtyInfo, "Local")).toContain(
  "· uncommitted changes · Local",
);
```

Confirm RED because no repository label is accepted.

**Step 5: Thread repository metadata to badges**

Change `WorkspaceMergeBadgeProps`:

```ts
repositoryLabel?: string | null;
```

Build the accessible/tooltip label in this order:

```ts
const parts = [relationshipLabel];
if (info.dirty) parts.push("uncommitted changes");
if (repositoryLabel) parts.push(repositoryLabel);
const ariaLabel = parts.join(" · ");
```

Use `ariaLabel` as both the button's `aria-label` and tooltip content.

Add optional `mergeRepositoryLabel` to `AppSidebarProps`, pass it into every badge, and in `page.tsx` destructure `repositoryLabel` from `useMergeStatus` and pass it to `AppSidebar`.

**Step 6: Verify frontend and commit**

```bash
cd apps/vibedeckx-ui
npx vitest run \
  components/project/project-settings-form.primary-remote.test.tsx \
  components/layout/workspace-merge-badge.test.tsx \
  hooks/use-merge-status.behavior.test.tsx
npx tsc --noEmit
npx eslint \
  components/project/project-settings-form.tsx \
  components/project/project-settings-form.primary-remote.test.tsx \
  components/layout/workspace-merge-badge.tsx \
  components/layout/workspace-merge-badge.test.tsx \
  components/layout/app-sidebar.tsx \
  app/page.tsx
cd ../..
git add apps/vibedeckx-ui/components/project/project-settings-form.tsx \
  apps/vibedeckx-ui/components/project/project-settings-form.primary-remote.test.tsx \
  apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx \
  apps/vibedeckx-ui/components/layout/workspace-merge-badge.test.tsx \
  apps/vibedeckx-ui/components/layout/app-sidebar.tsx \
  apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): primary remote controls and repository tooltips"
```

### Task 5: Full verification and documentation alignment

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-07-12-branch-merge-status-design.md`
- Verify: all files changed by Tasks 1–4

**Step 1: Update the branch merge-status spec**

Document that:

- remote-only merge status uses the explicitly visible Primary remote;
- the project route returns the repository descriptor;
- tooltip text includes Local or the Primary server name;
- Primary is normalized `sort_order=0` and user-selectable in Settings.

**Step 2: Run focused suites**

```bash
cd packages/vibedeckx
npx vitest run \
  src/storage/projects.test.ts \
  src/routes/project-remote-routes.test.ts \
  src/routes/merge-status-routes.test.ts
cd ../../apps/vibedeckx-ui
npx vitest run \
  hooks/use-merge-status.test.ts \
  hooks/use-merge-status.behavior.test.tsx \
  components/project/project-settings-form.primary-remote.test.tsx \
  components/layout/workspace-merge-badge.test.tsx
```

Expected: all focused tests pass with no warnings.

**Step 3: Run full verification**

```bash
cd packages/vibedeckx
npx vitest run
cd ../../apps/vibedeckx-ui
npx vitest run
cd ../..
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui
npx tsc --noEmit
pnpm --filter vibedeckx-ui lint
```

Expected:

- Backend and frontend suites pass.
- Both typechecks exit 0.
- No new lint errors in touched files; unrelated baseline failures, if any, are recorded rather than modified.

**Step 4: Manual smoke test**

With a project containing Local + Remote A + Remote B:

1. Open Project Info → Settings.
2. Confirm exactly one `Primary` badge.
3. Click `Set as Primary` on Remote B; confirm it moves to the top.
4. Add another remote; confirm it appears last and does not become Primary.
5. For the local project, hover a merge badge and confirm `· Local`.
6. For a remote-only project, hover a merge badge and confirm `· Remote B`.
7. Switch Primary back to Remote A, refresh merge status, and confirm the tooltip changes to `· Remote A`.

**Step 5: Commit documentation or verification-only changes**

```bash
git add docs/superpowers/specs/2026-07-12-branch-merge-status-design.md
git commit -m "docs: primary remote merge-status semantics"
```

Skip the commit if Task 4 already included the final documentation and the worktree is clean.

