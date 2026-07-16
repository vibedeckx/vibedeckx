# Server-Persisted Branch Merge Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the per-(project, branch) merge-target choice from browser localStorage into the server database so every logged-in machine sees the same tracking state, with SSE invalidation and a one-time localStorage import.

**Architecture:** New `branch_merge_targets` table + `mergeTargets` storage repo. The existing merge-status POST route resolves stored targets server-side (request > stored > default) and annotates each entry positionally with `targetSource`/`requestedTarget`; the git computation layer and the worker-proxy endpoint are untouched. A new PUT route writes/clears targets and emits a `merge-target:updated` event. The frontend hook drops all localStorage logic, maps `target-not-found` entries into a visible warning state instead of silently clearing, and runs a one-time `ifAbsent` import of legacy localStorage keys before its first fetch.

**Tech Stack:** Fastify + Kysely/better-sqlite3 (backend), Next.js/React hook + vitest jsdom tests (frontend).

**Spec:** `docs/superpowers/specs/2026-07-16-server-persisted-merge-targets-design.md` — read it before starting; it is the contract.

## Global Constraints

- Backend is ESM with NodeNext resolution: **all local imports need `.js` extensions**.
- Backend type-check: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend type-check: `cd apps/vibedeckx-ui && npx tsc --noEmit`. Both must pass at the end of every task.
- Backend tests: `pnpm --filter vibedeckx exec vitest run <file>`; frontend tests: `pnpm --filter vibedeckx-ui exec vitest run <file>`.
- `branch`/`target` strings: reject empty and > 256 chars; **never trim or rewrite** an accepted value.
- Entry ordering is a contract: `computeMergeStatusPairs` returns exactly one entry per comparison **in input order**; all annotation is by array index (duplicate branch comparisons are legal).
- `target-not-found` must NEVER delete a stored row or fall back silently (spec decision 3).
- Reset-to-default menu copy is exactly **"Default branch (auto)"** — deliberately name-free.
- SSE event emits **only when a write changed state** (identical upsert, losing `insertIfAbsent`, no-op delete → no event).

---

### Task 1: Storage — `branch_merge_targets` table + `mergeTargets` repo

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts` (add table interface + `DB` entry)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (DDL + repo spread)
- Modify: `packages/vibedeckx/src/storage/types.ts` (Storage interface)
- Create: `packages/vibedeckx/src/storage/repositories/merge-targets.ts`
- Test: `packages/vibedeckx/src/storage/merge-targets.test.ts`

**Interfaces:**
- Consumes: existing `createSqliteStorage`, Kysely `DB` schema.
- Produces (later tasks rely on these exact signatures):
  ```ts
  storage.mergeTargets.getForBranches(projectId: string, branches: string[]): Promise<Map<string, string>>
  storage.mergeTargets.upsert(projectId: string, branch: string, target: string): Promise<boolean> // true = inserted or changed
  storage.mergeTargets.insertIfAbsent(projectId: string, branch: string, target: string): Promise<boolean> // true = row inserted
  storage.mergeTargets.delete(projectId: string, branch: string): Promise<boolean>                          // true = row existed
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/merge-targets.test.ts`:

```ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("mergeTargets repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-merge-targets-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "P1", path: "/tmp/p1" });
    await storage.projects.create({ id: "p2", name: "P2", path: "/tmp/p2" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getForBranches returns only the asked branches of the asked project", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    await storage.mergeTargets.upsert("p1", "dev2", "release");
    await storage.mergeTargets.upsert("p2", "dev1", "other");

    const result = await storage.mergeTargets.getForBranches("p1", ["dev1", "dev3"]);
    expect(result).toEqual(new Map([["dev1", "main"]]));
    expect(await storage.mergeTargets.getForBranches("p1", [])).toEqual(new Map());
  });

  it("upsert reports inserts and changed targets but not identical targets", async () => {
    expect(await storage.mergeTargets.upsert("p1", "dev1", "main")).toBe(true);
    expect(await storage.mergeTargets.upsert("p1", "dev1", "main")).toBe(false);
    expect(await storage.mergeTargets.upsert("p1", "dev1", "release")).toBe(true);
    const result = await storage.mergeTargets.getForBranches("p1", ["dev1"]);
    expect(result.get("dev1")).toBe("release");
  });

  it("upsert refreshes updated_at on conflict (SQLite DEFAULT is INSERT-only)", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    const db = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    const readUpdatedAt = () =>
      (db.prepare(
        "SELECT updated_at FROM branch_merge_targets WHERE project_id = 'p1' AND branch = 'dev1'",
      ).get() as { updated_at: string }).updated_at;
    try {
      const initial = readUpdatedAt(); // SQLite CURRENT_TIMESTAMP format
      await storage.mergeTargets.upsert("p1", "dev1", "release");
      // The upsert's explicit ISO-8601 value differs from the DEFAULT format,
      // so any successful ON CONFLICT SET shows up as a change.
      expect(readUpdatedAt()).not.toBe(initial);
    } finally {
      db.close();
    }
  });

  it("upsert leaves updated_at unchanged when the target is identical", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    const db = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    const readUpdatedAt = () =>
      (db.prepare(
        "SELECT updated_at FROM branch_merge_targets WHERE project_id = 'p1' AND branch = 'dev1'",
      ).get() as { updated_at: string }).updated_at;
    try {
      const initial = readUpdatedAt();
      await storage.mergeTargets.upsert("p1", "dev1", "main");
      expect(readUpdatedAt()).toBe(initial);
    } finally {
      db.close();
    }
  });

  it("insertIfAbsent inserts only when no row exists and reports which", async () => {
    expect(await storage.mergeTargets.insertIfAbsent("p1", "dev1", "main")).toBe(true);
    expect(await storage.mergeTargets.insertIfAbsent("p1", "dev1", "release")).toBe(false);
    const result = await storage.mergeTargets.getForBranches("p1", ["dev1"]);
    expect(result.get("dev1")).toBe("main"); // existing value wins
  });

  it("delete removes the row and reports whether one existed", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    expect(await storage.mergeTargets.delete("p1", "dev1")).toBe(true);
    expect(await storage.mergeTargets.delete("p1", "dev1")).toBe(false);
    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(new Map());
  });

  it("cascades on project delete", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    await storage.projects.delete("p1");
    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(new Map());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx exec vitest run src/storage/merge-targets.test.ts`
Expected: FAIL — `storage.mergeTargets` is undefined / type error (`mergeTargets` not on `Storage`).

- [ ] **Step 3: Add the schema table type**

In `packages/vibedeckx/src/storage/schema.ts`, after `CrossRemoteAuditTable` (keep alphabetical-ish grouping loose; placement next to the other tables is fine):

```ts
export interface BranchMergeTargetsTable {
  project_id: string;
  branch: string;
  target: string;
  updated_at: Generated<string>;
}
```

And add to the `DB` interface (`schema.ts:242`):

```ts
  branch_merge_targets: BranchMergeTargetsTable;
```

- [ ] **Step 4: Add the DDL**

In `packages/vibedeckx/src/storage/sqlite.ts`, inside `createDatabase`, directly before the `// Re-enable FK enforcement for runtime operations` comment:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_merge_targets (
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      target TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, branch),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
```

- [ ] **Step 5: Add the Storage interface entry**

In `packages/vibedeckx/src/storage/types.ts`, inside `interface Storage`, directly before `close: () => Promise<void>;`:

```ts
  mergeTargets: {
    /** Stored explicit merge targets for the given branches, keyed by branch. */
    getForBranches: (projectId: string, branches: string[]) => Promise<Map<string, string>>;
    /** Atomic upsert. Returns true when inserted or changed; false when identical. */
    upsert: (projectId: string, branch: string, target: string) => Promise<boolean>;
    /** INSERT ... ON CONFLICT DO NOTHING. Returns true when the row was inserted
     *  (false = an existing value won). */
    insertIfAbsent: (projectId: string, branch: string, target: string) => Promise<boolean>;
    /** Returns true when a row existed and was removed. */
    delete: (projectId: string, branch: string) => Promise<boolean>;
  };
```

- [ ] **Step 6: Write the repo**

Create `packages/vibedeckx/src/storage/repositories/merge-targets.ts`:

```ts
import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

export const createMergeTargetsRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "mergeTargets"> => ({
  mergeTargets: {
    getForBranches: async (projectId, branches) => {
      if (branches.length === 0) return new Map();
      const rows = await kdb
        .selectFrom("branch_merge_targets")
        .select(["branch", "target"])
        .where("project_id", "=", projectId)
        .where("branch", "in", branches)
        .execute();
      return new Map(rows.map((r) => [r.branch, r.target]));
    },

    upsert: async (projectId, branch, target) => {
      const result = await kdb
        .insertInto("branch_merge_targets")
        .values({ project_id: projectId, branch, target })
        .onConflict((oc) =>
          oc.columns(["project_id", "branch"]).doUpdateSet({
            target,
            // SQLite DEFAULT applies on INSERT only — set explicitly on update.
            updated_at: new Date().toISOString(),
          }).where("target", "!=", target),
        )
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    insertIfAbsent: async (projectId, branch, target) => {
      const result = await kdb
        .insertInto("branch_merge_targets")
        .values({ project_id: projectId, branch, target })
        .onConflict((oc) => oc.columns(["project_id", "branch"]).doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    delete: async (projectId, branch) => {
      const result = await kdb
        .deleteFrom("branch_merge_targets")
        .where("project_id", "=", projectId)
        .where("branch", "=", branch)
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },
  },
});
```

- [ ] **Step 7: Wire it into the storage assembly**

In `packages/vibedeckx/src/storage/sqlite.ts`: add the import next to the other repo imports —

```ts
import { createMergeTargetsRepo } from "./repositories/merge-targets.js";
```

and add to the returned object in `createSqliteStorage` (after `...createCrossRemoteAuditRepo(kdb),`):

```ts
    ...createMergeTargetsRepo(kdb),
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter vibedeckx exec vitest run src/storage/merge-targets.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 9: Type-check and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/storage
git commit -m "feat: branch_merge_targets table + mergeTargets storage repo"
```

---

### Task 2: PUT write route + `merge-target:updated` event

**Files:**
- Modify: `packages/vibedeckx/src/event-bus.ts` (GlobalEvent union)
- Modify: `packages/vibedeckx/src/routes/merge-status-routes.ts` (new PUT route)
- Test: `packages/vibedeckx/src/routes/merge-status-routes.test.ts`

**Interfaces:**
- Consumes: `storage.mergeTargets.*` from Task 1; `fastify.eventBus` (decorated by `plugins/shared-services.ts` in production).
- Produces: `PUT /api/projects/:id/branches/merge-target` with body `{ branch: string, target: string | null, ifAbsent?: boolean }` → 200 `{ branch, target: <stored value or null> }`; event `{ type: "merge-target:updated", projectId, branch }`.

- [ ] **Step 1: Add the event type**

In `packages/vibedeckx/src/event-bus.ts`, append to the `GlobalEvent` union (after the `schedule:run-finished` member):

```ts
  | { type: "merge-target:updated"; projectId: string; branch: string };
```

(Note the union's final `;` moves to this new last member.)

- [ ] **Step 2: Write the failing tests**

In `packages/vibedeckx/src/routes/merge-status-routes.test.ts`:

The existing test app doesn't decorate `eventBus`. In `beforeEach`, after `app.decorate("reverseConnectManager", ...)`, add (with `emitted` declared next to the other `let`s and the import at top):

```ts
import type { GlobalEvent } from "../event-bus.js";
```
```ts
  let emitted: GlobalEvent[];
```
```ts
    emitted = [];
    app.decorate("eventBus", { emit: (e: GlobalEvent) => emitted.push(e) } as never);
```

Then add a new describe block at the bottom of the file:

```ts
describe("PUT /api/projects/:id/branches/merge-target", () => {
  const put = (projectId: string, payload: unknown) => app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/branches/merge-target`,
    payload: payload as Record<string, unknown>,
  });

  it("stores a target, returns it, and emits the update event", async () => {
    const response = await put("local", { branch: "dev1", target: "main" });
    const repeated = await put("local", { branch: "dev1", target: "main" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev1", target: "main" });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ branch: "dev1", target: "main" });
    expect(await storage.mergeTargets.getForBranches("local", ["dev1"]))
      .toEqual(new Map([["dev1", "main"]]));
    expect(emitted).toEqual([
      { type: "merge-target:updated", projectId: "local", branch: "dev1" },
    ]);
  });

  it("clears on target: null and emits only when a row existed", async () => {
    await storage.mergeTargets.upsert("local", "dev1", "main");
    const response = await put("local", { branch: "dev1", target: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev1", target: null });
    expect(emitted).toEqual([
      { type: "merge-target:updated", projectId: "local", branch: "dev1" },
    ]);

    emitted.length = 0;
    const again = await put("local", { branch: "dev1", target: null });
    expect(again.statusCode).toBe(200);
    expect(emitted).toEqual([]); // no-op delete: no event
  });

  it("ifAbsent lets an existing value win, returns it, and emits nothing", async () => {
    await storage.mergeTargets.upsert("local", "dev1", "release");
    emitted.length = 0;
    const response = await put("local", { branch: "dev1", target: "main", ifAbsent: true });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev1", target: "release" });
    expect(emitted).toEqual([]);
  });

  it("ifAbsent inserts and emits when no row exists", async () => {
    const response = await put("local", { branch: "dev1", target: "main", ifAbsent: true });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev1", target: "main" });
    expect(emitted).toHaveLength(1);
  });

  it("rejects malformed bodies", async () => {
    expect((await put("local", { target: "main" })).statusCode).toBe(400);           // missing branch
    expect((await put("local", { branch: "", target: "main" })).statusCode).toBe(400); // empty branch
    expect((await put("local", { branch: "dev1" })).statusCode).toBe(400);            // target missing (must be string or null)
    expect((await put("local", { branch: "dev1", target: "" })).statusCode).toBe(400); // empty target
    expect((await put("local", { branch: "dev1", target: "x".repeat(257) })).statusCode).toBe(400);
    expect((await put("local", { branch: "dev1", target: "main", ifAbsent: "yes" })).statusCode).toBe(400);
    expect((await put("local", { branch: "dev1", target: null, ifAbsent: true })).statusCode).toBe(400);
  });

  it("404s on an unknown project", async () => {
    expect((await put("nope", { branch: "dev1", target: "main" })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter vibedeckx exec vitest run src/routes/merge-status-routes.test.ts`
Expected: new tests FAIL with 404 (route not registered); pre-existing tests still PASS.

- [ ] **Step 4: Implement the route**

In `packages/vibedeckx/src/routes/merge-status-routes.ts`, add near the top:

```ts
const MAX_NAME_LENGTH = 256;

function isValidName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}
```

and register inside `routes` (after the existing POST project route). Names are stored verbatim — no trimming:

```ts
  fastify.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/projects/:id/branches/merge-target",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const body = req.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "Invalid body" });
      }
      const { branch, target, ifAbsent } = body as {
        branch?: unknown; target?: unknown; ifAbsent?: unknown;
      };
      if (!isValidName(branch)) {
        return reply.code(400).send({ error: "Invalid branch" });
      }
      if (target !== null && !isValidName(target)) {
        return reply.code(400).send({ error: "Invalid target" });
      }
      if (ifAbsent !== undefined && typeof ifAbsent !== "boolean") {
        return reply.code(400).send({ error: "Invalid ifAbsent" });
      }
      if (ifAbsent === true && target === null) {
        // Conditional delete has no use case; the combined semantics would be ambiguous.
        return reply.code(400).send({ error: "ifAbsent requires a non-null target" });
      }

      // No git existence check by design (spec decision 5): the picker only
      // offers real branches, and a remote being offline must not fail a
      // preference write. Existence surfaces via merge-status computation.
      let changed: boolean;
      let stored: string | null;
      if (target === null) {
        changed = await fastify.storage.mergeTargets.delete(project.id, branch);
        stored = null;
      } else if (ifAbsent === true) {
        changed = await fastify.storage.mergeTargets.insertIfAbsent(project.id, branch, target);
        stored = changed
          ? target
          : (await fastify.storage.mergeTargets.getForBranches(project.id, [branch])).get(branch) ?? null;
      } else {
        changed = await fastify.storage.mergeTargets.upsert(project.id, branch, target);
        stored = target;
      }

      // Cache-invalidation signal only — losing imports / no-op deletes stay
      // silent so old devices migrating don't trigger fleet-wide refetches.
      if (changed) {
        fastify.eventBus.emit({ type: "merge-target:updated", projectId: project.id, branch });
      }
      return reply.code(200).send({ branch, target: stored });
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter vibedeckx exec vitest run src/routes/merge-status-routes.test.ts`
Expected: all PASS (old + new).

- [ ] **Step 6: Type-check and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/event-bus.ts packages/vibedeckx/src/routes/merge-status-routes.ts packages/vibedeckx/src/routes/merge-status-routes.test.ts
git commit -m "feat: merge-target PUT route + merge-target:updated event"
```

---

### Task 3: Read path — stored-target resolution + positional annotation

**Files:**
- Modify: `packages/vibedeckx/src/routes/merge-status-routes.ts`
- Test: `packages/vibedeckx/src/routes/merge-status-routes.test.ts`

**Interfaces:**
- Consumes: `storage.mergeTargets.getForBranches` (Task 1); `computeMergeStatusPairs` (unchanged); `proxyToRemoteAuto` (unchanged).
- Produces: the project POST route now returns `ProjectMergeStatusPairEntry[]`:
  ```ts
  export type TargetSource = "request" | "stored" | "default";
  export interface ProjectMergeStatusPairEntry extends MergeStatusPairEntry {
    targetSource: TargetSource;
    requestedTarget: string | null;
  }
  ```
  `/api/path/branches/merge-status` (worker endpoint) and `merge-status.ts` are NOT modified.

- [ ] **Step 1: Write the failing tests**

Append to `packages/vibedeckx/src/routes/merge-status-routes.test.ts`. The `beforeEach` repo has only `main`; these tests create a `feature` branch first:

```ts
describe("stored-target resolution and annotation", () => {
  const postComparisons = (projectId: string, comparisons: unknown[]) => app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/branches/merge-status`,
    payload: { comparisons },
  });

  beforeEach(() => {
    run(repo, ["branch", "feature"]);
  });

  it("annotates a bare comparison with the default target", async () => {
    const response = await postComparisons("local", [{ branch: "feature" }]);
    expect(response.statusCode).toBe(200);
    const [entry] = response.json().entries;
    expect(entry).toMatchObject({
      branch: "feature",
      target: "main",
      targetSource: "default",
      requestedTarget: "main",
    });
  });

  it("resolves a stored target and annotates it as stored", async () => {
    run(repo, ["branch", "release"]);
    await storage.mergeTargets.upsert("local", "feature", "release");
    const response = await postComparisons("local", [{ branch: "feature" }]);
    const [entry] = response.json().entries;
    expect(entry).toMatchObject({
      branch: "feature",
      target: "release",
      targetSource: "stored",
      requestedTarget: "release",
    });
  });

  it("request-explicit target beats a stored one", async () => {
    await storage.mergeTargets.upsert("local", "feature", "ghost");
    const response = await postComparisons("local", [{ branch: "feature", target: "main" }]);
    const [entry] = response.json().entries;
    expect(entry).toMatchObject({ target: "main", targetSource: "request", requestedTarget: "main" });
  });

  it("keeps the stored row and reports requestedTarget on target-not-found", async () => {
    await storage.mergeTargets.upsert("local", "feature", "ghost");
    const response = await postComparisons("local", [{ branch: "feature" }]);
    const [entry] = response.json().entries;
    expect(entry).toMatchObject({
      branch: "feature",
      target: null,
      error: "target-not-found",
      targetSource: "stored",
      requestedTarget: "ghost",
    });
    // Spec decision 3: a read never mutates config.
    expect(await storage.mergeTargets.getForBranches("local", ["feature"]))
      .toEqual(new Map([["feature", "ghost"]]));
  });

  it("annotates duplicate branch comparisons positionally", async () => {
    await storage.mergeTargets.upsert("local", "feature", "main");
    const response = await postComparisons("local", [
      { branch: "feature" },
      { branch: "feature", target: "main" },
    ]);
    const entries = response.json().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].targetSource).toBe("stored");
    expect(entries[1].targetSource).toBe("request");
  });

  it("sends effective comparisons to the remote and annotates its entries", async () => {
    await storage.mergeTargets.upsert("remote", "dev1", "release");
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { entries: [{ branch: "dev1", target: "release", status: "merged", unmergedCount: 0, dirty: false }] },
    });

    const response = await postComparisons("remote", [{ branch: "dev1" }]);
    expect(response.statusCode).toBe(200);
    expect(proxyToRemoteAuto).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "POST",
      "/api/path/branches/merge-status",
      { path: "/repo-a", comparisons: [{ branch: "dev1", target: "release" }] },
      expect.anything(),
    );
    expect(response.json().entries[0]).toMatchObject({
      targetSource: "stored",
      requestedTarget: "release",
    });
  });

  it("502s when the proxied entry count violates the ordering contract", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { entries: [] } });
    const response = await postComparisons("remote", [{ branch: "dev1" }]);
    expect(response.statusCode).toBe(502);
  });
});
```

Note: the pre-existing test "labels a remote-only response with the current primary remote identity" posts `comparisons: []` with a mocked `entries: []` — lengths match (0 === 0), so it stays green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter vibedeckx exec vitest run src/routes/merge-status-routes.test.ts`
Expected: new describe FAILs (missing `targetSource`/`requestedTarget`, no 502); earlier tests PASS.

- [ ] **Step 3: Implement resolution + annotation**

In `packages/vibedeckx/src/routes/merge-status-routes.ts`:

Add the types and helper near the top (types exported — the frontend mirrors them; the helper stays module-local):

```ts
export type TargetSource = "request" | "stored" | "default";

/** What the browser sees from the project endpoint. The computed/worker entry
 *  (MergeStatusPairEntry) keeps its exact shape; only this layer adds metadata. */
export interface ProjectMergeStatusPairEntry extends MergeStatusPairEntry {
  targetSource: TargetSource;
  /** The target this server asked the computation layer to compare against
   *  (request or stored), even when it doesn't exist; null only for
   *  default-target comparisons that errored (no-default-branch). */
  requestedTarget: string | null;
}

/** Positional annotation — entries[i] corresponds to effective[i].
 *  computeMergeStatusPairs is a per-comparison map (order-preserving, one
 *  entry per comparison) and the worker endpoint inherits that contract; a
 *  branch-keyed join would break on duplicate branch comparisons. */
function annotateEntries(
  entries: MergeStatusPairEntry[],
  effective: MergeComparison[],
  sources: TargetSource[],
): ProjectMergeStatusPairEntry[] {
  return entries.map((entry, i) => ({
    ...entry,
    targetSource: sources[i],
    requestedTarget: effective[i].target ?? entry.target,
  }));
}
```

`MergeStatusPairEntry` needs importing: change the existing import to

```ts
import {
  computeMergeStatusPairs,
  type MergeComparison,
  type MergeStatusPairEntry,
} from "../merge-status.js";
```

In the **project POST route**, after `parseComparisons` succeeds, resolve stored targets (request > stored > default):

```ts
      const stored = await fastify.storage.mergeTargets.getForBranches(
        project.id,
        comparisons.map((c) => c.branch),
      );
      const effective: MergeComparison[] = comparisons.map((c) => {
        if (c.target !== undefined) return c;
        const storedTarget = stored.get(c.branch);
        return storedTarget === undefined ? c : { branch: c.branch, target: storedTarget };
      });
      const sources: TargetSource[] = comparisons.map((c) =>
        c.target !== undefined ? "request" : stored.has(c.branch) ? "stored" : "default",
      );
```

Replace the **remote proxy branch**'s response handling (`const data = ...` onward) with:

```ts
        const data = result.data as { entries?: MergeStatusPairEntry[] };
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (entries.length !== effective.length) {
          // Ordering contract violated — refuse rather than misattach metadata.
          return reply.code(502).send({ error: "Remote merge-status entry count mismatch" });
        }
        return reply.code(200).send({
          repository: {
            kind: "remote",
            remoteServerId: remoteConfig.serverId,
            label: remoteConfig.serverName,
          } satisfies MergeStatusRepository,
          entries: annotateEntries(entries, effective, sources),
        });
```

and pass `comparisons: effective` (instead of `comparisons`) in the `proxyToRemoteAuto` body.

Replace the **local tail** (`return sendComputed(...)`) with:

```ts
      try {
        return reply.code(200).send({
          repository: { kind: "local", label: "Local" } satisfies MergeStatusRepository,
          entries: annotateEntries(
            computeMergeStatusPairs(project.path, effective),
            effective,
            sources,
          ),
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const message = error instanceof Error ? error.message : "Failed to compute merge status";
        return reply.code(statusCode).send({ error: message });
      }
```

`sendComputed` stays — it still serves the path-based worker endpoint unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter vibedeckx exec vitest run src/routes/merge-status-routes.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full backend check and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
pnpm --filter vibedeckx test
git add packages/vibedeckx/src/routes/merge-status-routes.ts packages/vibedeckx/src/routes/merge-status-routes.test.ts
git commit -m "feat: resolve stored merge targets server-side with positional annotation"
```

---

### Task 4: Frontend API layer — `ProjectMergeStatusPairEntry` + `setMergeTarget`

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.ts` (import rename only)
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx`, `apps/vibedeckx-ui/hooks/use-merge-status.test.ts` (fixture fields only)

**Interfaces:**
- Produces (Tasks 5/7 rely on these):
  ```ts
  api.setMergeTarget(projectId: string, branch: string, target: string | null, opts?: { ifAbsent?: boolean }): Promise<boolean>
  export type TargetSource = "request" | "stored" | "default";
  export interface ProjectMergeStatusPairEntry { branch; target; targetSource; requestedTarget; status?; unmergedCount?; dirty?; error? }
  ```

- [ ] **Step 1: Update the types**

In `apps/vibedeckx-ui/lib/api.ts`, replace the `MergeStatusPairEntry` interface (`api.ts:296-304`) with:

```ts
export type TargetSource = "request" | "stored" | "default";

/** What the browser sees from /api/projects/:id/branches/merge-status —
 *  the computed entry plus server-attached target metadata. */
export interface ProjectMergeStatusPairEntry {
  branch: string;
  /** Resolved target branch; null when errored before resolution. */
  target: string | null;
  targetSource: TargetSource;
  /** The target the server asked the computation layer to compare against
   *  (request or stored), even when it doesn't exist; null only for
   *  default-target comparisons that errored. Warning UIs must read this,
   *  never `target` (which is null on target-not-found). */
  requestedTarget: string | null;
  status?: MergeStatusValue;
  unmergedCount?: number;
  dirty?: boolean;
  error?: MergePairError;
}
```

and update `MergeStatusBatchResult` (`api.ts:310-312`) to use `ProjectMergeStatusPairEntry[]`.

- [ ] **Step 2: Add the API method**

In `apps/vibedeckx-ui/lib/api.ts`, directly after `getMergeStatus`:

```ts
  async setMergeTarget(
    projectId: string,
    branch: string,
    target: string | null,
    opts?: { ifAbsent?: boolean },
  ): Promise<boolean> {
    try {
      const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/branches/merge-target`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch, target, ...(opts?.ifAbsent ? { ifAbsent: true } : {}) }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
```

- [ ] **Step 3: Fix the import and test fixtures**

- `apps/vibedeckx-ui/hooks/use-merge-status.ts:7`: rename the imported type `MergeStatusPairEntry` → `ProjectMergeStatusPairEntry` (three references: the import and the two function signatures at lines 47/59).
- In both hook test files, every mocked entry object gains the two now-required fields. Example — a fixture like
  `{ branch: "dev1", target: "main", status: "unmerged", unmergedCount: 1, dirty: false }` becomes
  `{ branch: "dev1", target: "main", targetSource: "default", requestedTarget: "main", status: "unmerged", unmergedCount: 1, dirty: false }`.
  Search both files for `entries: [` and update each object. Behavior is unchanged in this task — the hook ignores the extra fields.

- [ ] **Step 4: Verify**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status.test.ts hooks/use-merge-status.behavior.test.tsx
```
Expected: type-check clean, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks
git commit -m "feat: setMergeTarget API + ProjectMergeStatusPairEntry client type"
```

---

### Task 5: Hook rework — drop localStorage, warning state, server-driven default

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.ts`
- Test: `apps/vibedeckx-ui/hooks/use-merge-status.test.ts`, `apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx`

**Interfaces:**
- Consumes: `api.setMergeTarget`, `ProjectMergeStatusPairEntry` (Task 4).
- Produces (Task 8 relies on these exact shapes):
  ```ts
  export type BranchMergeInfo =
    | { branch: string; status: MergeStatusValue; unmergedCount: number; dirty: boolean; target: string; error?: undefined }
    | { branch: string; error: "target-not-found"; requestedTarget: string; targetSource: TargetSource };
  export function effectiveTarget(info: BranchMergeInfo | undefined): string | null;
  export function buildStatusMap(entries: ProjectMergeStatusPairEntry[]): Map<string, BranchMergeInfo>;
  export function deriveDefaultTarget(entries: ProjectMergeStatusPairEntry[]): string | null; // signature changed
  // setTarget(branch, target: string | null) now persists via the API
  ```

- [ ] **Step 1: Rewrite the pure-function tests**

In `apps/vibedeckx-ui/hooks/use-merge-status.test.ts`:
- Delete all tests for `mergeTargetStorageKey`, `readMergeTarget`-driven `buildComparisons`, and `staleTargetBranches`.
- Add/replace with:

```ts
import {
  buildStatusMap,
  deriveDefaultTarget,
  effectiveTarget,
  type BranchMergeInfo,
} from "./use-merge-status";
import type { ProjectMergeStatusPairEntry } from "@/lib/api";

describe("deriveDefaultTarget", () => {
  it("returns the target of the first default-sourced entry", () => {
    const entries: ProjectMergeStatusPairEntry[] = [
      { branch: "dev1", target: "release", targetSource: "stored", requestedTarget: "release", status: "merged", unmergedCount: 0, dirty: false },
      { branch: "dev2", target: "main", targetSource: "default", requestedTarget: "main", status: "unmerged", unmergedCount: 2, dirty: false },
    ];
    expect(deriveDefaultTarget(entries)).toBe("main");
  });

  it("is null when every entry has a stored target — a stored target must never masquerade as the default", () => {
    const entries: ProjectMergeStatusPairEntry[] = [
      { branch: "dev1", target: "release", targetSource: "stored", requestedTarget: "release", status: "merged", unmergedCount: 0, dirty: false },
    ];
    expect(deriveDefaultTarget(entries)).toBe(null);
  });

  it("ignores errored default entries (no-default-branch)", () => {
    const entries: ProjectMergeStatusPairEntry[] = [
      { branch: "dev1", target: null, targetSource: "default", requestedTarget: null, error: "no-default-branch" },
    ];
    expect(deriveDefaultTarget(entries)).toBe(null);
  });
});

describe("buildStatusMap", () => {
  it("maps ok entries and target-not-found warnings, skips other errors", () => {
    const entries: ProjectMergeStatusPairEntry[] = [
      { branch: "dev1", target: "main", targetSource: "default", requestedTarget: "main", status: "merged", unmergedCount: 0, dirty: true },
      { branch: "dev2", target: null, targetSource: "stored", requestedTarget: "ghost", error: "target-not-found" },
      { branch: "dev3", target: "main", targetSource: "default", requestedTarget: "main", error: "branch-not-found" },
    ];
    const map = buildStatusMap(entries);
    expect(map.get("dev1")).toEqual({ branch: "dev1", status: "merged", unmergedCount: 0, dirty: true, target: "main" });
    expect(map.get("dev2")).toEqual({ branch: "dev2", error: "target-not-found", requestedTarget: "ghost", targetSource: "stored" });
    expect(map.has("dev3")).toBe(false);
  });
});

describe("effectiveTarget", () => {
  it("returns target for ok entries, requestedTarget for warnings, null for undefined", () => {
    const ok: BranchMergeInfo = { branch: "d", status: "merged", unmergedCount: 0, dirty: false, target: "main" };
    const warn: BranchMergeInfo = { branch: "d", error: "target-not-found", requestedTarget: "ghost", targetSource: "stored" };
    expect(effectiveTarget(ok)).toBe("main");
    expect(effectiveTarget(warn)).toBe("ghost");
    expect(effectiveTarget(undefined)).toBe(null);
  });
});
```

Keep the existing `activeBranchSet` / `someActivityEnded` / `serializeBranchSet` tests untouched.

- [ ] **Step 2: Update the behavior tests**

In `apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx`:
- Extend the api mock: `vi.mock("@/lib/api", () => ({ api: { getMergeStatus: vi.fn(), setMergeTarget: vi.fn() } }))` and `const setMergeTarget = vi.mocked(api.setMergeTarget);` reset in `beforeEach` with `setMergeTarget.mockResolvedValue(true);`.
- Existing project-switch / keep-on-failure tests: unchanged apart from Task 4's fixture fields.
- Add:

```ts
describe("useMergeStatus (server-persisted targets)", () => {
  it("surfaces target-not-found as a warning entry and clears nothing", async () => {
    getMergeStatus.mockResolvedValue({
      ok: true,
      repository: { kind: "local", label: "Local" },
      entries: [
        { branch: "dev1", target: null, targetSource: "stored", requestedTarget: "ghost", error: "target-not-found" },
      ],
    });
    await render("p1", [{ branch: "dev1" }]);
    expect(latest!.statuses.get("dev1")).toEqual({
      branch: "dev1",
      error: "target-not-found",
      requestedTarget: "ghost",
      targetSource: "stored",
    });
    expect(setMergeTarget).not.toHaveBeenCalled(); // no auto-clear, ever
  });

  it("sends bare comparisons — no client-side targets", async () => {
    getMergeStatus.mockResolvedValue({ ok: true, repository: { kind: "local", label: "Local" }, entries: [] });
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release"); // legacy key must not leak into comparisons
    await render("p1", [{ branch: "dev1" }]);
    expect(getMergeStatus).toHaveBeenCalledWith("p1", [{ branch: "dev1" }]);
  });
});
```

(The legacy key in the second test IS imported by the Task 7 migration — that's fine; the assertion here is only about the comparisons payload. If this test runs before Task 7 exists, the key is simply ignored.)

Also add a `setTarget` test — expose `setTarget` from the Probe: extend `latest` with `setTarget` captured from the hook, then:

```ts
  it("setTarget persists via the API and refetches", async () => {
    getMergeStatus.mockResolvedValue({ ok: true, repository: { kind: "local", label: "Local" }, entries: [] });
    await render("p1", [{ branch: "dev1" }]);
    const callsBefore = getMergeStatus.mock.calls.length;

    await act(async () => {
      latest!.setTarget("dev1", "release");
    });
    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "release");
    expect(getMergeStatus.mock.calls.length).toBe(callsBefore + 1);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status.test.ts hooks/use-merge-status.behavior.test.tsx
```
Expected: FAIL — `buildStatusMap`/`effectiveTarget` don't exist, warning entries are skipped, comparisons still carry localStorage targets.

- [ ] **Step 4: Rewrite the hook**

In `apps/vibedeckx-ui/hooks/use-merge-status.ts`:

Delete `mergeTargetStorageKey`, `readMergeTarget`, `buildComparisons`, `staleTargetBranches` (and their `localStorage` usage in the effect + `setTarget`). Replace the type/import block and add the new pure functions:

```ts
import {
  api,
  type MergeComparison,
  type ProjectMergeStatusPairEntry,
  type MergeStatusValue,
  type TargetSource,
  type Worktree,
} from "@/lib/api";

export type BranchMergeInfo =
  | {
      branch: string;
      status: MergeStatusValue;
      unmergedCount: number;
      dirty: boolean;
      target: string;
      error?: undefined;
    }
  | {
      /** Stored/requested target no longer exists (spec decision 3: the
       *  config is kept and the problem made visible, never auto-cleared). */
      branch: string;
      error: "target-not-found";
      requestedTarget: string;
      targetSource: TargetSource;
      /** Never set — lets pre-Task-8 consumers read `info.target` as
       *  undefined instead of failing the union property check. */
      target?: undefined;
    };

/** The target a consumer should point at (picker checked item, diff target):
 *  the computed target, or the missing requested target for warnings. */
export function effectiveTarget(info: BranchMergeInfo | undefined): string | null {
  if (!info) return null;
  return info.error ? info.requestedTarget : info.target;
}

/** Entry → UI state. target-not-found becomes a warning; other errors are
 *  skipped (branch gone / no default = nothing to badge). Pure — exported for tests. */
export function buildStatusMap(
  entries: ProjectMergeStatusPairEntry[],
): Map<string, BranchMergeInfo> {
  const map = new Map<string, BranchMergeInfo>();
  for (const entry of entries) {
    if (entry.error === "target-not-found" && entry.requestedTarget) {
      map.set(entry.branch, {
        branch: entry.branch,
        error: "target-not-found",
        requestedTarget: entry.requestedTarget,
        targetSource: entry.targetSource,
      });
      continue;
    }
    if (entry.error || !entry.target || !entry.status) continue;
    map.set(entry.branch, {
      branch: entry.branch,
      status: entry.status,
      unmergedCount: entry.unmergedCount ?? 0,
      dirty: entry.dirty ?? false,
      target: entry.target,
    });
  }
  return map;
}

/** The backend-resolved default: any entry the server annotated as
 *  default-sourced. Null when every branch has a stored/request target —
 *  a stored target must never masquerade as the project default.
 *  Pure — exported for tests. */
export function deriveDefaultTarget(
  entries: ProjectMergeStatusPairEntry[],
): string | null {
  for (const entry of entries) {
    if (entry.targetSource === "default" && entry.target) return entry.target;
  }
  return null;
}
```

In the fetch effect, the body becomes (localStorage and stale-cleanup gone):

```ts
      const comparisons: MergeComparison[] = branches.map((branch) => ({ branch }));
      const result = await api.getMergeStatus(projectId, comparisons);
      if (cancelled) return;
      if (!result.ok) return; // transport/server failure — keep previous statuses, touch nothing

      setStatuses(buildStatusMap(result.entries));
      setDefaultTarget(deriveDefaultTarget(result.entries));
      setRepositoryLabel(result.repository.label);
```

`setTarget` becomes:

```ts
  const setTarget = useCallback(
    (branch: string, target: string | null) => {
      if (!projectId) return;
      void api.setMergeTarget(projectId, branch, target).then((ok) => {
        if (ok) refetch();
      });
    },
    [projectId, refetch],
  );
```

Everything else in the file (project-switch reset, `useMergeStatusAutoRefresh`, the pure activity helpers) stays as-is.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status.test.ts hooks/use-merge-status.behavior.test.tsx
```
Expected: PASS. (`app-sidebar.tsx`/`page.tsx` still compile without changes: the warning member's `target?: undefined` keeps their `.target ?? mergeDefaultTarget` reads valid — they see `undefined` and fall back to the default until Task 8 switches them to `effectiveTarget`.)

- [ ] **Step 6: Type-check and commit**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
git add apps/vibedeckx-ui
git commit -m "feat: merge-target hook drops localStorage, adds warning state"
```

---

### Task 6: SSE listener for `merge-target:updated`

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.ts` (`useMergeStatusAutoRefresh`)
- Test: `apps/vibedeckx-ui/hooks/use-merge-status-auto-refresh.test.tsx`

**Interfaces:**
- Consumes: the `merge-target:updated` wire event (Task 2) via `useGlobalEventStream`.

- [ ] **Step 1: Write the failing test**

Append to `apps/vibedeckx-ui/hooks/use-merge-status-auto-refresh.test.tsx` (it already captures the stream listener via the `@/hooks/global-event-stream` mock):

```ts
describe("useMergeStatusAutoRefresh (merge-target:updated)", () => {
  it("refetches on a matching project's merge-target update, ignores others", () => {
    const refetch = vi.fn();
    render(refetch, new Map(), "p1");

    act(() => capturedListener!({ type: "merge-target:updated", projectId: "p2", branch: "dev1" }));
    expect(refetch).not.toHaveBeenCalled();

    act(() => capturedListener!({ type: "merge-target:updated", projectId: "p1", branch: "dev1" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status-auto-refresh.test.tsx`
Expected: FAIL — second `refetch` never fires.

- [ ] **Step 3: Implement**

In `useMergeStatusAutoRefresh` (`use-merge-status.ts`), extend the existing `useGlobalEventStream` callback:

```ts
  useGlobalEventStream((evt) => {
    if (evt.type === "executor:stopped" && evt.projectId === projectId) {
      refetch();
    }
    // Another device changed a merge target — the event is a cache
    // invalidation only; the refetch re-reads the database's truth.
    if (evt.type === "merge-target:updated" && evt.projectId === projectId) {
      refetch();
    }
  });
```

- [ ] **Step 4: Run tests, type-check, commit**

```bash
pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status-auto-refresh.test.tsx
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
git add apps/vibedeckx-ui/hooks
git commit -m "feat: refetch merge status on merge-target:updated SSE event"
```

---

### Task 7: One-time localStorage migration

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-merge-status.ts`
- Test: `apps/vibedeckx-ui/hooks/use-merge-status.behavior.test.tsx`

**Interfaces:**
- Consumes: `api.setMergeTarget(..., { ifAbsent: true })` (Task 4); legacy key format `vibedeckx:mergeTarget:<projectId>:<branch>`.
- Produces: `legacyTargetKeys(projectId)` (exported for tests); import runs before the project's first fetch when keys exist.

- [ ] **Step 1: Write the failing tests**

Append to `use-merge-status.behavior.test.tsx`:

```ts
describe("useMergeStatus (legacy localStorage migration)", () => {
  beforeEach(() => {
    getMergeStatus.mockResolvedValue({ ok: true, repository: { kind: "local", label: "Local" }, entries: [] });
  });

  it("imports legacy keys with ifAbsent before the first fetch, then removes them", async () => {
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release");
    localStorage.setItem("vibedeckx:mergeTarget:OTHER:dev9", "x"); // different project: untouched
    await render("p1", [{ branch: "dev1" }]);

    expect(setMergeTarget).toHaveBeenCalledWith("p1", "dev1", "release", { ifAbsent: true });
    // Import completes before the first fetch — no default-target flash.
    expect(Math.min(...setMergeTarget.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...getMergeStatus.mock.invocationCallOrder));
    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:dev1")).toBe(null);
    expect(localStorage.getItem("vibedeckx:mergeTarget:OTHER:dev9")).toBe("x");
  });

  it("removes the key when the server value wins (2xx either way = key obsolete)", async () => {
    setMergeTarget.mockResolvedValue(true); // route returns 200 whether the import won or lost
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release");
    await render("p1", [{ branch: "dev1" }]);
    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:dev1")).toBe(null);
  });

  it("keeps the key when the request fails, for retry on a later mount", async () => {
    setMergeTarget.mockResolvedValue(false);
    localStorage.setItem("vibedeckx:mergeTarget:p1:dev1", "release");
    await render("p1", [{ branch: "dev1" }]);
    expect(localStorage.getItem("vibedeckx:mergeTarget:p1:dev1")).toBe("release");
    expect(getMergeStatus).toHaveBeenCalled(); // a failed import never blocks the fetch
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status.behavior.test.tsx`
Expected: the new describe FAILs (`setMergeTarget` never called, keys untouched).

- [ ] **Step 3: Implement**

In `apps/vibedeckx-ui/hooks/use-merge-status.ts`, add above `useMergeStatus`:

```ts
// ---------------------------------------------------------------------------
// One-time import of pre-server localStorage targets
// (vibedeckx:mergeTarget:<projectId>:<branch>). ifAbsent semantics: a value
// already on the server (another device, an earlier import) always wins; a
// 2xx either way means the key is obsolete and is removed; a failed request
// keeps the key for retry on a later fetch. TEMPORARY — delete this block
// once legacy keys have drained (a release or two after 2026-07).
// ---------------------------------------------------------------------------

/** Legacy keys for one project. Pure over localStorage — exported for tests. */
export function legacyTargetKeys(
  projectId: string,
): { key: string; branch: string; target: string }[] {
  const prefix = `vibedeckx:mergeTarget:${projectId}:`;
  const found: { key: string; branch: string; target: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const target = localStorage.getItem(key);
      if (target) found.push({ key, branch: key.slice(prefix.length), target });
    }
  } catch {
    // localStorage unavailable (e.g. Safari private mode) — nothing to migrate.
  }
  return found;
}

// In-flight dedup: concurrent effect runs share one import; the entry is
// dropped on settle so remaining (failed) keys retry on the next fetch.
const legacyImports = new Map<string, Promise<void>>();

function ensureLegacyImport(projectId: string): Promise<void> {
  let pending = legacyImports.get(projectId);
  if (!pending) {
    pending = (async () => {
      for (const { key, branch, target } of legacyTargetKeys(projectId)) {
        const ok = await api.setMergeTarget(projectId, branch, target, { ifAbsent: true });
        if (ok) {
          try {
            localStorage.removeItem(key);
          } catch {
            // ignore — retried next time, insertIfAbsent makes re-imports harmless
          }
        }
      }
    })().finally(() => {
      legacyImports.delete(projectId);
    });
    legacyImports.set(projectId, pending);
  }
  return pending;
}
```

In the fetch effect, right before `const comparisons: MergeComparison[] = ...`:

```ts
      // Legacy import must land before the first fetch so the UI never
      // flashes default-target badges that flip a beat later. Steady state
      // (no keys) skips the await entirely.
      if (legacyTargetKeys(projectId).length > 0) {
        await ensureLegacyImport(projectId);
        if (cancelled) return;
      }
```

- [ ] **Step 4: Run tests, type-check, commit**

```bash
pnpm --filter vibedeckx-ui exec vitest run hooks/use-merge-status.behavior.test.tsx hooks/use-merge-status.test.ts
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
git add apps/vibedeckx-ui/hooks
git commit -m "feat: one-time localStorage merge-target import (ifAbsent)"
```

---

### Task 8: UI — warning badge, "Default branch (auto)" reset, consumer wiring

**Files:**
- Modify: `apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/workspace-row-menu.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx:398-415` (+ its props)
- Modify: `apps/vibedeckx-ui/app/page.tsx:661-665` and the `onMergeTargetChange` pass-through
- Test: Create `apps/vibedeckx-ui/components/layout/workspace-merge-badge.test.ts`

**Interfaces:**
- Consumes: `BranchMergeInfo` union + `effectiveTarget` (Task 5); `setTarget(branch, null)` reset (Task 5).
- Produces: `WorkspaceRowMenu` gains prop `onTargetReset: () => void`; `AppSidebarProps.onMergeTargetChange` widens to `(branch: string, target: string | null) => void`.

- [ ] **Step 1: Write the failing badge test**

Create `apps/vibedeckx-ui/components/layout/workspace-merge-badge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeBadgeAriaLabel } from "./workspace-merge-badge";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

describe("mergeBadgeAriaLabel", () => {
  it("keeps the ok-shape labels", () => {
    const info: BranchMergeInfo = { branch: "dev1", status: "merged", unmergedCount: 0, dirty: false, target: "main" };
    expect(mergeBadgeAriaLabel(info, "Local")).toBe("Merged into main · Local");
  });

  it("describes a missing target using requestedTarget", () => {
    const info: BranchMergeInfo = { branch: "dev1", error: "target-not-found", requestedTarget: "ghost", targetSource: "stored" };
    expect(mergeBadgeAriaLabel(info)).toBe(
      "Target branch 'ghost' not found — pick a new target or reset to default",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx-ui exec vitest run components/layout/workspace-merge-badge.test.ts`
Expected: FAIL (warning member breaks `info.target` access / label mismatch).

- [ ] **Step 3: Implement the badge warning variant**

In `workspace-merge-badge.tsx`:

```tsx
import { Check, CheckCheck, TriangleAlert } from "lucide-react";
```

`mergeBadgeAriaLabel` gains a warning branch at the top:

```ts
export function mergeBadgeAriaLabel(
  info: BranchMergeInfo,
  repositoryLabel?: string | null,
): string {
  if (info.error) {
    const label = `Target branch '${info.requestedTarget}' not found — pick a new target or reset to default`;
    return repositoryLabel ? `${label} · ${repositoryLabel}` : label;
  }
  // ...existing body unchanged
}
```

In the JSX, render the warning icon first and guard the dirty dot (the warning shape has no `dirty`):

```tsx
          {info.error ? (
            <TriangleAlert className="h-3 w-3 text-amber-500" />
          ) : info.status === "merged" ? (
            <Check className="h-3 w-3 text-muted-foreground/70" />
          ) : info.status === "no-unique-commits" ? (
            <CheckCheck className="h-3 w-3 text-emerald-500" />
          ) : (
            <span className="text-[10px] font-mono leading-none text-amber-500">
              {info.unmergedCount}
            </span>
          )}
          {!info.error && info.dirty && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-orange-400" />
          )}
```

Clicking a warning badge still fires `onClick` (opens the Diff tab pointed at the missing branch, which reports its own error) — acceptable; the tooltip carries the guidance.

- [ ] **Step 4: Add the reset entry to the row menu**

In `workspace-row-menu.tsx`: add `onTargetReset: () => void;` to `WorkspaceRowMenuProps` (and destructure it), import `DropdownMenuSeparator` from the same dropdown-menu module, and inside `DropdownMenuSubContent`, after the branch list (render alongside both the loaded and empty states, i.e. right after the `branches === null ? ... : ...` expression):

```tsx
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onTargetReset()}>
              {/* Deliberately name-free: with every branch on a stored target the
                  default's name is unknown client-side (deriveDefaultTarget is
                  null); the next fetch shows the actual resolved target. */}
              <span className="text-xs">Default branch (auto)</span>
            </DropdownMenuItem>
```

- [ ] **Step 5: Wire the consumers**

`app-sidebar.tsx`:
- Import: `import { effectiveTarget, type BranchMergeInfo } from "@/hooks/use-merge-status";` (extend the existing type-only import at line 12).
- Widen the prop (line 26 region): `onMergeTargetChange?: (branch: string, target: string | null) => void;`
- Lines 409-411 become:

```tsx
                            currentTarget={
                              effectiveTarget(mergeStatuses?.get(wt.branch)) ?? mergeDefaultTarget ?? null
                            }
```

- Add to the `WorkspaceRowMenu` element:

```tsx
                            onTargetReset={() => onMergeTargetChange?.(wt.branch!, null)}
```

`page.tsx`:
- Import `effectiveTarget` from `@/hooks/use-merge-status`.
- Lines 661-665 become:

```tsx
                    mergeTarget={
                      selectedBranch
                        ? (effectiveTarget(mergeStatuses.get(selectedBranch)) ?? mergeDefaultTarget)
                        : null
                    }
```

- `setMergeTarget` (the hook's `setTarget`, passed at line 568 as `onMergeTargetChange`) already accepts `string | null` after Task 5 — no change needed there; just confirm the prop type widening compiles.

- [ ] **Step 6: Run tests, type-check, lint**

```bash
pnpm --filter vibedeckx-ui exec vitest run components/layout/workspace-merge-badge.test.ts
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui lint
```
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui
git commit -m "feat: merge-target warning badge + default-branch reset menu entry"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full test suites + type-checks**

```bash
pnpm --filter vibedeckx test
pnpm --filter vibedeckx-ui exec vitest run
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
pnpm --filter vibedeckx-ui lint
```
Expected: everything green. Fix regressions before proceeding (most likely spot: other frontend files importing the removed `buildComparisons`/`mergeTargetStorageKey` — `grep -rn "mergeTargetStorageKey\|staleTargetBranches" apps/vibedeckx-ui` must come back empty).

- [ ] **Step 2: End-to-end smoke (dev servers)**

Run `pnpm dev:all`, open http://localhost:3000, then:
1. Pick a workspace branch → row menu → "Compare against" → choose a non-default branch. Badge updates.
2. Open a second browser window (same profile or another browser against the same backend) → same project shows the same target without any localStorage state; changing the target in one window updates the other within a second (SSE) — watch for the refetch, no reload.
3. `sqlite3 ~/.vibedeckx/data.sqlite "SELECT * FROM branch_merge_targets;"` shows the row.
4. Delete the chosen target branch in the repo (`git branch -D <target>` — pick a throwaway) → badge flips to the amber warning triangle with the "'<name>' not found" tooltip; the DB row is still there.
5. Row menu → "Default branch (auto)" → badge recovers on the default target; DB row gone.

- [ ] **Step 3: Commit any fixups, then hand off**

Use superpowers:finishing-a-development-branch to decide merge/PR next steps.
