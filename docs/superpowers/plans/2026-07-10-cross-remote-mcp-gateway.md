# Cross-Remote MCP Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent running on remote A inspect and debug remote B (which has no agent installed) through a server-side MCP gateway, with per-remote off/read/exec access tiers and a persistent audit trail.

**Architecture:** The SaaS server exposes a stateless JSON-RPC MCP endpoint (`POST /api/cross-remote-mcp`). The `claude` process on remote A reaches it over plain HTTPS using a session-scoped HMAC token injected at spawn time via `--mcp-config`. The gateway authenticates the token, resolves the target remote's access tier, then forwards the tool call over the **existing** reverse-connect channel (`proxyToRemoteAuto`) to new `/api/path/cross-remote/*` routes on the target. The reverse-connect wire protocol is unchanged: to remote B this looks like any other server-initiated call.

**Tech Stack:** TypeScript (ESM, NodeNext — all local imports need `.js` extensions), Fastify 5, better-sqlite3 + Kysely, Vitest, Next.js 16 + shadcn/ui.

## Global Constraints

- Backend is ESM with NodeNext resolution: **every local import must carry a `.js` extension**.
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Tests: `pnpm --filter vibedeckx test` (Vitest). Storage tests build a real `Storage` over a temp-dir sqlite file via `createSqliteStorage`; there is no `:memory:` helper and no mock.
- Schema DDL and migrations are **raw better-sqlite3** (`db.exec`) inside `createDatabase()` in `storage/sqlite.ts`; all queries are **Kysely**. Column additions use the `PRAGMA table_info` guard idiom.
- Access tier values are exactly `'off' | 'read' | 'exec'`; column default `'off'`.
- Output caps: stdout and stderr each truncated at 65536 bytes. Default exec timeout 60s, max 300s.
- Per-session gateway concurrency cap: 4 in-flight calls.
- Token TTL backstop: 24h (`86400000` ms).
- The frontend keeps its **own** hand-maintained `RemoteServer` interface in `apps/vibedeckx-ui/lib/api.ts`; there is no shared/generated type. New fields must be added in both places.

## Deviations From The Spec (decided during codebase exploration)

These points contradict assumptions in `docs/superpowers/specs/2026-07-10-cross-remote-mcp-access-design.md`. Task 10 updates the spec to match.

1. **No MCP SDK dependency.** `packages/vibedeckx/package.json` has no `@modelcontextprotocol/sdk`. We hand-roll a stateless JSON-RPC 2.0 handler covering `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. That is the entire surface a Claude Code `type: "http"` MCP client needs, and it keeps auth/audit/tenant-scoping under our control with zero new deps.
2. **The server does not know its own public URL.** No `VIBEDECKX_PUBLIC_URL` or equivalent exists (`VIBEDECKX_UI_ORIGIN` is CORS-only). We introduce `VIBEDECKX_PUBLIC_URL`. **If it is unset, the feature is off**: no token is minted and no `--mcp-config` is injected.
3. **"Session alive" is really "session record exists"** for remote sessions. The server keeps no liveness bit for a session whose process runs on remote A (`remoteSessionMap` records routing only; the authoritative `processAlive` lives on the remote). A true liveness check would cost a proxy round-trip on every tool call. So the gateway checks: local sessions → `agentSessionManager.getSessionProcessAlive()`; remote sessions → `remoteSessionMap.has()` (rehydrated from `remoteSessionMappings` at boot, deleted when the session is deleted). Revocation therefore rests on three things: deleting the session, lowering the target's tier (checked live on every call), and the 24h token expiry.
4. **`createNewSession` must accept a caller-supplied session id.** Today it generates its own (`const sessionId = randomUUID()` at `agent-session-manager.ts:398`), and the server-side `localSessionId` is derived from the id the *remote* returns (`remote-${agentMode}-${projectId}-${remoteData.session.id}`, `remote-agent-sessions.ts:62`). That is a chicken-and-egg: the token binds `sessionId`, but it must travel **in** the spawn request, before any id comes back. Task 8 therefore adds an optional `sessionId` parameter so the server can pre-compute the id, mint the token, and only then call the remote.
5. **The feature requires an authenticated user.** `requireAuth` returns `undefined` in solo/no-auth mode. A token minted with an empty `userId` would make `remoteServers.getById(id, "")` fall through to the *unscoped* query (`if (userId) query = query.where(...)`), letting any tenant's remote resolve. So minting is skipped when there is no `userId`, and the token verifier rejects an empty `userId`/`sessionId`. In solo mode the feature is simply off.

## File Structure

**Backend — new files**
- `packages/vibedeckx/src/utils/one-shot-exec.ts` — `runOneShot()`: spawn a command, cap stdout/stderr bytes, kill on timeout. Used only by the target-side routes.
- `packages/vibedeckx/src/utils/one-shot-exec.test.ts`
- `packages/vibedeckx/src/utils/cross-remote-token.ts` — HMAC sign/verify + secret bootstrap via `storage.settings.getOrCreate`.
- `packages/vibedeckx/src/utils/cross-remote-token.test.ts`
- `packages/vibedeckx/src/cross-remote-access.ts` — tool→tier table, session check, target resolution, concurrency guard. Pure-ish logic, no HTTP.
- `packages/vibedeckx/src/cross-remote-access.test.ts`
- `packages/vibedeckx/src/routes/cross-remote-target-routes.ts` — the `/api/path/cross-remote/*` routes that run **on the target machine** (B).
- `packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts`
- `packages/vibedeckx/src/routes/cross-remote-mcp-routes.ts` — the gateway MCP endpoint that runs **on the SaaS server**.
- `packages/vibedeckx/src/routes/cross-remote-mcp-routes.test.ts`
- `packages/vibedeckx/src/storage/repositories/cross-remote-audit.ts` — audit repo.
- `packages/vibedeckx/src/storage/cross-remote-audit.test.ts`
- `packages/vibedeckx/src/storage/cross-remote-access.test.ts` — column migration + update() coverage.

**Backend — modified**
- `storage/sqlite.ts` — `cross_remote_access` column migration; `cross_remote_audit` table; wire the new repo.
- `storage/schema.ts` — `RemoteServersTable.cross_remote_access`; `CrossRemoteAuditTable`; register in `DB`.
- `storage/types.ts` — `CrossRemoteAccess`, `CrossRemoteAuditEntry`, `RemoteServer.cross_remote_access`, `remoteServers.update()` opts, `crossRemoteAudit` repo interface.
- `storage/repositories/remote-servers.ts` — `mapRemoteServer` + `update()`.
- `routes/remote-server-routes.ts` — PUT accepts `crossRemoteAccess`.
- `server.ts` — register the two new route files.
- `agent-session-manager.ts`, `agent-provider.ts`, `providers/claude-code-provider.ts`, `providers/codex-provider.ts`, `routes/agent-session-routes.ts`, `remote-agent-sessions.ts` — thread `crossRemoteMcp` from session creation down to spawn args.

**Frontend — modified**
- `apps/vibedeckx-ui/lib/api.ts` — `CrossRemoteAccess` type, `RemoteServer.cross_remote_access`, `updateRemoteServer` opts (+ fix a pre-existing response-shape bug).
- `apps/vibedeckx-ui/components/settings/remote-servers-settings.tsx` — three-level access `Select` per row.

**Task dependency order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Tasks 4 (target routes) and 3 (token) are independent of each other; everything from 5 onward depends on 1–4.

---

### Task 1: Storage — `cross_remote_access` column on `remote_servers`

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts:161-174`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (after the existing reverse-connect migration block at ~`:537-545`)
- Modify: `packages/vibedeckx/src/storage/repositories/remote-servers.ts:15-27` (`mapRemoteServer`) and `:105-123` (`update`)
- Test: `packages/vibedeckx/src/storage/cross-remote-access.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type CrossRemoteAccess = 'off' | 'read' | 'exec'` (from `storage/types.js`); `RemoteServer.cross_remote_access: CrossRemoteAccess`; `storage.remoteServers.update(id, { cross_remote_access?: CrossRemoteAccess, ... }, userId?)`.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/cross-remote-access.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("remote_servers.cross_remote_access", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xra-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 'off' on create", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
    expect(server.cross_remote_access).toBe("off");
  });

  it("round-trips 'read' and 'exec' through update", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });

    const readTier = await storage.remoteServers.update(server.id, { cross_remote_access: "read" });
    expect(readTier?.cross_remote_access).toBe("read");

    const execTier = await storage.remoteServers.update(server.id, { cross_remote_access: "exec" });
    expect(execTier?.cross_remote_access).toBe("exec");

    const reread = await storage.remoteServers.getById(server.id);
    expect(reread?.cross_remote_access).toBe("exec");
  });

  it("leaves the tier untouched when update omits it", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
    await storage.remoteServers.update(server.id, { cross_remote_access: "exec" });
    await storage.remoteServers.update(server.id, { name: "renamed" });

    const reread = await storage.remoteServers.getById(server.id);
    expect(reread?.name).toBe("renamed");
    expect(reread?.cross_remote_access).toBe("exec");
  });

  it("scopes updates by userId", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    const denied = await storage.remoteServers.update(server.id, { cross_remote_access: "exec" }, "user-2");
    expect(denied).toBeUndefined();

    const reread = await storage.remoteServers.getById(server.id, "user-1");
    expect(reread?.cross_remote_access).toBe("off");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-access`
Expected: FAIL — TypeScript/assertion error, `cross_remote_access` does not exist on `RemoteServer`.

- [ ] **Step 3: Add the type to `storage/types.ts`**

Above `export interface RemoteServer` (near line 11):

```ts
export type CrossRemoteAccess = 'off' | 'read' | 'exec';
```

Add the field to `RemoteServer` (after `last_connected_at?`):

```ts
  cross_remote_access: CrossRemoteAccess;
```

Extend the `update` signature in the `remoteServers` block (currently line 272):

```ts
    update(id: string, opts: { name?: string; url?: string; api_key?: string; connection_mode?: RemoteServerConnectionMode; cross_remote_access?: CrossRemoteAccess }, userId?: string): Promise<RemoteServer | undefined>;
```

- [ ] **Step 4: Add the column to `storage/schema.ts`**

In `RemoteServersTable` (after `last_connected_at: string | null;`):

```ts
  cross_remote_access: Generated<string>;
```

- [ ] **Step 5: Add the migration to `storage/sqlite.ts`**

Immediately after the existing reverse-connect migration block (the one guarded by `!remoteServerTableInfo.some(col => col.name === "connection_mode")`), append:

```ts
  // Migration: per-remote cross-remote access tier ('off' | 'read' | 'exec')
  const remoteServerAccessInfo = db.prepare("PRAGMA table_info(remote_servers)").all() as { name: string }[];
  if (!remoteServerAccessInfo.some(col => col.name === "cross_remote_access")) {
    db.exec("ALTER TABLE remote_servers ADD COLUMN cross_remote_access TEXT NOT NULL DEFAULT 'off'");
  }
```

Re-reading `PRAGMA table_info` into a fresh variable matters: the earlier block may have just added columns, and reusing `remoteServerTableInfo` would read a stale snapshot.

- [ ] **Step 6: Map the column in `repositories/remote-servers.ts`**

In `mapRemoteServer`, after `last_connected_at: row.last_connected_at ?? undefined,`:

```ts
  cross_remote_access: (row.cross_remote_access as CrossRemoteAccess) ?? "off",
```

Add `CrossRemoteAccess` to the type import block from `"../types.js"`.

In `update()`, after the `connection_mode` line:

```ts
      if (opts.cross_remote_access !== undefined) sets.cross_remote_access = opts.cross_remote_access;
```

- [ ] **Step 7: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-access && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 4 tests PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/storage/
git commit -m "feat(storage): add cross_remote_access tier to remote_servers"
```

---

### Task 2: Storage — `cross_remote_audit` table and repo

**Files:**
- Create: `packages/vibedeckx/src/storage/repositories/cross-remote-audit.ts`
- Modify: `packages/vibedeckx/src/storage/schema.ts`, `storage/types.ts`, `storage/sqlite.ts`
- Test: `packages/vibedeckx/src/storage/cross-remote-audit.test.ts`

**Interfaces:**
- Consumes: `CrossRemoteAccess` (Task 1) — not directly, but the same file.
- Produces:
  ```ts
  export type CrossRemoteAuditStatus = 'ok' | 'error' | 'timeout' | 'denied' | 'offline';
  export interface CrossRemoteAuditEntry {
    user_id: string;
    session_id: string;
    source_remote_id: string | null;
    target_remote_id: string;
    tool_name: string;
    args_summary: string;
    exit_code: number | null;
    duration_ms: number;
    status: CrossRemoteAuditStatus;
  }
  export interface CrossRemoteAuditRow extends CrossRemoteAuditEntry { id: string; created_at: string; }
  ```
  and `storage.crossRemoteAudit.insert(entry)` / `storage.crossRemoteAudit.listByTarget(targetRemoteId, limit?)`.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/cross-remote-audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage, CrossRemoteAuditEntry } from "./types.js";

const entry = (over: Partial<CrossRemoteAuditEntry> = {}): CrossRemoteAuditEntry => ({
  user_id: "user-1",
  session_id: "sess-1",
  source_remote_id: "srv-a",
  target_remote_id: "srv-b",
  tool_name: "remote_bash",
  args_summary: "uptime",
  exit_code: 0,
  duration_ms: 12,
  status: "ok",
  ...over,
});

describe("crossRemoteAudit storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xraudit-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and reads back an entry", async () => {
    await storage.crossRemoteAudit.insert(entry());
    const rows = await storage.crossRemoteAudit.listByTarget("srv-b");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      tool_name: "remote_bash",
      args_summary: "uptime",
      exit_code: 0,
      status: "ok",
    });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].created_at).toBeTruthy();
  });

  it("records denied calls with a null exit code and no source remote", async () => {
    await storage.crossRemoteAudit.insert(entry({ status: "denied", exit_code: null, source_remote_id: null }));
    const rows = await storage.crossRemoteAudit.listByTarget("srv-b");
    expect(rows[0].status).toBe("denied");
    expect(rows[0].exit_code).toBeNull();
    expect(rows[0].source_remote_id).toBeNull();
  });

  it("filters by target and returns newest first, honouring the limit", async () => {
    await storage.crossRemoteAudit.insert(entry({ args_summary: "first" }));
    await storage.crossRemoteAudit.insert(entry({ args_summary: "second" }));
    await storage.crossRemoteAudit.insert(entry({ target_remote_id: "srv-c", args_summary: "other-target" }));

    const rows = await storage.crossRemoteAudit.listByTarget("srv-b", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].args_summary).toBe("second");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-audit`
Expected: FAIL — `storage.crossRemoteAudit` is undefined.

- [ ] **Step 3: Add types to `storage/types.ts`**

Next to the `CrossRemoteAccess` type from Task 1:

```ts
export type CrossRemoteAuditStatus = 'ok' | 'error' | 'timeout' | 'denied' | 'offline';

export interface CrossRemoteAuditEntry {
  user_id: string;
  session_id: string;
  source_remote_id: string | null;
  target_remote_id: string;
  tool_name: string;
  args_summary: string;
  exit_code: number | null;
  duration_ms: number;
  status: CrossRemoteAuditStatus;
}

export interface CrossRemoteAuditRow extends CrossRemoteAuditEntry {
  id: string;
  created_at: string;
}
```

Add to the `Storage` interface, next to the `remoteServers` block:

```ts
  crossRemoteAudit: {
    insert(entry: CrossRemoteAuditEntry): Promise<void>;
    listByTarget(targetRemoteId: string, limit?: number): Promise<CrossRemoteAuditRow[]>;
  };
```

- [ ] **Step 4: Add the Kysely table to `storage/schema.ts`**

```ts
export interface CrossRemoteAuditTable {
  seq: Generated<number>;
  id: string;
  user_id: string;
  session_id: string;
  source_remote_id: string | null;
  target_remote_id: string;
  tool_name: string;
  args_summary: string;
  exit_code: number | null;
  duration_ms: number;
  status: string;
  created_at: string;
}
```

Register it in the `DB` interface:

```ts
  cross_remote_audit: CrossRemoteAuditTable;
```

- [ ] **Step 5: Add the DDL to `storage/sqlite.ts`**

Inside the big `db.exec(\`...\`)` template in `createDatabase`, alongside the other `CREATE TABLE IF NOT EXISTS` statements:

```sql
    CREATE TABLE IF NOT EXISTS cross_remote_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_remote_id TEXT,
      target_remote_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_summary TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cross_remote_audit_target ON cross_remote_audit(target_remote_id, seq);
```

Two shape decisions. No foreign key to `remote_servers`: audit rows must survive deletion of the remote they describe. And the monotonic `seq` is the sort key rather than `created_at`, because `datetime('now')` has one-second resolution — the "newest first" test inserts three rows in the same second and would be flaky ordering on a timestamp. `created_at` is written by the repo as a millisecond-precision ISO string for human reading.

- [ ] **Step 6: Write the repo**

Create `packages/vibedeckx/src/storage/repositories/cross-remote-audit.ts`:

```ts
import crypto from "crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, CrossRemoteAuditTable } from "../schema.js";
import type { Storage, CrossRemoteAuditRow, CrossRemoteAuditStatus } from "../types.js";

const mapRow = (row: Selectable<CrossRemoteAuditTable>): CrossRemoteAuditRow => ({
  id: row.id,
  user_id: row.user_id,
  session_id: row.session_id,
  source_remote_id: row.source_remote_id,
  target_remote_id: row.target_remote_id,
  tool_name: row.tool_name,
  args_summary: row.args_summary,
  exit_code: row.exit_code,
  duration_ms: row.duration_ms,
  status: row.status as CrossRemoteAuditStatus,
  created_at: row.created_at,
});

export const createCrossRemoteAuditRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "crossRemoteAudit"> => ({
  crossRemoteAudit: {
    insert: async (entry) => {
      await kdb
        .insertInto("cross_remote_audit")
        .values({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...entry })
        .execute();
    },

    listByTarget: async (targetRemoteId, limit = 100) => {
      const rows = await kdb
        .selectFrom("cross_remote_audit")
        .selectAll()
        .where("target_remote_id", "=", targetRemoteId)
        .orderBy("seq", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapRow);
    },
  },
});
```

- [ ] **Step 7: Wire the repo into `createSqliteStorage`**

In `storage/sqlite.ts`, import it and spread it alongside the existing repos:

```ts
import { createCrossRemoteAuditRepo } from "./repositories/cross-remote-audit.js";
```

```ts
    ...createCrossRemoteAuditRepo(kdb),
```

- [ ] **Step 8: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-audit && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 3 tests PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/storage/
git commit -m "feat(storage): add cross_remote_audit table and repository"
```

---

### Task 3: Session-scoped HMAC token

**Files:**
- Create: `packages/vibedeckx/src/utils/cross-remote-token.ts`
- Test: `packages/vibedeckx/src/utils/cross-remote-token.test.ts`

**Interfaces:**
- Consumes: `storage.settings.getOrCreate(key, factory)` from `storage/types.js`.
- Produces:
  ```ts
  export const CROSS_REMOTE_SECRET_SETTING = "cross_remote_token_secret";
  export const CROSS_REMOTE_TOKEN_TTL_MS = 86_400_000;
  export interface CrossRemoteTokenPayload {
    userId: string;
    sessionId: string;
    sourceRemoteServerId: string | null;
  }
  export function signCrossRemoteToken(secret: string, payload: CrossRemoteTokenPayload, nowMs: number, ttlMs?: number): string;
  export function verifyCrossRemoteToken(secret: string, token: string, nowMs: number): CrossRemoteTokenPayload | null;
  export function getCrossRemoteSecret(storage: Pick<Storage, "settings">): Promise<string>;
  ```

`nowMs` is an explicit parameter, not `Date.now()` inside the function, so expiry is testable without fake timers.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/utils/cross-remote-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  signCrossRemoteToken,
  verifyCrossRemoteToken,
  CROSS_REMOTE_TOKEN_TTL_MS,
  type CrossRemoteTokenPayload,
} from "./cross-remote-token.js";

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = 1_700_000_000_000;

const payload: CrossRemoteTokenPayload = {
  userId: "user-1",
  sessionId: "remote-abc",
  sourceRemoteServerId: "srv-a",
};

describe("cross-remote token", () => {
  it("round-trips a payload", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW)).toEqual(payload);
  });

  it("preserves a null sourceRemoteServerId", () => {
    const token = signCrossRemoteToken(SECRET, { ...payload, sourceRemoteServerId: null }, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW)?.sourceRemoteServerId).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken("other-secret", token, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    const [body, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
    decoded.u = "user-2";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;
    expect(verifyCrossRemoteToken(SECRET, forged, NOW)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW + CROSS_REMOTE_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("accepts a token one millisecond before expiry", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW + CROSS_REMOTE_TOKEN_TTL_MS - 1)).toEqual(payload);
  });

  it("rejects structurally invalid tokens", () => {
    expect(verifyCrossRemoteToken(SECRET, "", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "no-dot", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "a.b.c", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "!!!.###", NOW)).toBeNull();
  });

  it("rejects a token with an empty userId or sessionId", () => {
    // An empty userId would make remoteServers.getById(id, "") fall through to the
    // unscoped query, resolving any tenant's remote. Fail closed at verification.
    const noUser = signCrossRemoteToken(SECRET, { ...payload, userId: "" }, NOW);
    expect(verifyCrossRemoteToken(SECRET, noUser, NOW)).toBeNull();

    const noSession = signCrossRemoteToken(SECRET, { ...payload, sessionId: "" }, NOW);
    expect(verifyCrossRemoteToken(SECRET, noSession, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-token`
Expected: FAIL — cannot resolve `./cross-remote-token.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/vibedeckx/src/utils/cross-remote-token.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const CROSS_REMOTE_SECRET_SETTING = "cross_remote_token_secret";
export const CROSS_REMOTE_TOKEN_TTL_MS = 86_400_000; // 24h backstop; live checks do the real revocation

export interface CrossRemoteTokenPayload {
  userId: string;
  sessionId: string;
  /** null when the agent runs on the server itself rather than on a remote. */
  sourceRemoteServerId: string | null;
}

interface WirePayload {
  u: string;
  s: string;
  src: string | null;
  exp: number;
}

const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("base64url");

export function signCrossRemoteToken(
  secret: string,
  payload: CrossRemoteTokenPayload,
  nowMs: number,
  ttlMs: number = CROSS_REMOTE_TOKEN_TTL_MS,
): string {
  const wire: WirePayload = {
    u: payload.userId,
    s: payload.sessionId,
    src: payload.sourceRemoteServerId,
    exp: nowMs + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyCrossRemoteToken(
  secret: string,
  token: string,
  nowMs: number,
): CrossRemoteTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, providedSig] = parts;
  if (!body || !providedSig) return null;

  const expectedSig = sign(secret, body);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }

  if (typeof wire.u !== "string" || typeof wire.s !== "string" || typeof wire.exp !== "number") return null;
  if (wire.src !== null && typeof wire.src !== "string") return null;
  // An empty userId would make remoteServers.getById(id, "") run unscoped and resolve
  // any tenant's remote. Fail closed rather than rely on every caller to check.
  if (!wire.u || !wire.s) return null;
  if (nowMs >= wire.exp) return null;

  return { userId: wire.u, sessionId: wire.s, sourceRemoteServerId: wire.src };
}

/** Bootstraps a persistent signing secret, mirroring the reverse-connect machine-key pattern. */
export async function getCrossRemoteSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(CROSS_REMOTE_SECRET_SETTING, () =>
    randomBytes(32).toString("hex"),
  );
}
```

Signature comparison runs before `JSON.parse` so unauthenticated input never reaches the parser, and `timingSafeEqual` needs the length guard because it throws on mismatched buffers.

- [ ] **Step 4: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-token && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 8 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/utils/cross-remote-token.ts packages/vibedeckx/src/utils/cross-remote-token.test.ts
git commit -m "feat: add session-scoped HMAC token for cross-remote access"
```

---

### Task 4: Target-side routes (`/api/path/cross-remote/*`)

These run on remote B. The `/api/path/` prefix is already in `REMOTE_PROVIDER_PREFIXES` (`server.ts:76`), so they are automatically 404'd unless the machine was started with `--accept-remote`, and automatically covered by the global `x-vibedeckx-api-key` hook (`server.ts:185-205`). No new auth mechanism.

**Files:**
- Create: `packages/vibedeckx/src/utils/one-shot-exec.ts`
- Create: `packages/vibedeckx/src/utils/one-shot-exec.test.ts`
- Create: `packages/vibedeckx/src/routes/cross-remote-target-routes.ts`
- Create: `packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts`
- Modify: `packages/vibedeckx/src/server.ts` (register the plugin)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const MAX_OUTPUT_BYTES = 65536;
  export interface OneShotResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; }
  export function runOneShot(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<OneShotResult>;
  ```
  HTTP contract consumed by Task 6:
  - `POST /api/path/cross-remote/exec` `{ command, cwd?, timeoutSec? }` → `OneShotResult`
  - `POST /api/path/cross-remote/read-file` `{ path, offset?, limit? }` → `{ content: string; truncated: boolean; size: number }`
  - `POST /api/path/cross-remote/list-dir` `{ path }` → `{ entries: Array<{ name: string; type: 'file' | 'dir' | 'other' }> }`
  - `POST /api/path/cross-remote/stat` `{ path }` → `{ type: 'file' | 'dir' | 'other'; size: number; mtime: string; mode: string }`
  - `POST /api/path/cross-remote/process-list` `{}` → `OneShotResult`
  All error responses are `{ error: string }` with a 4xx/5xx status.

- [ ] **Step 1: Write the failing test for `runOneShot`**

Create `packages/vibedeckx/src/utils/one-shot-exec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runOneShot, MAX_OUTPUT_BYTES } from "./one-shot-exec.js";

describe("runOneShot", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runOneShot("echo hello", { timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runOneShot("echo oops >&2; exit 3", { timeoutMs: 5000 });
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(3);
  });

  it("runs in the given cwd", async () => {
    const result = await runOneShot("pwd", { cwd: "/tmp", timeoutMs: 5000 });
    expect(result.stdout.trim()).toContain("tmp");
  });

  it("kills the process on timeout and reports timedOut", async () => {
    const result = await runOneShot("sleep 5", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("truncates output beyond the cap and keeps the process from hanging", async () => {
    const result = await runOneShot(`head -c ${MAX_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' 'x'`, { timeoutMs: 10000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- one-shot-exec`
Expected: FAIL — cannot resolve `./one-shot-exec.js`.

- [ ] **Step 3: Implement `runOneShot`**

Create `packages/vibedeckx/src/utils/one-shot-exec.ts`:

```ts
import { spawn } from "child_process";

export const MAX_OUTPUT_BYTES = 65536;

export interface OneShotResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Runs a shell command to completion, capping each stream at MAX_OUTPUT_BYTES and
 * killing the process group on timeout. Unlike child_process.exec's maxBuffer, hitting
 * the cap does not discard what was already captured.
 */
export function runOneShot(
  command: string,
  opts: { cwd?: string; timeoutMs: number },
): Promise<OneShotResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      detached: true, // own process group, so the kill below reaches grandchildren
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr") => (data: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - sizes[stream];
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (data.length > remaining) {
        chunks[stream].push(data.subarray(0, remaining));
        sizes[stream] = MAX_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      chunks[stream].push(data);
      sizes[stream] += data.length;
    };

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        exitCode,
        timedOut,
        truncated,
      });
    };

    child.on("close", (code) => settle(timedOut ? (code ?? 124) : code));
    child.on("error", (err) => {
      chunks.stderr.push(Buffer.from(String(err)));
      settle(127);
    });
  });
}
```

`detached: true` plus `process.kill(-pid)` is what stops `sleep 5` from outliving the timeout when the shell has forked a child. The truncation test's pipeline would deadlock on a `maxBuffer` implementation; here the writer just gets its output dropped and exits.

- [ ] **Step 4: Run the `runOneShot` tests**

Run: `pnpm --filter vibedeckx test -- one-shot-exec`
Expected: 5 tests PASS.

- [ ] **Step 5: Write the failing test for the routes**

Create `packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import crossRemoteTargetRoutes from "./cross-remote-target-routes.js";

describe("cross-remote target routes", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-target-"));
    writeFileSync(path.join(dir, "hello.txt"), "hello world");
    mkdirSync(path.join(dir, "sub"));
    app = Fastify();
    await app.register(crossRemoteTargetRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

  it("exec runs a command", async () => {
    const res = await post("/api/path/cross-remote/exec", { command: "echo hi", cwd: dir });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout.trim()).toBe("hi");
    expect(res.json().exitCode).toBe(0);
  });

  it("exec rejects a missing command", async () => {
    const res = await post("/api/path/cross-remote/exec", { cwd: dir });
    expect(res.statusCode).toBe(400);
  });

  it("exec clamps an oversized timeout", async () => {
    const res = await post("/api/path/cross-remote/exec", { command: "echo hi", timeoutSec: 99999 });
    expect(res.statusCode).toBe(200);
  });

  it("read-file returns contents", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "hello.txt") });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("hello world");
    expect(res.json().truncated).toBe(false);
  });

  it("read-file honours offset and limit", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "hello.txt"), offset: 6, limit: 5 });
    expect(res.json().content).toBe("world");
  });

  it("read-file 404s on a missing file", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "nope.txt") });
    expect(res.statusCode).toBe(404);
  });

  it("read-file rejects a relative path", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: "relative/x.txt" });
    expect(res.statusCode).toBe(400);
  });

  it("list-dir lists entries with types", async () => {
    const res = await post("/api/path/cross-remote/list-dir", { path: dir });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{ name: string; type: string }>;
    expect(entries).toContainEqual({ name: "hello.txt", type: "file" });
    expect(entries).toContainEqual({ name: "sub", type: "dir" });
  });

  it("stat reports a file", async () => {
    const res = await post("/api/path/cross-remote/stat", { path: path.join(dir, "hello.txt") });
    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe("file");
    expect(res.json().size).toBe(11);
  });

  it("process-list returns output", async () => {
    const res = await post("/api/path/cross-remote/process-list", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-target-routes`
Expected: FAIL — cannot resolve `./cross-remote-target-routes.js`.

- [ ] **Step 7: Implement the routes**

Create `packages/vibedeckx/src/routes/cross-remote-target-routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { promises as fs } from "fs";
import { runOneShot, MAX_OUTPUT_BYTES } from "../utils/one-shot-exec.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;
const PROCESS_LIST_COMMAND = "ps -eo pid,ppid,user,pcpu,pmem,etime,args";

type EntryType = "file" | "dir" | "other";

const entryType = (isFile: boolean, isDir: boolean): EntryType =>
  isDir ? "dir" : isFile ? "file" : "other";

const clampTimeoutMs = (timeoutSec: unknown): number => {
  const requested = typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
    ? timeoutSec
    : DEFAULT_TIMEOUT_SEC;
  return Math.min(requested, MAX_TIMEOUT_SEC) * 1000;
};

/**
 * Routes invoked on a *target* machine by the SaaS server's cross-remote MCP gateway.
 * The /api/path/ prefix puts them behind the --accept-remote gate and the global
 * x-vibedeckx-api-key hook, exactly like the other server-invoked remote routes.
 */
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { command?: string; cwd?: string; timeoutSec?: number } }>(
    "/api/path/cross-remote/exec",
    async (request, reply) => {
      const { command, cwd, timeoutSec } = request.body ?? {};
      if (!command || typeof command !== "string") {
        return reply.code(400).send({ error: "command is required" });
      }
      if (cwd !== undefined && !path.isAbsolute(cwd)) {
        return reply.code(400).send({ error: "cwd must be an absolute path" });
      }
      const result = await runOneShot(command, { cwd, timeoutMs: clampTimeoutMs(timeoutSec) });
      return reply.send(result);
    },
  );

  fastify.post<{ Body: { path?: string; offset?: number; limit?: number } }>(
    "/api/path/cross-remote/read-file",
    async (request, reply) => {
      const { path: filePath, offset = 0, limit = MAX_OUTPUT_BYTES } = request.body ?? {};
      if (!filePath || !path.isAbsolute(filePath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return reply.code(400).send({ error: "path is not a file" });

        const cap = Math.min(limit, MAX_OUTPUT_BYTES);
        const buffer = await fs.readFile(filePath);
        const slice = buffer.subarray(offset, offset + cap);
        return reply.send({
          content: slice.toString("utf8"),
          truncated: offset + slice.length < buffer.length,
          size: stat.size,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "file not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        return reply.code(500).send({ error: "failed to read file" });
      }
    },
  );

  fastify.post<{ Body: { path?: string } }>(
    "/api/path/cross-remote/list-dir",
    async (request, reply) => {
      const dirPath = request.body?.path;
      if (!dirPath || !path.isAbsolute(dirPath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const dirents = await fs.readdir(dirPath, { withFileTypes: true });
        return reply.send({
          entries: dirents.map((d) => ({ name: d.name, type: entryType(d.isFile(), d.isDirectory()) })),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "directory not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        if (code === "ENOTDIR") return reply.code(400).send({ error: "path is not a directory" });
        return reply.code(500).send({ error: "failed to list directory" });
      }
    },
  );

  fastify.post<{ Body: { path?: string } }>(
    "/api/path/cross-remote/stat",
    async (request, reply) => {
      const targetPath = request.body?.path;
      if (!targetPath || !path.isAbsolute(targetPath)) {
        return reply.code(400).send({ error: "path must be an absolute path" });
      }
      try {
        const stat = await fs.stat(targetPath);
        return reply.send({
          type: entryType(stat.isFile(), stat.isDirectory()),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reply.code(404).send({ error: "path not found" });
        if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
        return reply.code(500).send({ error: "failed to stat path" });
      }
    },
  );

  fastify.post("/api/path/cross-remote/process-list", async (_request, reply) => {
    const result = await runOneShot(PROCESS_LIST_COMMAND, { timeoutMs: 15_000 });
    return reply.send(result);
  });
};

export default fp(routes, { name: "cross-remote-target-routes" });
```

- [ ] **Step 8: Register the plugin in `server.ts`**

Next to the other `server.register(...)` route calls:

```ts
import crossRemoteTargetRoutes from "./routes/cross-remote-target-routes.js";
```

```ts
  server.register(crossRemoteTargetRoutes);
```

- [ ] **Step 9: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-target-routes one-shot-exec && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 15 tests PASS, tsc clean.

- [ ] **Step 10: Commit**

```bash
git add packages/vibedeckx/src/utils/one-shot-exec.ts packages/vibedeckx/src/utils/one-shot-exec.test.ts packages/vibedeckx/src/routes/cross-remote-target-routes.ts packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat: add cross-remote target routes for exec and read-only diagnostics"
```

---

### Task 5: Gateway core logic — tiers, session check, target resolution, concurrency

Pure logic, separated from HTTP so it can be tested without a Fastify instance.

**Files:**
- Create: `packages/vibedeckx/src/cross-remote-access.ts`
- Create: `packages/vibedeckx/src/cross-remote-access.test.ts`

**Interfaces:**
- Consumes: `CrossRemoteAccess`, `RemoteServer` (Task 1); `CrossRemoteTokenPayload` (Task 3).
- Produces:
  ```ts
  export const CROSS_REMOTE_MCP_PATH = "/api/cross-remote-mcp";
  export type CrossRemoteTier = 'read' | 'exec';
  export const TOOL_TIERS: Record<string, CrossRemoteTier>;   // keys are the 5 tool names
  export interface AccessDeps {
    storage: Pick<Storage, "remoteServers">;
    reverseConnectManager: { isConnected(remoteServerId: string): boolean };
    remoteSessionMap: Map<string, unknown>;
    agentSessionManager: { getSessionProcessAlive(sessionId: string): boolean };
  }
  export function isSessionUsable(deps: AccessDeps, sessionId: string): boolean;
  export type ResolveResult =
    | { ok: true; server: RemoteServer }
    | { ok: false; reason: 'not_accessible' | 'offline' };
  export function resolveTarget(deps: AccessDeps, payload: CrossRemoteTokenPayload, targetRemoteId: string, requiredTier: CrossRemoteTier): Promise<ResolveResult>;
  export function listAccessibleRemotes(deps: AccessDeps, payload: CrossRemoteTokenPayload): Promise<Array<{ id: string; name: string; access: CrossRemoteAccess; online: boolean }>>;
  export class SessionConcurrencyGuard {
    constructor(maxInFlight?: number);
    acquire(sessionId: string): boolean;
    release(sessionId: string): void;
  }
  ```

`AccessDeps` is a structural subset of `FastifyInstance`, so Task 6 passes `fastify` straight in and tests pass a hand-built object.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/cross-remote-access.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  isSessionUsable,
  resolveTarget,
  listAccessibleRemotes,
  SessionConcurrencyGuard,
  TOOL_TIERS,
  type AccessDeps,
} from "./cross-remote-access.js";
import type { CrossRemoteTokenPayload } from "./utils/cross-remote-token.js";

describe("cross-remote access", () => {
  let dir: string;
  let storage: Storage;
  let connected: Set<string>;
  let aliveLocal: Set<string>;
  let deps: AccessDeps;

  const payload = (over: Partial<CrossRemoteTokenPayload> = {}): CrossRemoteTokenPayload => ({
    userId: "user-1",
    sessionId: "sess-1",
    sourceRemoteServerId: "srv-a",
    ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xracc-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    connected = new Set();
    aliveLocal = new Set();
    deps = {
      storage,
      reverseConnectManager: { isConnected: (id) => connected.has(id) },
      remoteSessionMap: new Map(),
      agentSessionManager: { getSessionProcessAlive: (id) => aliveLocal.has(id) },
    };
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps every tool to a tier", () => {
    expect(TOOL_TIERS).toEqual({
      remote_read_file: "read",
      remote_list_dir: "read",
      remote_stat_path: "read",
      remote_process_list: "read",
      remote_bash: "exec",
    });
  });

  describe("isSessionUsable", () => {
    it("accepts a live local session", () => {
      aliveLocal.add("sess-1");
      expect(isSessionUsable(deps, "sess-1")).toBe(true);
    });

    it("rejects a dead local session", () => {
      expect(isSessionUsable(deps, "sess-1")).toBe(false);
    });

    it("accepts a known remote session", () => {
      deps.remoteSessionMap.set("remote-xyz", {});
      expect(isSessionUsable(deps, "remote-xyz")).toBe(true);
    });

    it("rejects an unknown remote session", () => {
      expect(isSessionUsable(deps, "remote-gone")).toBe(false);
    });
  });

  describe("resolveTarget", () => {
    it("resolves an online outbound target at the read tier", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result.ok).toBe(true);
    });

    it("denies a read-tier target for an exec-tier tool", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("allows an exec-tier target for a read-tier tool", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result.ok).toBe(true);
    });

    it("denies a target left at the default 'off' tier", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      const result = await resolveTarget(deps, payload(), b.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies a target owned by another user", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-2");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-2");

      const result = await resolveTarget(deps, payload({ userId: "user-1" }), b.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies the source remote targeting itself", async () => {
      const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
      await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload({ sourceRemoteServerId: a.id }), a.id, "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("denies an unknown remote id", async () => {
      const result = await resolveTarget(deps, payload(), "does-not-exist", "read");
      expect(result).toEqual({ ok: false, reason: "not_accessible" });
    });

    it("reports an inbound target that is not connected as offline", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: null, connection_mode: "inbound" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result).toEqual({ ok: false, reason: "offline" });
    });

    it("resolves an inbound target once it is connected", async () => {
      const b = await storage.remoteServers.create({ name: "b", url: null, connection_mode: "inbound" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");
      connected.add(b.id);

      const result = await resolveTarget(deps, payload(), b.id, "exec");
      expect(result.ok).toBe(true);
    });
  });

  describe("listAccessibleRemotes", () => {
    it("returns opted-in remotes, excluding the source and 'off' remotes", async () => {
      const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
      const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      const c = await storage.remoteServers.create({ name: "c", url: "http://c:5173" }, "user-1");
      await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");
      await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");
      // c stays 'off'

      const list = await listAccessibleRemotes(deps, payload({ sourceRemoteServerId: a.id }));
      expect(list).toEqual([{ id: b.id, name: "b", access: "read", online: true }]);
      expect(list.find((r) => r.id === c.id)).toBeUndefined();
    });

    it("returns nothing for a user with no opted-in remotes", async () => {
      await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
      expect(await listAccessibleRemotes(deps, payload())).toEqual([]);
    });
  });

  describe("SessionConcurrencyGuard", () => {
    it("allows up to the cap and rejects beyond it", () => {
      const guard = new SessionConcurrencyGuard(2);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
    });

    it("frees a slot on release", () => {
      const guard = new SessionConcurrencyGuard(1);
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
      guard.release("s");
      expect(guard.acquire("s")).toBe(true);
    });

    it("counts sessions independently", () => {
      const guard = new SessionConcurrencyGuard(1);
      expect(guard.acquire("s1")).toBe(true);
      expect(guard.acquire("s2")).toBe(true);
    });

    it("never drops below zero on an unbalanced release", () => {
      const guard = new SessionConcurrencyGuard(1);
      guard.release("s");
      expect(guard.acquire("s")).toBe(true);
      expect(guard.acquire("s")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-access.test`
Expected: FAIL — cannot resolve `./cross-remote-access.js`.

- [ ] **Step 3: Implement the module**

Create `packages/vibedeckx/src/cross-remote-access.ts`:

```ts
import type { Storage, RemoteServer, CrossRemoteAccess } from "./storage/types.js";
import type { CrossRemoteTokenPayload } from "./utils/cross-remote-token.js";

/**
 * Lives here rather than in the route file: both the route and cross-remote-mcp-config
 * need it, and this module imports neither of them — that keeps the dependency acyclic
 * and keeps the Fastify route out of the provider's import graph on the remote.
 */
export const CROSS_REMOTE_MCP_PATH = "/api/cross-remote-mcp";

export type CrossRemoteTier = "read" | "exec";

export const TOOL_TIERS: Record<string, CrossRemoteTier> = {
  remote_read_file: "read",
  remote_list_dir: "read",
  remote_stat_path: "read",
  remote_process_list: "read",
  remote_bash: "exec",
};

export const MAX_IN_FLIGHT_PER_SESSION = 4;

/** Structural subset of FastifyInstance, so the gateway route can pass `fastify` directly. */
export interface AccessDeps {
  storage: Pick<Storage, "remoteServers">;
  reverseConnectManager: { isConnected(remoteServerId: string): boolean };
  remoteSessionMap: Map<string, unknown>;
  agentSessionManager: { getSessionProcessAlive(sessionId: string): boolean };
}

const tierSatisfies = (granted: CrossRemoteAccess, required: CrossRemoteTier): boolean =>
  granted === "exec" || (granted === "read" && required === "read");

const isOnline = (deps: AccessDeps, server: RemoteServer): boolean =>
  server.connection_mode === "inbound"
    ? deps.reverseConnectManager.isConnected(server.id)
    : !!server.url;

/**
 * True when the session that minted this token still exists.
 *
 * For local sessions this is a real liveness check. For remote sessions the server
 * holds no liveness bit — the process runs on the source remote — so this checks that
 * the session mapping still exists (rehydrated from storage at boot, removed on delete).
 * Tier changes and the token's 24h expiry are the other revocation levers.
 */
export function isSessionUsable(deps: AccessDeps, sessionId: string): boolean {
  if (sessionId.startsWith("remote-")) return deps.remoteSessionMap.has(sessionId);
  return deps.agentSessionManager.getSessionProcessAlive(sessionId);
}

export type ResolveResult =
  | { ok: true; server: RemoteServer }
  | { ok: false; reason: "not_accessible" | "offline" };

export async function resolveTarget(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
  targetRemoteId: string,
  requiredTier: CrossRemoteTier,
): Promise<ResolveResult> {
  if (payload.sourceRemoteServerId && payload.sourceRemoteServerId === targetRemoteId) {
    return { ok: false, reason: "not_accessible" };
  }

  const server = await deps.storage.remoteServers.getById(targetRemoteId, payload.userId);
  if (!server) return { ok: false, reason: "not_accessible" };
  if (!tierSatisfies(server.cross_remote_access, requiredTier)) {
    return { ok: false, reason: "not_accessible" };
  }
  if (!isOnline(deps, server)) return { ok: false, reason: "offline" };

  return { ok: true, server };
}

export async function listAccessibleRemotes(
  deps: AccessDeps,
  payload: CrossRemoteTokenPayload,
): Promise<Array<{ id: string; name: string; access: CrossRemoteAccess; online: boolean }>> {
  const servers = await deps.storage.remoteServers.getAll(payload.userId);
  return servers
    .filter((s) => s.cross_remote_access !== "off")
    .filter((s) => s.id !== payload.sourceRemoteServerId)
    .map((s) => ({ id: s.id, name: s.name, access: s.cross_remote_access, online: isOnline(deps, s) }));
}

export class SessionConcurrencyGuard {
  private inFlight = new Map<string, number>();

  constructor(private readonly maxInFlight: number = MAX_IN_FLIGHT_PER_SESSION) {}

  acquire(sessionId: string): boolean {
    const current = this.inFlight.get(sessionId) ?? 0;
    if (current >= this.maxInFlight) return false;
    this.inFlight.set(sessionId, current + 1);
    return true;
  }

  release(sessionId: string): void {
    const current = this.inFlight.get(sessionId) ?? 0;
    if (current <= 1) this.inFlight.delete(sessionId);
    else this.inFlight.set(sessionId, current - 1);
  }
}
```

Note `resolveTarget` passes `payload.userId` into `getById` as the scoping argument, so a target belonging to another user is indistinguishable from one that does not exist — that is the "do not leak existence" requirement, enforced by the storage query rather than by a separate check.

- [ ] **Step 4: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-access.test && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 20 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/cross-remote-access.ts packages/vibedeckx/src/cross-remote-access.test.ts
git commit -m "feat: add cross-remote access tiers, session check and concurrency guard"
```

---

### Task 6: The gateway MCP endpoint

A stateless JSON-RPC 2.0 handler at `POST /api/cross-remote-mcp`. Auth is the bearer token from Task 3 — **not** `requireAuth`, because the caller is a `claude` process, not a browser session.

**Files:**
- Create: `packages/vibedeckx/src/routes/cross-remote-mcp-routes.ts`
- Create: `packages/vibedeckx/src/routes/cross-remote-mcp-routes.test.ts`
- Modify: `packages/vibedeckx/src/server.ts` (register)

**Interfaces:**
- Consumes: `signCrossRemoteToken`/`verifyCrossRemoteToken`/`getCrossRemoteSecret` (Task 3); `CROSS_REMOTE_MCP_PATH`, `TOOL_TIERS`, `isSessionUsable`, `resolveTarget`, `listAccessibleRemotes`, `SessionConcurrencyGuard` (Task 5); `storage.crossRemoteAudit.insert` (Task 2); the target HTTP contract (Task 4); `proxyToRemoteAuto` from `utils/remote-proxy.js`.
- Produces: the default Fastify plugin.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/routes/cross-remote-mcp-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { signCrossRemoteToken, getCrossRemoteSecret } from "../utils/cross-remote-token.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import crossRemoteMcpRoutes from "./cross-remote-mcp-routes.js";

describe("cross-remote MCP gateway", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let secret: string;
  let targetId: string;

  const rpc = (token: string | null, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/cross-remote-mcp",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  const tokenFor = (over: { userId?: string; sessionId?: string; sourceRemoteServerId?: string | null } = {}) =>
    signCrossRemoteToken(
      secret,
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: "srv-a", ...over },
      Date.now(),
    );

  const call = (token: string, name: string, args: Record<string, unknown>) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xrmcp-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    secret = await getCrossRemoteSecret(storage);

    const target = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    targetId = target.id;
    await storage.remoteServers.update(targetId, { cross_remote_access: "exec" }, "user-1");

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    app.decorate("remoteSessionMap", new Map());
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => true } as never);
    await app.register(crossRemoteMcpRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a request with no token", async () => {
    const res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged token", async () => {
    const forged = signCrossRemoteToken("wrong-secret", { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null }, Date.now());
    const res = await rpc(forged, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token whose session no longer exists", async () => {
    app.agentSessionManager.getSessionProcessAlive = () => false;
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
  });

  it("answers initialize with protocol and server info", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.serverInfo.name).toBe("vibedeckx-cross-remote");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("returns 202 with no body for the initialized notification", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.statusCode).toBe(202);
  });

  it("lists all six tools", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.json().result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "list_accessible_remotes",
      "remote_bash",
      "remote_list_dir",
      "remote_process_list",
      "remote_read_file",
      "remote_stat_path",
    ]);
  });

  it("returns a JSON-RPC error for an unknown method", async () => {
    const res = await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "nope" });
    expect(res.json().error.code).toBe(-32601);
  });

  it("list_accessible_remotes excludes the source remote", async () => {
    const source = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
    await storage.remoteServers.update(source.id, { cross_remote_access: "exec" }, "user-1");

    const res = await call(tokenFor({ sourceRemoteServerId: source.id }), "list_accessible_remotes", {});
    const text = res.json().result.content[0].text;
    expect(text).toContain(targetId);
    expect(text).not.toContain(source.id);
  });

  it("forwards remote_bash to the target and returns its output", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { stdout: "linux\n", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uname" });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.content[0].text).toContain("linux");

    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      targetId,
      "http://b:5173",
      "",
      "POST",
      "/api/path/cross-remote/exec",
      { command: "uname", cwd: undefined, timeoutSec: undefined },
      expect.anything(),
    );
  });

  it("writes an audit row for a successful call", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      session_id: "sess-1",
      source_remote_id: "srv-a",
      tool_name: "remote_bash",
      args_summary: "uptime",
      exit_code: 0,
      status: "ok",
    });
  });

  it("denies remote_bash against a read-tier target and audits the denial", async () => {
    await storage.remoteServers.update(targetId, { cross_remote_access: "read" }, "user-1");

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "rm -rf /" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("not found or not accessible");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].exit_code).toBeNull();
  });

  it("allows a read-tier tool against a read-tier target", async () => {
    await storage.remoteServers.update(targetId, { cross_remote_access: "read" }, "user-1");
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { content: "log line", truncated: false, size: 8 } });

    const res = await call(tokenFor(), "remote_read_file", { remoteId: targetId, path: "/var/log/app.log" });
    expect(res.json().result.isError).toBeUndefined();
    expect(res.json().result.content[0].text).toContain("log line");
  });

  it("denies a target owned by another user without leaking existence", async () => {
    const other = await storage.remoteServers.create({ name: "other", url: "http://o:5173" }, "user-2");
    await storage.remoteServers.update(other.id, { cross_remote_access: "exec" }, "user-2");

    const res = await call(tokenFor(), "remote_bash", { remoteId: other.id, command: "id" });
    expect(res.json().result.content[0].text).toContain("not found or not accessible");
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("reports an offline target and audits it", async () => {
    const inbound = await storage.remoteServers.create({ name: "c", url: null, connection_mode: "inbound" }, "user-1");
    await storage.remoteServers.update(inbound.id, { cross_remote_access: "exec" }, "user-1");

    const res = await call(tokenFor(), "remote_bash", { remoteId: inbound.id, command: "uptime" });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("offline");

    const rows = await storage.crossRemoteAudit.listByTarget(inbound.id);
    expect(rows[0].status).toBe("offline");
  });

  it("surfaces a proxy failure as a tool error", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: { error: "boom" }, errorCode: "network_error" });

    const res = await call(tokenFor(), "remote_bash", { remoteId: targetId, command: "uptime" });
    expect(res.json().result.isError).toBe(true);

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].status).toBe("error");
  });

  it("rejects a tool call missing remoteId", async () => {
    const res = await call(tokenFor(), "remote_bash", { command: "uptime" });
    expect(res.json().result.isError).toBe(true);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool name", async () => {
    const res = await call(tokenFor(), "remote_launch_missiles", { remoteId: targetId });
    expect(res.json().result.isError).toBe(true);
  });

  it("truncates args_summary at 1KB", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200,
      data: { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false },
    });
    const long = "x".repeat(3000);
    await call(tokenFor(), "remote_bash", { remoteId: targetId, command: long });

    const rows = await storage.crossRemoteAudit.listByTarget(targetId);
    expect(rows[0].args_summary.length).toBe(1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-mcp-routes`
Expected: FAIL — cannot resolve `./cross-remote-mcp-routes.js`.

- [ ] **Step 3: Implement the gateway**

Create `packages/vibedeckx/src/routes/cross-remote-mcp-routes.ts`:

```ts
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { getCrossRemoteSecret, verifyCrossRemoteToken, type CrossRemoteTokenPayload } from "../utils/cross-remote-token.js";
import {
  CROSS_REMOTE_MCP_PATH,
  TOOL_TIERS,
  isSessionUsable,
  resolveTarget,
  listAccessibleRemotes,
  SessionConcurrencyGuard,
  type AccessDeps,
} from "../cross-remote-access.js";
import type { CrossRemoteAuditStatus } from "../storage/types.js";
import "../server-types.js";

const PROTOCOL_VERSION = "2024-11-05";
const AUDIT_ARGS_MAX = 1024;
const NOT_ACCESSIBLE = "remote not found or not accessible";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const REMOTE_ID_PROP = {
  remoteId: { type: "string", description: "Target remote server id from list_accessible_remotes" },
} as const;

const TOOLS = [
  {
    name: "list_accessible_remotes",
    description: "List the remote machines this agent may access, with their access tier and online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "remote_read_file",
    description: "Read a file on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REMOTE_ID_PROP,
        path: { type: "string", description: "Absolute path of the file" },
        offset: { type: "number", description: "Byte offset to start from" },
        limit: { type: "number", description: "Maximum bytes to read (capped at 65536)" },
      },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_list_dir",
    description: "List a directory on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: { ...REMOTE_ID_PROP, path: { type: "string", description: "Absolute directory path" } },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_stat_path",
    description: "Stat a file or directory on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: { ...REMOTE_ID_PROP, path: { type: "string", description: "Absolute path" } },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_process_list",
    description: "List running processes on a target remote machine. Requires 'read' access.",
    inputSchema: { type: "object", properties: { ...REMOTE_ID_PROP }, required: ["remoteId"] },
  },
  {
    name: "remote_bash",
    description: "Run a shell command on a target remote machine. Requires 'exec' access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REMOTE_ID_PROP,
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Absolute working directory" },
        timeoutSec: { type: "number", description: "Timeout in seconds (default 60, max 300)" },
      },
      required: ["remoteId", "command"],
    },
  },
];

/** Maps a tool call onto the target-side route and body. Returns null when args are invalid. */
function buildTargetCall(
  toolName: string,
  args: Record<string, unknown>,
): { path: string; body: Record<string, unknown>; summary: string } | null {
  const remoteId = args.remoteId;
  if (typeof remoteId !== "string" || !remoteId) return null;

  switch (toolName) {
    case "remote_bash": {
      if (typeof args.command !== "string" || !args.command) return null;
      return {
        path: "/api/path/cross-remote/exec",
        body: { command: args.command, cwd: args.cwd, timeoutSec: args.timeoutSec },
        summary: args.command,
      };
    }
    case "remote_read_file": {
      if (typeof args.path !== "string" || !args.path) return null;
      return {
        path: "/api/path/cross-remote/read-file",
        body: { path: args.path, offset: args.offset, limit: args.limit },
        summary: args.path,
      };
    }
    case "remote_list_dir": {
      if (typeof args.path !== "string" || !args.path) return null;
      return { path: "/api/path/cross-remote/list-dir", body: { path: args.path }, summary: args.path };
    }
    case "remote_stat_path": {
      if (typeof args.path !== "string" || !args.path) return null;
      return { path: "/api/path/cross-remote/stat", body: { path: args.path }, summary: args.path };
    }
    case "remote_process_list":
      return { path: "/api/path/cross-remote/process-list", body: {}, summary: "ps" };
    default:
      return null;
  }
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const routes: FastifyPluginAsync = async (fastify) => {
  const guard = new SessionConcurrencyGuard();

  const authenticate = async (request: FastifyRequest): Promise<CrossRemoteTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    const secret = await getCrossRemoteSecret(fastify.storage);
    const payload = verifyCrossRemoteToken(secret, header.slice("Bearer ".length), Date.now());
    if (!payload) return null;
    if (!isSessionUsable(fastify as unknown as AccessDeps, payload.sessionId)) return null;
    return payload;
  };

  const audit = async (
    payload: CrossRemoteTokenPayload,
    targetRemoteId: string,
    toolName: string,
    summary: string,
    status: CrossRemoteAuditStatus,
    exitCode: number | null,
    startedAt: number,
  ) => {
    await fastify.storage.crossRemoteAudit.insert({
      user_id: payload.userId,
      session_id: payload.sessionId,
      source_remote_id: payload.sourceRemoteServerId,
      target_remote_id: targetRemoteId,
      tool_name: toolName,
      args_summary: summary.slice(0, AUDIT_ARGS_MAX),
      exit_code: exitCode,
      duration_ms: Date.now() - startedAt,
      status,
    });
  };

  const callTool = async (payload: CrossRemoteTokenPayload, toolName: string, args: Record<string, unknown>) => {
    if (toolName === "list_accessible_remotes") {
      const remotes = await listAccessibleRemotes(fastify as unknown as AccessDeps, payload);
      return textResult(JSON.stringify(remotes, null, 2));
    }

    const tier = TOOL_TIERS[toolName];
    if (!tier) return textResult(`Unknown tool: ${toolName}`, true);

    const target = buildTargetCall(toolName, args);
    if (!target) return textResult(`Invalid arguments for ${toolName}`, true);

    const startedAt = Date.now();
    const remoteId = args.remoteId as string;

    const resolved = await resolveTarget(fastify as unknown as AccessDeps, payload, remoteId, tier);
    if (!resolved.ok) {
      const status: CrossRemoteAuditStatus = resolved.reason === "offline" ? "offline" : "denied";
      await audit(payload, remoteId, toolName, target.summary, status, null, startedAt);
      return textResult(resolved.reason === "offline" ? `Remote ${remoteId} is offline` : NOT_ACCESSIBLE, true);
    }

    if (!guard.acquire(payload.sessionId)) {
      return textResult("Too many concurrent cross-remote calls for this session; retry sequentially.", true);
    }

    try {
      const result = await proxyToRemoteAuto(
        resolved.server.id,
        resolved.server.url ?? "",
        resolved.server.api_key ?? "",
        "POST",
        target.path,
        target.body,
        { reverseConnectManager: fastify.reverseConnectManager },
      );

      if (!result.ok) {
        await audit(payload, remoteId, toolName, target.summary, "error", null, startedAt);
        const detail = (result.data as { error?: string } | undefined)?.error ?? result.errorCode ?? "unknown error";
        return textResult(`Call to remote ${remoteId} failed: ${detail}`, true);
      }

      const data = result.data as Record<string, unknown>;
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
      const status: CrossRemoteAuditStatus = data.timedOut === true ? "timeout" : "ok";
      await audit(payload, remoteId, toolName, target.summary, status, exitCode, startedAt);

      return textResult(JSON.stringify(data, null, 2));
    } finally {
      guard.release(payload.sessionId);
    }
  };

  fastify.post(CROSS_REMOTE_MCP_PATH, async (request, reply) => {
    const payload = await authenticate(request);
    if (!payload) return reply.code(401).send({ error: "Unauthorized" });

    const rpc = request.body as JsonRpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return reply.code(400).send({ error: "Invalid JSON-RPC request" });
    }

    // Notifications carry no id and expect no body.
    if (rpc.id === undefined) return reply.code(202).send();

    const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id: rpc.id, result });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "vibedeckx-cross-remote", version: "1.0.0" },
        });
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: TOOLS });
      case "tools/call": {
        const name = rpc.params?.name;
        if (typeof name !== "string") {
          return reply.send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Missing tool name" } });
        }
        return respond(await callTool(payload, name, rpc.params?.arguments ?? {}));
      }
      default:
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        });
    }
  });
};

export default fp(routes, { name: "cross-remote-mcp-routes" });
```

Two deliberate choices. Tool-level failures come back as `result.isError` rather than a JSON-RPC `error` object, because that is how MCP surfaces a failure *to the model* — a protocol error would be swallowed by the client instead of shown to the agent. And offline/denied are distinguishable to the caller but both audited, so a probing agent leaves a trail.

- [ ] **Step 4: Register in `server.ts`**

```ts
import crossRemoteMcpRoutes from "./routes/cross-remote-mcp-routes.js";
```

```ts
  server.register(crossRemoteMcpRoutes);
```

The route must be registered **after** `sharedServices` (it reads `fastify.storage` at request time, so ordering only matters for decoration availability at `ready()`).

Also confirm the global API-key `onRequest` hook does not block it: the hook returns early when `!API_KEY`, and on the SaaS server with `authEnabled` it lets requests with no `x-vibedeckx-api-key` header through to per-route auth. Our route does its own bearer-token check. If the SaaS server sets `VIBEDECKX_API_KEY`, a request with **no** api-key header and `authEnabled` true still passes the hook (`if (!providedKey && authEnabled) return done();`), so the gateway is reachable. No hook change needed.

- [ ] **Step 5: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- cross-remote-mcp-routes && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 17 tests PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/routes/cross-remote-mcp-routes.ts packages/vibedeckx/src/routes/cross-remote-mcp-routes.test.ts packages/vibedeckx/src/server.ts
git commit -m "feat: add cross-remote MCP gateway endpoint"
```

---

### Task 7: Expose the tier through `PUT /api/remote-servers/:id`

**Files:**
- Modify: `packages/vibedeckx/src/routes/remote-server-routes.ts:52-73`
- Test: `packages/vibedeckx/src/routes/remote-server-routes.test.ts` (create)

**Interfaces:**
- Consumes: `storage.remoteServers.update` with `cross_remote_access` (Task 1).
- Produces: `PUT /api/remote-servers/:id` accepts `{ crossRemoteAccess?: 'off' | 'read' | 'exec' }`; the sanitized response object includes `cross_remote_access`.

`sanitizeServer` strips only `api_key` and `connect_token`, so `cross_remote_access` flows to the client with no change there.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/routes/remote-server-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import remoteServerRoutes from "./remote-server-routes.js";

describe("PUT /api/remote-servers/:id cross-remote access", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let serverId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rsr-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const created = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
    serverId = created.id;

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(remoteServerRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: `/api/remote-servers/${serverId}`, payload: payload as object });

  it("persists a tier change and echoes it back", async () => {
    const res = await put({ crossRemoteAccess: "read" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cross_remote_access).toBe("read");

    const stored = await storage.remoteServers.getById(serverId);
    expect(stored?.cross_remote_access).toBe("read");
  });

  it("rejects an invalid tier value", async () => {
    const res = await put({ crossRemoteAccess: "root" });
    expect(res.statusCode).toBe(400);

    const stored = await storage.remoteServers.getById(serverId);
    expect(stored?.cross_remote_access).toBe("off");
  });

  it("leaves the tier alone when the field is omitted", async () => {
    await put({ crossRemoteAccess: "exec" });
    const res = await put({ name: "renamed" });
    expect(res.json().cross_remote_access).toBe("exec");
  });

  it("never returns the api key", async () => {
    const res = await put({ crossRemoteAccess: "read" });
    expect(res.json().api_key).toBeUndefined();
  });
});
```

This test runs with no `VIBEDECKX_API_KEY` and no Clerk, so `requireAuth` returns `undefined` (no-auth mode) and the handler proceeds with `userId === undefined` — matching how the other route tests exercise handlers.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- remote-server-routes`
Expected: FAIL — `cross_remote_access` is `"off"` after the first PUT, and the invalid-value case returns 200.

- [ ] **Step 3: Update the PUT handler**

In `routes/remote-server-routes.ts`, import the type and add a validator near `sanitizeServer`:

```ts
import type { RemoteServer, CrossRemoteAccess } from "../storage/types.js";

const CROSS_REMOTE_ACCESS_VALUES: readonly CrossRemoteAccess[] = ["off", "read", "exec"];

const isCrossRemoteAccess = (value: unknown): value is CrossRemoteAccess =>
  typeof value === "string" && (CROSS_REMOTE_ACCESS_VALUES as readonly string[]).includes(value);
```

Replace the body of the PUT handler:

```ts
      const userId = requireAuth(request, reply);
      if (userId === null) return;
      const { id } = request.params;
      const { name, url, apiKey, crossRemoteAccess } = request.body as {
        name?: string;
        url?: string;
        apiKey?: string;
        crossRemoteAccess?: string;
      };

      if (crossRemoteAccess !== undefined && !isCrossRemoteAccess(crossRemoteAccess)) {
        return reply.code(400).send({ error: "crossRemoteAccess must be one of: off, read, exec" });
      }

      const server = await fastify.storage.remoteServers.update(id, {
        name,
        url,
        api_key: apiKey,
        cross_remote_access: crossRemoteAccess,
      }, userId);
      if (!server)
        return reply.code(404).send({ error: "Server not found" });
      return reply.send(sanitizeServer(server));
```

- [ ] **Step 4: Run tests and type-check**

Run: `pnpm --filter vibedeckx test -- remote-server-routes && npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: 4 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/remote-server-routes.ts packages/vibedeckx/src/routes/remote-server-routes.test.ts
git commit -m "feat(api): accept crossRemoteAccess on remote server update"
```

---

### Task 8: Thread `crossRemoteMcp` from session creation into spawn args

The token must reach the `claude` process on remote A, and it must be **in** the spawn request — so the session id has to exist before the request is sent. Today it does not: `createNewSession` mints its own id, and the server derives `localSessionId` from the id the remote returns. This task inverts that: the server pre-computes the id, mints the token, pre-registers the routing entry, then calls the remote.

Pre-registering `remoteSessionMap` before the proxy call is not tidiness — it closes a real race. `createNewSession` on the remote spawns `claude` *before* its HTTP response returns, and Claude Code connects to its MCP servers during startup. If the map entry were written only after the response, `isSessionUsable` could reject the agent's very first tool call.

The feature is off unless `VIBEDECKX_PUBLIC_URL` is set and the request carries an authenticated `userId`.

**Files:**
- Create: `packages/vibedeckx/src/cross-remote-mcp-config.ts`
- Create: `packages/vibedeckx/src/cross-remote-mcp-config.test.ts`
- Modify: `packages/vibedeckx/src/providers/claude-code-provider.ts:46-73`
- Modify: `packages/vibedeckx/src/providers/codex-provider.ts` (signature only)
- Modify: `packages/vibedeckx/src/agent-provider.ts:57` (interface)
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (`RunningSession` ~`:70-105`, `createNewSession` `:385-398`, session literal `:425`, `spawnAgent` `:572`)
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (remote target body type `:224`, its `createNewSession` call `:247`, remote create call `:556`, local create call `:598`)
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts:35-72` (deps, id pre-computation, forwarded body)
- Test: `packages/vibedeckx/src/providers/claude-code-provider.test.ts` (extend)

**Interfaces:**
- Consumes: `signCrossRemoteToken`, `getCrossRemoteSecret` (Task 3); `CROSS_REMOTE_MCP_PATH` (Task 5).
- Produces:
  ```ts
  export interface CrossRemoteMcpConfig { url: string; token: string; }
  export function buildMcpConfigArg(config: CrossRemoteMcpConfig): string;   // the JSON blob for --mcp-config
  export function crossRemoteMcpEnabled(): boolean;                          // VIBEDECKX_PUBLIC_URL is set
  export function mintCrossRemoteMcpConfig(
    deps: { storage: Pick<Storage, "remoteServers" | "settings"> },
    args: { userId: string | undefined; sessionId: string; sourceRemoteServerId: string | null },
  ): Promise<CrossRemoteMcpConfig | undefined>;
  ```
  `AgentProvider.buildSpawnConfig(cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig`, and
  `AgentSessionManager.createNewSession(projectId, branch, projectPath, skipDb?, permissionMode?, agentType?, announceRunning?, force?, opts?: { sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig })`.

- [ ] **Step 1: Write the failing test for the config module**

Create `packages/vibedeckx/src/cross-remote-mcp-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { buildMcpConfigArg, mintCrossRemoteMcpConfig, crossRemoteMcpEnabled } from "./cross-remote-mcp-config.js";
import { verifyCrossRemoteToken, getCrossRemoteSecret } from "./utils/cross-remote-token.js";

describe("cross-remote MCP config", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xrcfg-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  it("is disabled when VIBEDECKX_PUBLIC_URL is unset", async () => {
    expect(crossRemoteMcpEnabled()).toBe(false);
    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null },
    );
    expect(config).toBeUndefined();
  });

  it("is disabled without an authenticated userId", async () => {
    // requireAuth yields undefined in solo/no-auth mode. A token with an empty userId
    // would resolve any tenant's remote, so mint nothing.
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

    expect(await mintCrossRemoteMcpConfig({ storage }, { userId: undefined, sessionId: "sess-1", sourceRemoteServerId: null })).toBeUndefined();
    expect(await mintCrossRemoteMcpConfig({ storage }, { userId: "", sessionId: "sess-1", sourceRemoteServerId: null })).toBeUndefined();
  });

  it("returns undefined when the user has no opted-in remote other than the source", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
    await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: a.id },
    );
    expect(config).toBeUndefined();
  });

  it("mints a verifiable token when a target exists", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com/";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: "srv-a" },
    );
    expect(config?.url).toBe("https://app.example.com/api/cross-remote-mcp");

    const secret = await getCrossRemoteSecret(storage);
    expect(verifyCrossRemoteToken(secret, config!.token, Date.now())).toEqual({
      userId: "user-1",
      sessionId: "sess-1",
      sourceRemoteServerId: "srv-a",
    });
  });

  it("ignores another user's opted-in remotes", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-2");
    await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-2");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null },
    );
    expect(config).toBeUndefined();
  });

  it("builds an --mcp-config blob with the bearer header", () => {
    const arg = buildMcpConfigArg({ url: "https://app.example.com/api/cross-remote-mcp", token: "tok" });
    expect(JSON.parse(arg)).toEqual({
      mcpServers: {
        "cross-remote": {
          type: "http",
          url: "https://app.example.com/api/cross-remote-mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- cross-remote-mcp-config`
Expected: FAIL — cannot resolve `./cross-remote-mcp-config.js`.

- [ ] **Step 3: Implement the config module**

Create `packages/vibedeckx/src/cross-remote-mcp-config.ts`:

```ts
import type { Storage } from "./storage/types.js";
import { getCrossRemoteSecret, signCrossRemoteToken } from "./utils/cross-remote-token.js";
import { CROSS_REMOTE_MCP_PATH } from "./cross-remote-access.js";

export interface CrossRemoteMcpConfig {
  url: string;
  token: string;
}

/** The gateway needs a publicly reachable base URL; without one the feature stays off. */
export function crossRemoteMcpEnabled(): boolean {
  return !!process.env.VIBEDECKX_PUBLIC_URL?.trim();
}

export function buildMcpConfigArg(config: CrossRemoteMcpConfig): string {
  return JSON.stringify({
    mcpServers: {
      "cross-remote": {
        type: "http",
        url: config.url,
        headers: { Authorization: `Bearer ${config.token}` },
      },
    },
  });
}

/**
 * Mints a session-scoped token, but only when the session could actually use it:
 * the public URL is configured, the caller is an authenticated user, and that user
 * owns at least one opted-in remote that is not the machine the agent runs on.
 * Otherwise the agent would see an empty tool surface for no reason.
 */
export async function mintCrossRemoteMcpConfig(
  deps: { storage: Pick<Storage, "remoteServers" | "settings"> },
  args: { userId: string | undefined; sessionId: string; sourceRemoteServerId: string | null },
): Promise<CrossRemoteMcpConfig | undefined> {
  const baseUrl = process.env.VIBEDECKX_PUBLIC_URL?.trim();
  if (!baseUrl) return undefined;

  // No userId (solo/no-auth mode): a token scoped to "" would resolve any tenant's
  // remote, because getById(id, "") skips the user_id predicate. Mint nothing.
  const { userId } = args;
  if (!userId) return undefined;

  const servers = await deps.storage.remoteServers.getAll(userId);
  const hasTarget = servers.some(
    (s) => s.cross_remote_access !== "off" && s.id !== args.sourceRemoteServerId,
  );
  if (!hasTarget) return undefined;

  const secret = await getCrossRemoteSecret(deps.storage);
  const token = signCrossRemoteToken(
    secret,
    { userId, sessionId: args.sessionId, sourceRemoteServerId: args.sourceRemoteServerId },
    Date.now(),
  );

  return { url: `${baseUrl.replace(/\/+$/, "")}${CROSS_REMOTE_MCP_PATH}`, token };
}
```

`getAll(userId)` scopes to the tenant, so another user's opted-in remotes can never trigger injection.

- [ ] **Step 4: Run the config tests**

Run: `pnpm --filter vibedeckx test -- cross-remote-mcp-config`
Expected: 5 tests PASS.

- [ ] **Step 5: Write the failing provider test**

Append to `packages/vibedeckx/src/providers/claude-code-provider.test.ts` (inside the existing top-level `describe`):

```ts
  it("omits --mcp-config when no cross-remote config is given", () => {
    const provider = new ClaudeCodeProvider();
    const config = provider.buildSpawnConfig("/tmp", "edit");
    expect(config.args).not.toContain("--mcp-config");
  });

  it("appends --mcp-config with the cross-remote server when given", () => {
    const provider = new ClaudeCodeProvider();
    const config = provider.buildSpawnConfig("/tmp", "edit", {
      url: "https://app.example.com/api/cross-remote-mcp",
      token: "tok",
    });

    const flagIndex = config.args.indexOf("--mcp-config");
    expect(flagIndex).toBeGreaterThan(-1);

    const blob = JSON.parse(config.args[flagIndex + 1]);
    expect(blob.mcpServers["cross-remote"].url).toBe("https://app.example.com/api/cross-remote-mcp");
    expect(blob.mcpServers["cross-remote"].headers.Authorization).toBe("Bearer tok");
  });
```

If `ClaudeCodeProvider` is not already imported there, add `import { ClaudeCodeProvider } from "./claude-code-provider.js";`.

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- claude-code-provider`
Expected: FAIL — `buildSpawnConfig` takes 2 arguments.

- [ ] **Step 7: Update the provider interface and both providers**

In `agent-provider.ts`, import the type and widen the method:

```ts
import type { CrossRemoteMcpConfig } from "./cross-remote-mcp-config.js";
```

```ts
  buildSpawnConfig(cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig;
```

In `providers/claude-code-provider.ts`, replace `buildSpawnConfig`:

```ts
  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
    const nativeBinary = this.detectBinary();

    const permissionFlag = permissionMode === "plan"
      ? "--permission-mode=plan"
      : "--dangerously-skip-permissions";

    const claudeArgs = [
      "--output-format=stream-json",
      "--input-format=stream-json",
      permissionFlag,
      // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
      // internally as "dismissed" before we can present a picker and wait for the
      // user. Disable it so the agent falls back to asking in plain text, which the
      // user answers through the normal conversation input.
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
    ];

    if (crossRemoteMcp) {
      claudeArgs.push("--mcp-config", buildMcpConfigArg(crossRemoteMcp));
    }

    if (nativeBinary) {
      return { command: nativeBinary, args: claudeArgs };
    }
    return {
      command: "npx",
      args: ["-y", "@anthropic-ai/claude-code", ...claudeArgs],
    };
  }
```

with the import:

```ts
import { buildMcpConfigArg, type CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
```

In `providers/codex-provider.ts`, widen the signature to satisfy the interface and ignore the argument (Codex has no equivalent flag here):

```ts
  buildSpawnConfig(cwd: string, permissionMode: "plan" | "edit", _crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
```

adding `import type { CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";`.

- [ ] **Step 8: Run the provider tests**

Run: `pnpm --filter vibedeckx test -- claude-code-provider codex-provider`
Expected: all PASS.

- [ ] **Step 9: Let `createNewSession` accept a caller-supplied id and the MCP config**

In `agent-session-manager.ts`, import `CrossRemoteMcpConfig` and add to the `RunningSession` interface:

```ts
  /** Injected at spawn, never persisted: a token is useless once the process holding it exits. */
  crossRemoteMcp?: CrossRemoteMcpConfig;
```

Widen `createNewSession` with a trailing options bag, so none of the existing positional call sites change:

```ts
  async createNewSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb: boolean = false,
    permissionMode: "plan" | "edit" = "edit",
    agentType: AgentType = "claude-code",
    announceRunning: boolean = false,
    force: boolean = false,
    opts: { sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig } = {},
  ): Promise<string> {
```

Replace the id generation (`agent-session-manager.ts:398`):

```ts
    // The caller may supply the id so it can mint a session-scoped token before spawn.
    const sessionId = opts.sessionId ?? randomUUID();
```

Add to the `RunningSession` literal (`~:425`), next to `permissionMode`:

```ts
      crossRemoteMcp: opts.crossRemoteMcp,
```

Pass it at the `spawnAgent` call site (`~:572`):

```ts
    const config = provider.buildSpawnConfig(cwd, session.permissionMode, session.crossRemoteMcp);
```

Hibernate/wake needs no extra work: wake re-enters `spawnAgent` with the same in-memory `RunningSession`, so the token is still there. Only a process restart drops it, and after a restart the session is recreated through `createNewSession`.

- [ ] **Step 10: Pre-compute the id and mint the token in `remote-agent-sessions.ts`**

`localSessionId` is currently derived from the id the remote returns (`:62`), which is too late — the token has to be inside the request. Generate the remote session id on the server instead.

Extend the deps and params of `createRemoteAgentSession`:

```ts
// RemoteAgentSessionDeps — add:
  storage: Storage;
// params — add:
  userId: string | undefined;
```

Replace the block from the `proxyToRemoteAuto` call (`:49`) through the `remoteSessionMap.set` (`:65-71`):

```ts
  // The server picks the session id so it can mint a token bound to it before the
  // remote spawns claude. The remote honours the supplied id.
  const remoteSessionId = randomUUID();
  const localSessionId = `remote-${agentMode}-${projectId}-${remoteSessionId}`;

  const crossRemoteMcp = await mintCrossRemoteMcpConfig(
    { storage: deps.storage },
    { userId, sessionId: localSessionId, sourceRemoteServerId: agentMode },
  );

  // Register before the call, not after: createNewSession on the remote spawns claude
  // before it responds, and claude connects to its MCP servers at startup. A late
  // registration would make isSessionUsable reject the agent's first tool call.
  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: agentMode,
    remoteUrl: remoteConfig.server_url ?? "",
    remoteApiKey: remoteConfig.server_api_key || "",
    remoteSessionId,
    branch: branch ?? null,
  });

  const result = await proxyToRemoteAuto(
    agentMode,
    remoteConfig.server_url ?? "",
    remoteConfig.server_api_key || "",
    "POST",
    `/api/path/agent-sessions/new`,
    { path: remoteConfig.remote_path, branch, permissionMode, agentType, force, sessionId: remoteSessionId, crossRemoteMcp },
    { reverseConnectManager: deps.reverseConnectManager ?? undefined },
  );
  if (!result.ok) {
    deps.remoteSessionMap.delete(localSessionId);
    return { ok: false, status: result.status, data: result.data };
  }

  const remoteData = result.data as { session: { id: string; processAlive?: boolean; [key: string]: unknown }; messages: unknown[] };
  if (remoteData.session.id !== remoteSessionId) {
    // An older remote that ignores the supplied id. Fail closed: the token we minted
    // names a session that does not exist, so cross-remote calls would be rejected
    // anyway, and the map entry we registered would be wrong.
    deps.remoteSessionMap.delete(localSessionId);
    return { ok: false, status: 409, data: { error: "Remote returned an unexpected session id; upgrade the remote" } };
  }

  await deps.remoteSessionMappings.upsert(localSessionId, projectId, agentMode, remoteSessionId, branch ?? null);
```

Delete the now-dead `const localSessionId = ...` line that followed `remoteData`. Import `randomUUID` from `crypto` and `mintCrossRemoteMcpConfig` from `./cross-remote-mcp-config.js`.

At the call site (`agent-session-routes.ts:556`), add `storage: fastify.storage` to the deps object and `userId` to the params object. `userId` is the value already returned by `requireAuth` earlier in that handler — pass it straight through, including when it is `undefined`; `mintCrossRemoteMcpConfig` fails closed on a missing user.

- [ ] **Step 11: Accept the id and config on the remote's create route, and mint for local sessions**

In the remote's `POST /api/path/agent-sessions/new` handler (`agent-session-routes.ts:223-281`), widen the body type and forward both fields:

```ts
  fastify.post<{ Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string; force?: boolean; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig } }>(
```

```ts
      const createdSessionId = await fastify.agentSessionManager.createNewSession(
        pseudoProjectId,
        branch ?? null,
        projectPath,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code",
        false,
        force === true,
        { sessionId, crossRemoteMcp },
      );
```

where `sessionId` and `crossRemoteMcp` are destructured from `request.body` alongside the existing fields. Rename the handler's existing `const sessionId = await ...createNewSession(...)` result variable to `createdSessionId` (and update its uses in the response body) so it no longer collides with the incoming `sessionId`. Import `CrossRemoteMcpConfig`.

For the **local** create path (`agent-session-routes.ts:593-620`), the same options bag now makes injection free — the SaaS server's own agent sessions can reach opted-in remotes too:

```ts
      const preSessionId = crypto.randomUUID();
      const crossRemoteMcp = await mintCrossRemoteMcpConfig(
        { storage: fastify.storage },
        { userId, sessionId: preSessionId, sourceRemoteServerId: null },
      );

      const sessionId = await fastify.agentSessionManager.createNewSession(
        req.params.projectId,
        branch ?? null,
        project.path,
        false,
        permissionMode || "edit",
        (agentType as AgentType) || "claude-code",
        false,
        force === true,
        { sessionId: preSessionId, crossRemoteMcp },
      );
```

Import `randomUUID` (as `crypto.randomUUID`) and `mintCrossRemoteMcpConfig` at the top of the route file. `userId` here is `requireAuth`'s return value: in solo/no-auth mode it is `undefined` and nothing is minted, which is the intended behaviour.

- [ ] **Step 12: Type-check and run the full suite**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: tsc clean, all tests PASS. Pay attention to `remote-agent-sessions` consumers: `chat-session-manager.ts:545` also builds the deps object for `createRemoteAgentSession` and must gain `storage` and `userId` (pass `undefined` for `userId` there if the chat orchestrator has no authenticated user in scope — it then mints nothing, which is correct).

- [ ] **Step 13: Commit**

```bash
git add packages/vibedeckx/src/
git commit -m "feat: inject cross-remote MCP config into agent session spawn"
```

---

### Task 9: Frontend — access tier selector

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:235-247` (type) and `:1998-2010` (`updateRemoteServer`)
- Modify: `apps/vibedeckx-ui/components/settings/remote-servers-settings.tsx`

**Interfaces:**
- Consumes: `PUT /api/remote-servers/:id` with `{ crossRemoteAccess }` (Task 7).
- Produces: no new exports beyond the `CrossRemoteAccess` type.

There is a **pre-existing bug** in `updateRemoteServer`: it returns `data.server`, but the PUT handler responds with the server object directly (`reply.send(sanitizeServer(server))`), so callers get `undefined`. Today nothing reads the return value. This task reads it, so fix it.

- [ ] **Step 1: Add the type to `lib/api.ts`**

Next to `RemoteServerStatus`:

```ts
export type CrossRemoteAccess = 'off' | 'read' | 'exec';
```

Add the field to the `RemoteServer` interface:

```ts
  cross_remote_access: CrossRemoteAccess;
```

- [ ] **Step 2: Update `updateRemoteServer` and fix the response shape**

```ts
  async updateRemoteServer(id: string, opts: { name?: string; url?: string; apiKey?: string; crossRemoteAccess?: CrossRemoteAccess }): Promise<RemoteServer> {
    const res = await authFetch(`${getApiBase()}/api/remote-servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    // The PUT handler replies with the sanitized server object directly, not { server }.
    return (await res.json()) as RemoteServer;
  },
```

- [ ] **Step 3: Add the selector to `remote-servers-settings.tsx`**

Import the Select primitives (mirroring `chat-provider-settings.tsx`) and the type:

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CrossRemoteAccess } from "@/lib/api";
```

Add a handler next to the other row actions. The component already holds `const [servers, setServers] = useState<RemoteServer[]>([])` (`:48`) and `const [error, setError] = useState('')` (`:50`):

```tsx
  const handleAccessChange = async (server: RemoteServer, access: CrossRemoteAccess) => {
    try {
      const updated = await api.updateRemoteServer(server.id, { crossRemoteAccess: access });
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update access");
    }
  };
```

Patching local state rather than calling `loadServers()` keeps the Select from flickering back to its old value while the refetch is in flight — which is also why Step 2's response-shape fix is a prerequisite: `updated` must be the real server object.

Add a header cell "Cross-remote access" to the table head, and this cell to each `<TableRow>` before the actions cell:

```tsx
              <TableCell>
                <Select
                  value={server.cross_remote_access}
                  onValueChange={(value) => handleAccessChange(server, value as CrossRemoteAccess)}
                >
                  <SelectTrigger className="w-[190px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off" className="text-[12.5px]">Off</SelectItem>
                    <SelectItem value="read" className="text-[12.5px]">Diagnostic read</SelectItem>
                    <SelectItem value="exec" className="text-[12.5px]">Command execution</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
```

Below the table (or as a `<p>` under the section heading) add the risk note. This file's copy is entirely English — keep it English:

```tsx
      <p className="text-xs text-muted-foreground">
        When enabled, agents running on your other machines can reach this one.
        <strong> Diagnostic read</strong> exposes files, directories and the process list —
        including any secrets in logs and config files.
        <strong> Command execution</strong> additionally allows arbitrary shell commands.
        Off by default.
      </p>
```

- [ ] **Step 4: Type-check and lint the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd - && pnpm --filter vibedeckx-ui lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/components/settings/remote-servers-settings.tsx
git commit -m "feat(ui): add cross-remote access tier selector to remote servers settings"
```

---

### Task 10: Update the spec, document the env var, and verify end to end

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-cross-remote-mcp-access-design.md`
- Modify: `CLAUDE.md` (env var + new route files in the architecture notes)

**Interfaces:**
- Consumes: everything.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Record the five implementation deviations in the spec**

Add a section titled `## 实现偏差（2026-07-10 落地时确认）` covering:

1. No MCP SDK dependency; the gateway is a hand-rolled stateless JSON-RPC handler supporting `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
2. `VIBEDECKX_PUBLIC_URL` is required; the feature is off when unset.
3. For remote sessions the gateway checks "the session record still exists" (`remoteSessionMap`), not true process liveness — the server holds no liveness bit for a process running on remote A. Revocation levers: delete the session, lower the target's tier (checked live per call), or wait out the 24h token expiry.
4. The session id is now **minted by the server** and passed into `createNewSession`, because the token binds `sessionId` and must travel inside the spawn request. The server also pre-registers `remoteSessionMap` before calling the remote, since `claude` connects to its MCP servers during startup — i.e. before the create response returns. A remote that echoes back a different session id is rejected with 409 (fail closed; upgrade the remote).
5. Minting requires an authenticated `userId`. In solo/no-auth mode `requireAuth` yields `undefined` and the feature stays off, because a token scoped to `""` would make `remoteServers.getById(id, "")` run unscoped and resolve any tenant's remote. The token verifier also rejects an empty `userId`/`sessionId`.

- [ ] **Step 2: Document `VIBEDECKX_PUBLIC_URL` in `CLAUDE.md`**

Under the Server description, add: the cross-remote MCP gateway requires `VIBEDECKX_PUBLIC_URL` (the SaaS server's publicly reachable base URL, e.g. `https://app.example.com`). Without it no token is minted and no `--mcp-config` is injected.

- [ ] **Step 3: Run the full backend and frontend gates**

Run:
```bash
pnpm --filter vibedeckx test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit && cd -
pnpm --filter vibedeckx-ui lint
```
Expected: all clean.

- [ ] **Step 4: Manual end-to-end verification**

Two machines (or two local servers on different ports, one started with `--accept-remote` and `VIBEDECKX_API_KEY`). On the SaaS server set `VIBEDECKX_PUBLIC_URL`.

1. Register machine B as a remote. Leave its tier at **Off**. Start an agent session on remote A. Ask the agent to call `list_accessible_remotes` — expect the MCP server to be absent entirely (no target ⇒ no injection).
2. Set B to **Diagnostic read**. Start a *new* session on A (the token is minted at spawn). `list_accessible_remotes` now shows B. `remote_read_file` on a file on B returns its contents. `remote_process_list` returns B's processes. `remote_bash` is refused with "remote not found or not accessible".
3. Raise B to **Command execution**. In a new session, `remote_bash` with `uname -a` returns B's kernel string.
4. While that session is still open, set B back to **Off** in the UI. The next `remote_bash` call fails immediately — this is the live tier re-check, no restart needed.
5. Query the audit trail: `sqlite3 ~/.vibedeckx/data.sqlite "select tool_name, status, exit_code, args_summary from cross_remote_audit order by created_at desc limit 10;"` — expect the denied, offline, and ok rows from the steps above.
6. Stop B's process (or disconnect its reverse-connect). `remote_bash` returns "is offline" rather than hanging.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-cross-remote-mcp-access-design.md CLAUDE.md
git commit -m "docs: record cross-remote gateway implementation deviations and env var"
```
