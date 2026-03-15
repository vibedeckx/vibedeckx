# Remote Server User Isolation

**Date:** 2026-03-15
**Status:** Approved

## Problem

The `remote_servers` table has no `user_id` column. All API routes return all servers to all users. One user can see, modify, and delete another user's remote servers.

## Solution

Apply the same userId isolation pattern already used by `projects` to `remote_servers`.

## Design

### Database

Add `user_id TEXT NOT NULL DEFAULT ''` to `remote_servers` via `ALTER TABLE ADD COLUMN` migration in `sqlite.ts`. Existing rows get `user_id = ''` (matches auth-disabled behavior). All filtered queries append `AND user_id = @user_id` when userId is provided.

Add index: `CREATE INDEX IF NOT EXISTS idx_remote_servers_user_id ON remote_servers(user_id)` (matches the projects pattern).

Change `url` uniqueness constraint from `UNIQUE(url)` to `UNIQUE(url, user_id)` so different users can independently configure the same remote server URL with different API keys. Migration: drop and recreate table with new constraint (SQLite does not support `ALTER TABLE DROP CONSTRAINT`).

### Storage Interface (`types.ts`)

Add `userId?: string` parameter to these `remoteServers` methods:

- `create(server, userId?)` — stores `user_id`
- `getAll(userId?)` — filters by `user_id`
- `getById(id, userId?)` — filters by `user_id`
- `update(id, opts, userId?)` — filters by `user_id`
- `delete(id, userId?)` — filters by `user_id`
- `generateToken(id, userId?)` — filters by `user_id`
- `revokeToken(id, userId?)` — filters by `user_id`

Methods that stay unchanged (no userId needed):

- `getByUrl(url)` — internal uniqueness check
- `getByToken(token)` — inbound connection authentication
- `updateStatus(id, status)` — called by ReverseConnectManager internally

### SQLite Implementation (`sqlite.ts`)

Follow the `projects` pattern: build `ownerFilter` string conditionally, bind `@user_id` when present. Apply to SELECT, UPDATE, and DELETE statements.

Add `user_id: string` field to the `RemoteServerRow` type.

### Routes (`remote-server-routes.ts`)

Add `requireAuth(req, reply)` to every route handler. Pass `userId` to storage methods. Pattern identical to `project-routes.ts`:

```typescript
const userId = requireAuth(req, reply);
if (userId === null) return;
```

Route handlers that need updating:
- `GET /api/remote-servers` — getAll
- `POST /api/remote-servers` — create
- `PUT /api/remote-servers/:id` — getById + update
- `DELETE /api/remote-servers/:id` — delete
- `POST /api/remote-servers/:id/test` — getById
- `POST /api/remote-servers/:id/generate-token` — getById + generateToken
- `POST /api/remote-servers/:id/revoke-token` — getById + revokeToken
- `POST /api/remote-servers/:id/browse` — getById

### Frontend

No changes needed. Already uses `authFetch()` with Bearer token. Backend filtering handles isolation.

### Unaffected Systems

- **Reverse-connect WebSocket** (`/api/reverse-connect`): Authenticates by `connect_token`, not userId.
- **Remote proxy**: Authenticates by `x-vibedeckx-api-key` header, bypasses Clerk.
- **`project_remotes` table**: Indirectly isolated through project ownership.

## Auth-Disabled Behavior

When `--auth` is not set, `requireAuth()` returns `undefined`. Storage methods receive no userId and skip the `user_id` filter — all servers are visible to everyone. This matches the existing `projects` behavior.

Note: `requireAuth()` also returns `undefined` when a request carries `x-vibedeckx-api-key` (even with auth enabled). This means API-key-authenticated requests (remote proxy) see all servers regardless of user. This is intentional and consistent with the projects behavior.
