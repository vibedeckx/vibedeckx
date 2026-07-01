# Design: `--no-local-projects` flag

**Date:** 2026-07-01
**Status:** Approved

## Problem

Vibedeckx supports both local-folder projects and remote-server projects. In a
SaaS / hosted deployment there is no local filesystem for the user to point at,
so the "Local Folder" option in the create-project dialog is meaningless and
should not be offered. We need a way for a deployment to disable local project
creation entirely.

Per the hosted deployment model, `--auth` (multi-tenant) instances already run
no local agent sessions — but we want an explicit, independent flag rather than
tying this to auth, so the two concepts can diverge later.

## Goal

Add a server flag that, when set, prevents creation of local projects:

- Hide the "Local Folder" section in the create-project dialog.
- Reject any create/update request that supplies a local `path`, server-side.
- Leave remote-project creation fully functional.

Non-goals: migrating or hiding existing local projects (a fresh SaaS DB has
none), a broader "hosted mode" umbrella flag, and any executor/agent-mode
changes.

## Design

### 1. CLI flag — `packages/vibedeckx/src/command.ts`

Add a boolean flag `--no-local-projects`, default `false` (local projects
allowed — preserves current behavior for everyone running the CLI locally),
parallel to the existing `--auth` and `--accept-remote` flags.

In `func`:

```ts
const noLocalProjects = flags["no-local-projects"] ?? false;
// ...
const server = await createServer({ storage, authEnabled, acceptRemote, noLocalProjects, tls });
```

A SaaS deployment starts the server with `--no-local-projects`.

### 2. Server wiring — `packages/vibedeckx/src/server.ts`

- `createServer` accepts a new option `noLocalProjects?: boolean`.
- Decorate the Fastify instance so routes can read it:
  `server.decorate("noLocalProjects", noLocalProjects ?? false)`.
- Extend the public (no-auth) `/api/config` endpoint with a positive-phrased
  field:

```ts
server.get("/api/config", async () => ({
  authEnabled,
  clerkPublishableKey: authEnabled ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
  localProjectsEnabled: !noLocalProjects,
}));
```

Positive phrasing (`localProjectsEnabled`) lets the frontend read
`if (config.localProjectsEnabled)` without a double negative, and a missing
field defaults to "enabled" for backward compatibility.

### 3. Backend enforcement — `packages/vibedeckx/src/routes/project-routes.ts`

- `POST /api/projects`: if `noLocalProjects` is on **and** the body contains a
  non-empty `path`, return `400` with message
  `"Local projects are disabled on this server"`. Remote-only creation
  (`path` omitted/empty) proceeds normally.
- `PUT /api/projects/:id`: same guard when the update sets/adds a non-empty
  `path`.
- Existing projects are untouched — only creating or adding a local `path` is
  blocked. (Moot in practice: SaaS DB has no local projects.)

This makes the rule non-bypassable via direct REST calls, not just the UI.

### 4. Frontend config type — `apps/vibedeckx-ui/lib/api.ts`

Extend `AppConfig`:

```ts
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
  localProjectsEnabled: boolean; // treat missing as true
}
```

Ensure the fallback config (network error) and any persisted-config read default
a missing `localProjectsEnabled` to `true`, so existing clients / older servers
keep showing the Local Folder option.

### 5. Frontend UI — `apps/vibedeckx-ui/components/project/create-project-dialog.tsx`

- Read `localProjectsEnabled` via `useAppConfig()`.
- When `false`, do not render the "Local Folder" section (path input + folder
  picker button). The dialog becomes remote-only.
- No validation rewrite needed: the existing logic already permits remote-only
  creation (`hasRemotes && !hasLocalPath`). When the local section is hidden,
  `path` stays empty and only the remote path applies.

## Error handling

The backend returns a clear `400` with a human-readable message the dialog can
surface if a local-path create somehow reaches it (e.g. stale client).

## Testing

No test framework is configured. Verify via:

- `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (backend)
- `cd apps/vibedeckx-ui && npx tsc --noEmit` (frontend)
- Manual: start the server with `--no-local-projects`, confirm
  `GET /api/config` returns `localProjectsEnabled: false`, the create-project
  dialog hides "Local Folder", remote-only creation works, and a hand-crafted
  `POST /api/projects` with a `path` is rejected with `400`.
- Regression: start without the flag and confirm Local Folder still appears and
  local creation works.
