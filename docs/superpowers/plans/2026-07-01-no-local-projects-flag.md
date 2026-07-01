# `--no-local-projects` Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--no-local-projects` server flag that hides the "Local Folder" option in the create-project dialog and rejects local-path project creation server-side, for SaaS/hosted deployments.

**Architecture:** A boolean CLI flag flows `command.ts` → `createServer()` → a Fastify decorator (`noLocalProjects`) read by project routes, and is surfaced to the frontend through the existing public `/api/config` endpoint as `localProjectsEnabled: boolean`. The create-project dialog reads that field via `useAppConfig()` and conditionally omits the Local Folder UI. Backend guards on `POST`/`PUT /api/projects` reject any non-empty `path` when the flag is on.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports need `.js` extensions), Fastify, `@stricli/core` CLI, Next.js 16 / React 19 frontend.

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports use `.js` extensions**.
- No test framework is configured. Verification is via `tsc --noEmit` + manual runtime checks (not unit tests).
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Default behavior must be unchanged when the flag is absent: local projects remain allowed. `localProjectsEnabled` defaults to `true` when the config field is missing (backward compatibility with older servers / persisted config).
- Positive-phrased config field name: `localProjectsEnabled` (never a double negative in the frontend).
- Backend rejection message (use verbatim): `"Local projects are disabled on this server"`.

---

### Task 1: Wire the `--no-local-projects` flag through the CLI and server

Add the CLI flag, thread it into `createServer`, decorate the Fastify instance, and expose it on `/api/config`. This is one task because the flag is useless (and untestable) until it reaches both the decorator and the config endpoint; a reviewer would not accept the flag definition without its wiring.

**Files:**
- Modify: `packages/vibedeckx/src/command.ts` (flag definition ~35-88, `func` signature ~90-102, body ~106 & 150)
- Modify: `packages/vibedeckx/src/server.ts` (`createServer` opts ~105-108, decorate ~153, `/api/config` ~234-237)
- Modify: `packages/vibedeckx/src/server-types.ts` (FastifyInstance augmentation, after `authEnabled: boolean;`)

**Interfaces:**
- Produces: Fastify decorator `fastify.noLocalProjects: boolean` (default `false`), readable in any route.
- Produces: `GET /api/config` response now includes `localProjectsEnabled: boolean`.
- Produces: `createServer(opts)` accepts optional `noLocalProjects?: boolean`.

- [ ] **Step 1: Add the CLI flag definition**

In `packages/vibedeckx/src/command.ts`, inside `startCommand`'s `parameters.flags` object, add after the `"accept-remote"` flag block (after line 69):

```ts
      "no-local-projects": {
        kind: "boolean",
        brief: "Disable creation of local-folder projects (for SaaS/hosted deployments). Remote projects are unaffected.",
        optional: true,
      },
```

- [ ] **Step 2: Add the flag to `func`'s parameter type and read it**

In the same file, add to the `func` flags type (after `"accept-remote": boolean | undefined;` on line 98):

```ts
    "no-local-projects": boolean | undefined;
```

Then in the `func` body, after `const acceptRemote = flags["accept-remote"] ?? false;` (line 106), add:

```ts
    const noLocalProjects = flags["no-local-projects"] ?? false;
```

And update the `createServer` call (line 150) from:

```ts
    const server = await createServer({ storage, authEnabled, acceptRemote, tls });
```

to:

```ts
    const server = await createServer({ storage, authEnabled, acceptRemote, noLocalProjects, tls });
```

- [ ] **Step 3: Accept and default the option in `createServer`**

In `packages/vibedeckx/src/server.ts`, change the `createServer` signature (line 105) from:

```ts
export const createServer = async (opts: { storage: Storage; authEnabled?: boolean; acceptRemote?: boolean; tls?: TLSOptions }) => {
```

to:

```ts
export const createServer = async (opts: { storage: Storage; authEnabled?: boolean; acceptRemote?: boolean; noLocalProjects?: boolean; tls?: TLSOptions }) => {
```

Then, just after `const acceptRemote = opts.acceptRemote ?? false;` (line 107), add:

```ts
  const noLocalProjects = opts.noLocalProjects ?? false;
```

- [ ] **Step 4: Decorate the Fastify instance**

In `packages/vibedeckx/src/server.ts`, immediately after the existing decorate line (line 153, `server.decorate("authEnabled", authEnabled);`), add:

```ts
  // Decorate noLocalProjects so project routes can reject local-path creation
  server.decorate("noLocalProjects", noLocalProjects);
```

- [ ] **Step 5: Type the decorator**

In `packages/vibedeckx/src/server-types.ts`, inside `declare module "fastify"` → `interface FastifyInstance`, add after `authEnabled: boolean;`:

```ts
    noLocalProjects: boolean;
```

- [ ] **Step 6: Expose it on `/api/config`**

In `packages/vibedeckx/src/server.ts`, update the `/api/config` handler (lines 234-237) from:

```ts
  server.get("/api/config", async () => ({
    authEnabled,
    clerkPublishableKey: authEnabled ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
  }));
```

to:

```ts
  server.get("/api/config", async () => ({
    authEnabled,
    clerkPublishableKey: authEnabled ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
    localProjectsEnabled: !noLocalProjects,
  }));
```

- [ ] **Step 7: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exits 0, no errors.

- [ ] **Step 8: Manually verify the config endpoint reflects the flag**

Run (default — flag off):
```bash
node packages/vibedeckx/dist/bin.js start --port 5199 &
sleep 2 && curl -s http://127.0.0.1:5199/api/config && kill %1
```
Expected JSON includes `"localProjectsEnabled":true`.

> Note: requires a prior `pnpm build:main`. If iterating without a build, this manual check can be deferred to Task 3's end-to-end verification, which builds once. The type-check in Step 7 is the required gate for this task.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/command.ts packages/vibedeckx/src/server.ts packages/vibedeckx/src/server-types.ts
git commit -m "feat: add --no-local-projects flag and surface via /api/config"
```

---

### Task 2: Enforce the flag in project create/update routes

Reject any local `path` on `POST` and `PUT /api/projects` when `fastify.noLocalProjects` is on, so the rule cannot be bypassed by direct REST calls.

**Files:**
- Modify: `packages/vibedeckx/src/routes/project-routes.ts` (POST handler ~113-147, PUT handler ~163-208)

**Interfaces:**
- Consumes: `fastify.noLocalProjects: boolean` (from Task 1).
- Produces: `POST /api/projects` and `PUT /api/projects/:id` return `400 { error: "Local projects are disabled on this server" }` when a non-empty `path` is supplied and the flag is on.

- [ ] **Step 1: Guard the POST handler**

In `packages/vibedeckx/src/routes/project-routes.ts`, inside the `POST /api/projects` handler, after the `if (!name) { ... }` block (ends line 120) and before the `remotePath` check (line 123), add:

```ts
    if (fastify.noLocalProjects && projectPath && projectPath.trim().length > 0) {
      return reply.code(400).send({ error: "Local projects are disabled on this server" });
    }
```

(`projectPath` is already destructured from `req.body` on line 116.)

- [ ] **Step 2: Guard the PUT handler**

In the same file, inside the `PUT /api/projects/:id` handler, after `newPath` etc. are destructured (line 171) and before the secret-confusion guard (line 177), add:

```ts
    // Block setting/adding a local path when local projects are disabled.
    // Existing local paths are untouched: only guard when the caller sends a new non-empty path.
    if (fastify.noLocalProjects && newPath !== undefined && newPath !== null && newPath.trim().length > 0) {
      return reply.code(400).send({ error: "Local projects are disabled on this server" });
    }
```

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/project-routes.ts
git commit -m "feat: reject local-path project create/update when --no-local-projects"
```

---

### Task 3: Hide the Local Folder UI when local projects are disabled

Extend the frontend `AppConfig` type with `localProjectsEnabled` (defaulting to `true` when absent) and conditionally render the Local Folder section of the create-project dialog. End with an end-to-end runtime verification of the whole feature.

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (`AppConfig` interface ~89-92)
- Modify: `apps/vibedeckx-ui/hooks/use-app-config.ts` (network-error fallback ~31)
- Modify: `apps/vibedeckx-ui/components/project/create-project-dialog.tsx` (imports ~14, component body, Local Folder JSX ~257-271, empty-state validation message ~202-205)

**Interfaces:**
- Consumes: `GET /api/config` field `localProjectsEnabled: boolean` (from Task 1).
- Produces: create-project dialog omits the Local Folder input + folder-picker when `localProjectsEnabled === false`.

- [ ] **Step 1: Extend the `AppConfig` type**

In `apps/vibedeckx-ui/lib/api.ts`, change the `AppConfig` interface (lines 89-92) from:

```ts
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
}
```

to:

```ts
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
  // Absent on older servers / persisted configs — treat missing as enabled.
  localProjectsEnabled?: boolean;
}
```

(Optional field so persisted configs written by older builds still parse. Consumers treat `undefined` as `true`.)

- [ ] **Step 2: Keep the no-auth fallback consistent**

In `apps/vibedeckx-ui/hooks/use-app-config.ts`, update the network-error fallback (line 31) from:

```ts
        if (!persisted) setConfig({ authEnabled: false });
```

to:

```ts
        if (!persisted) setConfig({ authEnabled: false, localProjectsEnabled: true });
```

- [ ] **Step 3: Read config in the dialog and gate the Local Folder section**

In `apps/vibedeckx-ui/components/project/create-project-dialog.tsx`:

First, add the hook import. Change line 14 area — after the existing `import { api, type RemoteServer, type Project } from "@/lib/api";` add:

```ts
import { useAppConfig } from "@/hooks/use-app-config";
```

Then inside the `CreateProjectDialog` component, near the other hooks (after `const [name, setName] = useState("");` around line 40), add:

```ts
  const { config } = useAppConfig();
  // Missing field (older server) → default to enabled.
  const localProjectsEnabled = config?.localProjectsEnabled !== false;
```

Then wrap the Local Folder section (lines 257-271, the `{/* Local Folder Section */}` block) so it only renders when enabled:

```tsx
          {/* Local Folder Section */}
          {localProjectsEnabled && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Local Folder</label>
              <div className="flex gap-2">
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/project (optional)"
                  className="flex-1"
                />
                <Button variant="outline" onClick={handleSelectFolder}>
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
```

- [ ] **Step 4: Update the empty-state validation message**

In the same file, in `handleSubmit`, change the no-input guard (lines 202-205) from:

```tsx
    if (!hasLocalPath && !hasRemotes) {
      setError("Please provide a local folder, remote server, or both");
      return;
    }
```

to:

```tsx
    if (!hasLocalPath && !hasRemotes) {
      setError(
        localProjectsEnabled
          ? "Please provide a local folder, remote server, or both"
          : "Please add a remote server"
      );
      return;
    }
```

(When local is hidden, `path` stays empty so `hasLocalPath` is `false` and the existing `hasRemotes && !hasLocalPath` create logic already produces a remote-only project — no other change needed.)

- [ ] **Step 5: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 6: End-to-end manual verification**

Build once and exercise both modes:

```bash
pnpm build:main
```

With the flag ON:
```bash
node packages/vibedeckx/dist/bin.js start --no-local-projects --port 5199 &
sleep 2
curl -s http://127.0.0.1:5199/api/config          # expect "localProjectsEnabled":false
curl -s -X POST http://127.0.0.1:5199/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"x","path":"/tmp/x"}'                # expect 400 "Local projects are disabled on this server"
kill %1
```

With the flag OFF (regression):
```bash
node packages/vibedeckx/dist/bin.js start --port 5199 &
sleep 2
curl -s http://127.0.0.1:5199/api/config          # expect "localProjectsEnabled":true
kill %1
```

UI spot-check (dev mode): run `pnpm dev:all`, open the create-project dialog. Confirm Local Folder appears normally; then restart the backend with `--no-local-projects` (or point the frontend at a flagged server), reload, and confirm the Local Folder section is gone and remote-only creation still works.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-app-config.ts apps/vibedeckx-ui/components/project/create-project-dialog.tsx
git commit -m "feat: hide Local Folder option when localProjectsEnabled is false"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 CLI flag → Task 1 Steps 1-2. ✓
- Spec §2 server wiring (createServer opt, decorate, /api/config) → Task 1 Steps 3-6. ✓
- Spec §3 backend enforcement (POST + PUT) → Task 2. ✓
- Spec §4 frontend config type + missing-value default → Task 3 Steps 1-2. ✓
- Spec §5 frontend UI gating + validation message → Task 3 Steps 3-4. ✓
- Spec "Testing" (tsc backend + frontend, manual flag-on/off) → Task 1 Step 7-8, Task 2 Step 3, Task 3 Steps 5-6. ✓

**Type consistency:** `noLocalProjects` (boolean, backend) is used identically in command.ts, server.ts, server-types.ts, and project-routes.ts. `localProjectsEnabled` (optional boolean, config wire + frontend) is defined once in `AppConfig` and read as `config?.localProjectsEnabled !== false` — consistent positive-phrasing, missing→true. Backend emits it as `!noLocalProjects` (always present); frontend tolerates absence for older servers. Rejection message string is identical in both backend guards and matches the manual-verify expectation.

**Placeholder scan:** No TBD/TODO; every code step shows exact code.
