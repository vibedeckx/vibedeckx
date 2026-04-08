# Remote Executor Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist remote executor tracking state to SQLite so running remote executors survive local server restarts.

**Architecture:** Add a `remote_executor_processes` DB table that mirrors the in-memory `remoteExecutorMap`. Insert on start, delete on stop/finish. On server startup, load persisted entries, verify against each remote server's running process list, and repopulate the map.

**Tech Stack:** SQLite (better-sqlite3), Fastify plugin lifecycle, existing `proxyToRemoteAuto` for verification.

---

### File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/vibedeckx/src/storage/types.ts` | Modify | Add `remoteExecutorProcesses` to `Storage` interface |
| `packages/vibedeckx/src/storage/sqlite.ts` | Modify | Create table + implement CRUD |
| `packages/vibedeckx/src/routes/process-routes.ts` | Modify | Insert/delete DB rows on remote start/stop |
| `packages/vibedeckx/src/routes/websocket-routes.ts` | Modify | Delete DB row on remote "finished" message |
| `packages/vibedeckx/src/routes/terminal-routes.ts` | Modify | Delete DB row on remote terminal stop |
| `packages/vibedeckx/src/plugins/shared-services.ts` | Modify | Restore logic on startup |
| `packages/vibedeckx/src/chat-session-manager.ts` | Modify | Delete DB row on chat-managed executor stop |

---

### Task 1: Add DB table and Storage interface

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts:214-220`
- Modify: `packages/vibedeckx/src/storage/sqlite.ts:54-63` (table creation)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts:1158` (after executorProcesses, add new section)

- [ ] **Step 1: Add `remoteExecutorProcesses` to the Storage interface**

In `packages/vibedeckx/src/storage/types.ts`, add after the `executorProcesses` block (after line 220):

```typescript
  remoteExecutorProcesses: {
    insert(localProcessId: string, info: { remoteServerId: string; remoteUrl: string; remoteApiKey: string; remoteProcessId: string; executorId: string; projectId?: string; branch?: string | null }): void;
    delete(localProcessId: string): void;
    getAll(): Array<{ local_process_id: string; remote_server_id: string; remote_url: string; remote_api_key: string; remote_process_id: string; executor_id: string; project_id: string | null; branch: string | null }>;
  };
```

- [ ] **Step 2: Add CREATE TABLE statement in sqlite.ts**

In `packages/vibedeckx/src/storage/sqlite.ts`, add after the `executor_processes` CREATE TABLE block (after the closing `);` around line 63):

```sql
    CREATE TABLE IF NOT EXISTS remote_executor_processes (
      local_process_id TEXT PRIMARY KEY,
      remote_server_id TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      remote_api_key TEXT NOT NULL,
      remote_process_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      project_id TEXT,
      branch TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 3: Add CRUD implementation in sqlite.ts**

In `packages/vibedeckx/src/storage/sqlite.ts`, add after the `executorProcesses` section (after line 1158, before `agentSessions`):

```typescript
    remoteExecutorProcesses: {
      insert: (localProcessId, info) => {
        db.prepare(
          `INSERT OR REPLACE INTO remote_executor_processes (local_process_id, remote_server_id, remote_url, remote_api_key, remote_process_id, executor_id, project_id, branch) VALUES (@local_process_id, @remote_server_id, @remote_url, @remote_api_key, @remote_process_id, @executor_id, @project_id, @branch)`
        ).run({
          local_process_id: localProcessId,
          remote_server_id: info.remoteServerId,
          remote_url: info.remoteUrl,
          remote_api_key: info.remoteApiKey,
          remote_process_id: info.remoteProcessId,
          executor_id: info.executorId,
          project_id: info.projectId ?? null,
          branch: info.branch ?? null,
        });
      },

      delete: (localProcessId) => {
        db.prepare(`DELETE FROM remote_executor_processes WHERE local_process_id = @id`).run({ id: localProcessId });
      },

      getAll: () => {
        return db
          .prepare<{}, { local_process_id: string; remote_server_id: string; remote_url: string; remote_api_key: string; remote_process_id: string; executor_id: string; project_id: string | null; branch: string | null }>(
            `SELECT * FROM remote_executor_processes`
          )
          .all({});
      },
    },
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts packages/vibedeckx/src/storage/sqlite.ts
git commit -m "feat: add remote_executor_processes DB table and storage interface"
```

---

### Task 2: Persist remote executor start/stop in process-routes.ts

**Files:**
- Modify: `packages/vibedeckx/src/routes/process-routes.ts:124-138` (start handler)
- Modify: `packages/vibedeckx/src/routes/process-routes.ts:179-188` (stop handler)

- [ ] **Step 1: Insert DB row on remote executor start**

In `packages/vibedeckx/src/routes/process-routes.ts`, right after `fastify.remoteExecutorMap.set(localProcessId, {...})` (line 124-131), add:

```typescript
        fastify.storage.remoteExecutorProcesses.insert(localProcessId, {
          remoteServerId: executorMode,
          remoteUrl: remoteConfig.server_url ?? "",
          remoteApiKey: remoteConfig.server_api_key || "",
          remoteProcessId: remoteData.processId,
          executorId: executor.id,
          projectId: project.id,
          branch: branch ?? undefined,
        });
```

- [ ] **Step 2: Delete DB row on remote executor stop**

In `packages/vibedeckx/src/routes/process-routes.ts`, right after `fastify.remoteExecutorMap.delete(req.params.processId)` (line 188), add:

```typescript
          fastify.storage.remoteExecutorProcesses.delete(req.params.processId);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/process-routes.ts
git commit -m "feat: persist remote executor start/stop to DB in process-routes"
```

---

### Task 3: Delete DB row on WebSocket "finished" and terminal stop

**Files:**
- Modify: `packages/vibedeckx/src/routes/websocket-routes.ts:426`
- Modify: `packages/vibedeckx/src/routes/terminal-routes.ts:244`
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:1252`

- [ ] **Step 1: Delete DB row on WebSocket "finished" event**

In `packages/vibedeckx/src/routes/websocket-routes.ts`, right after `fastify.remoteExecutorMap.delete(processId)` (line 426), add:

```typescript
                    fastify.storage.remoteExecutorProcesses.delete(processId);
```

- [ ] **Step 2: Delete DB row on remote terminal stop**

In `packages/vibedeckx/src/routes/terminal-routes.ts`, right after `fastify.remoteExecutorMap.delete(terminalId)` (line 244), add:

```typescript
        fastify.storage.remoteExecutorProcesses.delete(terminalId);
```

- [ ] **Step 3: Delete DB row on chat-managed executor stop**

In `packages/vibedeckx/src/chat-session-manager.ts`, right after `remoteExecutorMap.delete(remoteEntry.key)` (line 1252), add:

```typescript
              this.storage.remoteExecutorProcesses.delete(remoteEntry.key);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/websocket-routes.ts packages/vibedeckx/src/routes/terminal-routes.ts packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: clean up remote executor DB rows on finish/stop"
```

---

### Task 4: Restore remote executors on startup

**Files:**
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts:25-26`

- [ ] **Step 1: Add restore logic after remoteExecutorMap creation**

In `packages/vibedeckx/src/plugins/shared-services.ts`, add the import at the top:

```typescript
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
```

Then after `const remoteExecutorMap = new Map<string, RemoteExecutorInfo>();` (line 25), add:

```typescript
  // Restore remote executor processes from DB
  const savedRemoteExecutors = opts.storage.remoteExecutorProcesses.getAll();
  if (savedRemoteExecutors.length > 0) {
    console.log(`[SharedServices] Found ${savedRemoteExecutors.length} persisted remote executor(s), verifying...`);

    // Group by remote server ID to batch verification calls
    const byServer = new Map<string, typeof savedRemoteExecutors>();
    for (const row of savedRemoteExecutors) {
      const group = byServer.get(row.remote_server_id) ?? [];
      group.push(row);
      byServer.set(row.remote_server_id, group);
    }

    for (const [serverId, rows] of byServer) {
      try {
        const { remote_url, remote_api_key } = rows[0];
        const result = await proxyToRemoteAuto(
          serverId,
          remote_url,
          remote_api_key,
          "GET",
          "/api/executor-processes/running",
        );
        if (result.ok) {
          const data = result.data as { processes: Array<{ id: string }> };
          const runningIds = new Set(data.processes.map((p) => p.id));
          for (const row of rows) {
            if (runningIds.has(row.remote_process_id)) {
              remoteExecutorMap.set(row.local_process_id, {
                remoteServerId: row.remote_server_id,
                remoteUrl: row.remote_url,
                remoteApiKey: row.remote_api_key,
                remoteProcessId: row.remote_process_id,
                executorId: row.executor_id,
                projectId: row.project_id ?? undefined,
                branch: row.branch,
              });
              console.log(`[SharedServices] Restored remote executor: ${row.local_process_id}`);
            } else {
              opts.storage.remoteExecutorProcesses.delete(row.local_process_id);
              console.log(`[SharedServices] Cleaned up stale remote executor: ${row.local_process_id}`);
            }
          }
        } else {
          console.warn(`[SharedServices] Could not reach remote server ${serverId} (status ${result.status}), keeping DB rows for later retry`);
        }
      } catch (err) {
        console.warn(`[SharedServices] Failed to verify remote executors on ${serverId}: ${err}`);
      }
    }
  }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/plugins/shared-services.ts
git commit -m "feat: restore remote executor map from DB on server startup"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Build the full project**

Run: `pnpm build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Manual smoke test**

1. Start the local server (`pnpm start`)
2. Start a remote executor via the UI
3. Verify the DB has a row: `sqlite3 ~/.vibedeckx/data.sqlite "SELECT * FROM remote_executor_processes"`
4. Restart the local server
5. Verify the executor still shows as running in the UI
6. Verify the DB row is still present
7. Stop the remote executor
8. Verify the DB row is deleted

- [ ] **Step 3: Commit any fixes**

If any issues found during smoke testing, fix and commit.
