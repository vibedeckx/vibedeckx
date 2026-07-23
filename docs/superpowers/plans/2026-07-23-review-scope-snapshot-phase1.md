# Review Scope Snapshot — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the workflow reviewer to exactly the files the reviewed turn changed, computed from per-turn git snapshots, so it stops auditing unrelated pre-existing worktree changes.

**Architecture:** Capture a lightweight git snapshot (`head` + `path→blobSha` map of uncommitted files) at session start and at each turn end. At review time, compute the changed-file set as the content-hash delta between the start-boundary snapshot and a live review-time snapshot, then name those files (and the start commit) in the reviewer prompt with a scope-discipline instruction. Phase 1 hardcodes the "this turn" span.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports need `.js`), Fastify backend, Kysely over better-sqlite3, vitest (colocated `*.test.ts`), git via `execFileSync`.

## Global Constraints

- Backend is ESM with NodeNext resolution — **every local import needs a `.js` extension**.
- Storage queries go through Kysely (`kdb`), not raw SQL, except table DDL in `sqlite.ts`.
- All snapshot capture is **best-effort and non-fatal**: any git/storage failure logs a warning and degrades to the pre-feature reviewer behavior. It must never throw into the turn lifecycle or block review start.
- Snapshot capture only runs for local (`!skipDb`) sessions. Remote path-based sessions (`skipDb`) are handled worker-side and are out of scope here.
- The absence sentinel for a deleted/non-existent file is the exact string `"absent"` (defined once as `ABSENT`), never a git blob sha (blob shas are 40 hex chars).
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Tests: `cd packages/vibedeckx && npx vitest run <path>`.

---

### Task 1: `turn_snapshots` storage table + repository

**Files:**
- Modify: `packages/vibedeckx/src/storage/schema.ts` (add table type + register in `DB`)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts:820-836` area (add DDL) and `:893-903` (wire repo)
- Modify: `packages/vibedeckx/src/storage/types.ts:714` area (add `turnSnapshots` to `Storage`)
- Create: `packages/vibedeckx/src/storage/repositories/turn-snapshots.ts`
- Test: `packages/vibedeckx/src/storage/turn-snapshots.test.ts`

**Interfaces:**
- Produces:
  - `Storage["turnSnapshots"]` with:
    - `create(opts: { session_id: string; turn_end_index: number; head: string; dirty: Record<string, string> }): Promise<void>`
    - `getStartBoundary(session_id: string, turnEndIndex: number): Promise<{ head: string; dirty: Record<string, string> } | undefined>` — the snapshot with the largest `turn_end_index` strictly `<` the argument (includes the `-1` session-start row).

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/turn-snapshots.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("turnSnapshots repository", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-snap-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
    await storage.agentSessions.create({
      id: "s1", project_id: "p1", branch: "dev",
      permission_mode: "edit", agent_type: "claude-code",
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and round-trips the dirty map", async () => {
    await storage.turnSnapshots.create({
      session_id: "s1", turn_end_index: -1, head: "AAA",
      dirty: { "a.ts": "sha-a", "gone.ts": "absent" },
    });
    const snap = await storage.turnSnapshots.getStartBoundary("s1", 5);
    expect(snap).toEqual({ head: "AAA", dirty: { "a.ts": "sha-a", "gone.ts": "absent" } });
  });

  it("getStartBoundary returns the largest index strictly below the argument", async () => {
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: -1, head: "H0", dirty: {} });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 7, head: "H7", dirty: {} });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 12, head: "H12", dirty: {} });
    expect((await storage.turnSnapshots.getStartBoundary("s1", 12))?.head).toBe("H7");
    expect((await storage.turnSnapshots.getStartBoundary("s1", 7))?.head).toBe("H0");
    expect(await storage.turnSnapshots.getStartBoundary("s1", -1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/storage/turn-snapshots.test.ts`
Expected: FAIL — `storage.turnSnapshots` is undefined.

- [ ] **Step 3: Add the schema table type**

In `packages/vibedeckx/src/storage/schema.ts`, after the `WorkflowRunsTable` interface (~line 271-286) add:

```typescript
export interface TurnSnapshotsTable {
  session_id: string;
  turn_end_index: number;
  head: string;
  dirty: string; // JSON: Record<string, string> (path -> blobSha | "absent")
  captured_at: number;
}
```

And in the `DB` interface (~line 302-327), after `workflow_runs: WorkflowRunsTable;` add:

```typescript
  turn_snapshots: TurnSnapshotsTable;
```

- [ ] **Step 4: Add the DDL**

In `packages/vibedeckx/src/storage/sqlite.ts`, immediately after the `workflow_runs` `CREATE TABLE` block (ends ~line 836), inside the same `db.exec(\`...\`)` or a new `db.exec`, add:

```sql
CREATE TABLE IF NOT EXISTS turn_snapshots (
  session_id TEXT NOT NULL,
  turn_end_index INTEGER NOT NULL,
  head TEXT NOT NULL,
  dirty TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_end_index),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);
```

- [ ] **Step 5: Create the repository**

Create `packages/vibedeckx/src/storage/repositories/turn-snapshots.ts`:

```typescript
import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { Storage } from "../types.js";

export const createTurnSnapshotRepos = (kdb: Kysely<DB>): Pick<Storage, "turnSnapshots"> => ({
  turnSnapshots: {
    create: async (opts) => {
      await kdb
        .insertInto("turn_snapshots")
        .values({
          session_id: opts.session_id,
          turn_end_index: opts.turn_end_index,
          head: opts.head,
          dirty: JSON.stringify(opts.dirty),
          captured_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(["session_id", "turn_end_index"]).doNothing())
        .execute();
    },
    getStartBoundary: async (session_id, turnEndIndex) => {
      const row = await kdb
        .selectFrom("turn_snapshots")
        .select(["head", "dirty"])
        .where("session_id", "=", session_id)
        .where("turn_end_index", "<", turnEndIndex)
        .orderBy("turn_end_index", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!row) return undefined;
      return { head: row.head, dirty: JSON.parse(row.dirty) as Record<string, string> };
    },
  },
});
```

- [ ] **Step 6: Wire the repository and extend the `Storage` interface**

In `packages/vibedeckx/src/storage/sqlite.ts`, add the import near the other repo imports (~line 19):

```typescript
import { createTurnSnapshotRepos } from "./repositories/turn-snapshots.js";
```

And in the returned storage object (~line 893-903), add after `...createWorkflowRunRepos(kdb),`:

```typescript
    ...createTurnSnapshotRepos(kdb),
```

In `packages/vibedeckx/src/storage/types.ts`, inside the `Storage` interface after the `workflowRuns: { ... };` block (ends ~line 714), add:

```typescript
  turnSnapshots: {
    create(opts: {
      session_id: string;
      turn_end_index: number;
      head: string;
      dirty: Record<string, string>;
    }): Promise<void>;
    getStartBoundary(
      session_id: string,
      turnEndIndex: number,
    ): Promise<{ head: string; dirty: Record<string, string> } | undefined>;
  };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/storage/turn-snapshots.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/storage/
git commit -m "feat(review): add turn_snapshots storage table and repository"
```

---

### Task 2: `captureSnapshot` + `SnapshotState`

**Files:**
- Create: `packages/vibedeckx/src/utils/review-snapshot.ts`
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `interface SnapshotState { head: string; dirty: Record<string, string>; }`
  - `const ABSENT = "absent"`
  - `captureSnapshot(worktreePath: string): SnapshotState | null` — `null` when git fails (e.g. no commits / not a repo). `dirty` covers every uncommitted path (modified, staged, untracked); deletions map to `ABSENT`, everything else to its `git hash-object` blob sha.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/utils/review-snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, rmSync as rmFile } from "fs";
import { tmpdir } from "os";
import path from "path";
import { captureSnapshot, ABSENT } from "./review-snapshot.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vdx-cap-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "kept.ts"), "const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

describe("captureSnapshot", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("clean tree yields empty dirty map and current head", () => {
    const snap = captureSnapshot(dir)!;
    expect(snap.head).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(snap.dirty).toEqual({});
  });

  it("hashes an untracked file", () => {
    writeFileSync(path.join(dir, "new.ts"), "x\n");
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["new.ts"]).toBe(git(dir, ["hash-object", "new.ts"]));
  });

  it("hashes a modified tracked file", () => {
    writeFileSync(path.join(dir, "kept.ts"), "const a = 2;\n");
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["kept.ts"]).toBe(git(dir, ["hash-object", "kept.ts"]));
  });

  it("records a deletion as the ABSENT sentinel", () => {
    rmFile(path.join(dir, "kept.ts"));
    const snap = captureSnapshot(dir)!;
    expect(snap.dirty["kept.ts"]).toBe(ABSENT);
  });

  it("returns null when not a git repo", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vdx-norepo-"));
    expect(captureSnapshot(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts`
Expected: FAIL — cannot find module `./review-snapshot.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/vibedeckx/src/utils/review-snapshot.ts`:

```typescript
import { execFileSync } from "child_process";

const MAX_BUFFER = 10 * 1024 * 1024;

/** Sentinel content hash for a path that does not exist at a boundary. */
export const ABSENT = "absent";

export interface SnapshotState {
  head: string;
  /** path -> git blob sha of the uncommitted content, or ABSENT for a deletion. */
  dirty: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Capture the worktree's git state at a turn boundary: the current HEAD plus a
 * content-hash of every uncommitted file. Rename detection is disabled so a
 * rename reads as delete-old + add-new (each path keyed independently).
 * Returns null on any git failure (no commits, not a repo) — callers degrade.
 */
export function captureSnapshot(worktreePath: string): SnapshotState | null {
  try {
    const head = git(worktreePath, ["rev-parse", "HEAD"]).trim();
    const dirty: Record<string, string> = {};

    // Tracked changes vs HEAD (staged + unstaged), no rename detection.
    // Lines: "<status>\t<path>", e.g. "M\tsrc/a.ts", "D\tsrc/gone.ts".
    const nameStatus = git(worktreePath, ["diff", "HEAD", "--name-status", "--no-renames"]);
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const status = line.slice(0, tab).trim();
      const p = line.slice(tab + 1).trim();
      dirty[p] = status.startsWith("D") ? ABSENT : git(worktreePath, ["hash-object", p]).trim();
    }

    // Untracked files (never added) — always additions.
    const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    for (const p of untracked.split("\n")) {
      const t = p.trim();
      if (t) dirty[t] = git(worktreePath, ["hash-object", t]).trim();
    }

    return { head, dirty };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.ts packages/vibedeckx/src/utils/review-snapshot.test.ts
git commit -m "feat(review): add captureSnapshot git boundary capture"
```

---

### Task 3: `computeScope`

**Files:**
- Modify: `packages/vibedeckx/src/utils/review-snapshot.ts`
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts`

**Interfaces:**
- Consumes: `SnapshotState`, `ABSENT` (Task 2).
- Produces:
  - `computeScope(start: SnapshotState, end: SnapshotState, worktreePath: string): { changedFiles: string[]; startHead: string }` — files whose effective content blob sha differs between the two boundaries (sorted); `startHead` = `start.head`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/vibedeckx/src/utils/review-snapshot.test.ts`:

```typescript
import { computeScope } from "./review-snapshot.js";

describe("computeScope", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("excludes a pre-existing dirty file untouched by the turn; includes the new one", () => {
    // start: request-url.ts already dirty (h1). end: same request-url.ts (h1) + new actions.ts (h4)
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": "h1" } };
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": "h1", "actions.ts": "h4" } };
    const scope = computeScope(start, end, dir);
    expect(scope.changedFiles).toEqual(["actions.ts"]);
    expect(scope.startHead).toBe(start.head);
  });

  it("excludes a file whose prior uncommitted content was merely committed between boundaries", () => {
    // request-url.ts dirty with content C at start; user commits exactly C between turns.
    writeFileSync(path.join(dir, "request-url.ts"), "C\n");
    const startSha = git(dir, ["hash-object", "request-url.ts"]);
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "request-url.ts": startSha } };
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "commit request-url"]);
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: {} };
    // The committed blob equals startSha, so content is unchanged across boundaries.
    expect(computeScope(start, end, dir).changedFiles).toEqual([]);
  });

  it("includes an uncommitted deletion", () => {
    const start = { head: git(dir, ["rev-parse", "HEAD"]), dirty: {} };
    const end = { head: git(dir, ["rev-parse", "HEAD"]), dirty: { "kept.ts": ABSENT } };
    expect(computeScope(start, end, dir).changedFiles).toEqual(["kept.ts"]);
  });

  it("includes files changed by commits between the two heads", () => {
    const startHead = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(dir, "kept.ts"), "committed change\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "turn commit"]);
    const endHead = git(dir, ["rev-parse", "HEAD"]);
    const scope = computeScope({ head: startHead, dirty: {} }, { head: endHead, dirty: {} }, dir);
    expect(scope.changedFiles).toEqual(["kept.ts"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t computeScope`
Expected: FAIL — `computeScope` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/vibedeckx/src/utils/review-snapshot.ts`:

```typescript
/** Blob sha of `path` at `head`, or ABSENT if it does not exist there. */
function blobShaOrAbsent(worktreePath: string, head: string, filePath: string): string {
  try {
    return git(worktreePath, ["rev-parse", `${head}:${filePath}`]).trim();
  } catch {
    return ABSENT;
  }
}

/**
 * The set of files whose effective content changed between two boundary
 * snapshots. Effective content = the uncommitted blob if the file is dirty at
 * that boundary, otherwise the committed blob at that boundary's HEAD.
 * Comparison is by content sha, so pure status churn (staging, committing the
 * same content, prior-turn dirt left untouched) is correctly excluded.
 */
export function computeScope(
  start: SnapshotState,
  end: SnapshotState,
  worktreePath: string,
): { changedFiles: string[]; startHead: string } {
  const candidates = new Set<string>();

  if (start.head !== end.head) {
    const committed = git(worktreePath, ["diff", "--name-only", "--no-renames", start.head, end.head]);
    for (const line of committed.split("\n")) {
      const p = line.trim();
      if (p) candidates.add(p);
    }
  }
  for (const p of Object.keys(start.dirty)) candidates.add(p);
  for (const p of Object.keys(end.dirty)) candidates.add(p);

  const changed: string[] = [];
  for (const f of candidates) {
    const startSha = start.dirty[f] ?? blobShaOrAbsent(worktreePath, start.head, f);
    const endSha = end.dirty[f] ?? blobShaOrAbsent(worktreePath, end.head, f);
    if (startSha !== endSha) changed.push(f);
  }
  changed.sort();
  return { changedFiles: changed, startHead: start.head };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts`
Expected: PASS (all captureSnapshot + computeScope tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.ts packages/vibedeckx/src/utils/review-snapshot.test.ts
git commit -m "feat(review): add computeScope snapshot delta"
```

---

### Task 4: Capture hooks + `recordTurnSnapshot` helper

**Files:**
- Modify: `packages/vibedeckx/src/utils/review-snapshot.ts` (add `recordTurnSnapshot`)
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` (session-start at `createNewSession` ~line 491; turn-end at `endActiveTurn` ~line 1415)
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts` (helper test with real git + sqlite)

**Interfaces:**
- Consumes: `captureSnapshot` (Task 2), `Storage["turnSnapshots"]` (Task 1), `resolveWorktreePath` (`utils/worktree-paths.js`).
- Produces:
  - `recordTurnSnapshot(storage: Storage, sessionId: string, turnEndIndex: number, worktreePath: string): Promise<void>` — best-effort; captures + persists, swallows all errors with a warning.

- [ ] **Step 1: Write the failing test**

Append to `packages/vibedeckx/src/utils/review-snapshot.test.ts`:

```typescript
import { recordTurnSnapshot } from "./review-snapshot.js";
import { createSqliteStorage } from "../storage/sqlite.js";

describe("recordTurnSnapshot", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a snapshot that getStartBoundary can read back", async () => {
    const storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    await storage.agentSessions.create({
      id: "s1", project_id: "p1", branch: "dev",
      permission_mode: "edit", agent_type: "claude-code",
    });
    writeFileSync(path.join(dir, "new.ts"), "x\n");
    await recordTurnSnapshot(storage, "s1", -1, dir);
    const snap = await storage.turnSnapshots.getStartBoundary("s1", 0);
    expect(snap?.head).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(snap?.dirty["new.ts"]).toBe(git(dir, ["hash-object", "new.ts"]));
    await storage.close();
  });

  it("never throws on a bad worktree path", async () => {
    const storage = await createSqliteStorage(path.join(dir, "db2.sqlite"));
    await expect(recordTurnSnapshot(storage, "missing", -1, "/no/such/path")).resolves.toBeUndefined();
    await storage.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t recordTurnSnapshot`
Expected: FAIL — `recordTurnSnapshot` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `packages/vibedeckx/src/utils/review-snapshot.ts`:

```typescript
import type { Storage } from "../storage/types.js";

/**
 * Capture + persist a turn-boundary snapshot. Best-effort: any failure logs and
 * returns, so review scoping degrades but the turn lifecycle is never disrupted.
 */
export async function recordTurnSnapshot(
  storage: Storage,
  sessionId: string,
  turnEndIndex: number,
  worktreePath: string,
): Promise<void> {
  try {
    const snap = captureSnapshot(worktreePath);
    if (!snap) return;
    await storage.turnSnapshots.create({
      session_id: sessionId,
      turn_end_index: turnEndIndex,
      head: snap.head,
      dirty: snap.dirty,
    });
  } catch (err) {
    console.warn(`[ReviewSnapshot] failed to record snapshot for ${sessionId}@${turnEndIndex}:`, (err as Error).message);
  }
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t recordTurnSnapshot`
Expected: PASS (both).

- [ ] **Step 5: Wire the session-start hook**

In `packages/vibedeckx/src/agent-session-manager.ts`, add the import near the top with the other `utils/` imports:

```typescript
import { recordTurnSnapshot } from "./utils/review-snapshot.js";
```

In `createNewSession`, right after the `if (!skipDb) { await this.storage.agentSessions.create({...}); }` block (~line 491) add the session-start baseline capture:

```typescript
    if (!skipDb) {
      await recordTurnSnapshot(this.storage, sessionId, -1, absoluteWorktreePath);
    }
```

(`absoluteWorktreePath` is already in scope from line 481.)

- [ ] **Step 6: Wire the turn-end hook**

In `endActiveTurn` (~line 1408-1418), after `const index = await this.pushEntry(...)` and before `return`, add a best-effort turn-boundary capture for local sessions:

```typescript
    if (!session.skipDb && index >= 0) {
      const project = await this.storage.projects.getById(session.projectId);
      if (project?.path) {
        await recordTurnSnapshot(this.storage, session.id, index, resolveWorktreePath(project.path, session.branch));
      }
    }
```

Confirm `resolveWorktreePath` is imported in this file (it is used at `createNewSession`; if the import is not already present, add `import { resolveWorktreePath } from "./utils/worktree-paths.js";`).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Run the full snapshot test file**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.ts packages/vibedeckx/src/agent-session-manager.ts
git commit -m "feat(review): capture turn snapshots at session start and turn end"
```

---

### Task 5: Engine integration + reviewer prompt scope section

**Files:**
- Modify: `packages/vibedeckx/src/workflow-engine.ts` (compute scope ~line 431-438; pass to `buildReviewerPrompt` ~line 522; extend `buildReviewerPrompt` signature + body ~line 155-203)
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Interfaces:**
- Consumes: `computeScope`, `captureSnapshot` (Tasks 2-3), `storage.turnSnapshots.getStartBoundary` (Task 1).
- Produces: `buildReviewerPrompt` gains an optional opt `scope: { changedFiles: string[]; startHead: string } | null`. When present with a non-empty `changedFiles`, the prompt renders a `## Scope` section; otherwise it renders the existing behavior plus a "scope unknown" note.

- [ ] **Step 1: Write the failing test**

Append to `packages/vibedeckx/src/workflow-engine.test.ts` (find the existing `describe("buildReviewerPrompt", ...)` block and add these cases; if none exists, add a new `describe`):

```typescript
import { buildReviewerPrompt } from "./workflow-engine.js";

describe("buildReviewerPrompt scope", () => {
  const target = { baseHead: "abc123", diffDigest: "d", diffStat: "1 file changed", capturedAt: 1 };

  it("names the scoped files and start commit when scope is present", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "fix login", originalIntent: "fix login",
      authorSelfReport: null, intentBrief: null, reviewFocus: null, target,
      scope: { changedFiles: ["app/signin/actions.ts"], startHead: "base9" },
    });
    expect(prompt).toContain("app/signin/actions.ts");
    expect(prompt).toContain("base9");
    expect(prompt).toContain("Confine your review");
    expect(prompt).not.toContain("scope unknown");
  });

  it("falls back to a scope-unknown note when scope is null", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "fix login", originalIntent: "fix login",
      authorSelfReport: null, intentBrief: null, reviewFocus: null, target,
      scope: null,
    });
    expect(prompt).toContain("scope unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts -t "buildReviewerPrompt scope"`
Expected: FAIL — `buildReviewerPrompt` has no `scope` option / assertions unmet.

- [ ] **Step 3: Extend `buildReviewerPrompt`**

In `packages/vibedeckx/src/workflow-engine.ts`, add to the `buildReviewerPrompt` opts type (after `intentBrief?: string | null;` ~line 168):

```typescript
  /**
   * Files the reviewed turn actually changed, from snapshot delta. When set
   * with a non-empty list, the prompt confines the reviewer to these files and
   * treats everything else in the worktree as out of scope. Null when snapshots
   * were unavailable (pre-feature session or capture failure) — the prompt then
   * tells the reviewer the scope is unknown.
   */
  scope?: { changedFiles: string[]; startHead: string } | null;
```

Then add one computed line before the `return [` (right after `const hasExcerpt = ...`, ~line 176):

```typescript
  const scope = opts.scope && opts.scope.changedFiles.length > 0 ? opts.scope : null;
```

And insert the following entry **into the return array immediately after the `opts.reviewFocus ? ... : null,` line (~line 186) and before `"\n## How to review",`** (this is the single, canonical insertion point):

```typescript
    scope
      ? `\n## Scope — the change under review\nThe reviewed turn changed exactly these files:\n${scope.changedFiles.map((f) => `- ${f}`).join("\n")}\nIt starts from commit \`${scope.startHead}\` — use \`git diff ${scope.startHead} -- <file>\` and \`git log ${scope.startHead}..HEAD\` to see the content.\nConfine your review to these files and changes. Other uncommitted or pre-existing changes in the worktree, or changes from other turns, are out of scope unless this change depends on them.`
      : opts.scope === null
        ? "\n## Scope\nThe changed-file set could not be determined (scope unknown) — inspect `git diff`/`git status`/`git log` and judge the relevant range yourself."
        : null,
```

Note: `opts.scope === null` distinguishes "feature ran, no scope" from "opt omitted" (older callers). When `scope` is `undefined` (not passed), no scope section renders — preserving existing tests.

- [ ] **Step 4: Compute scope in the engine and pass it through**

In `packages/vibedeckx/src/workflow-engine.ts`, add the import near line 5:

```typescript
import { captureSnapshot, computeScope } from "./utils/review-snapshot.js";
```

At the review-start capture site (~line 437-438), after `const target = captureReviewTarget(worktreePath);` add:

```typescript
      let scope: { changedFiles: string[]; startHead: string } | null = null;
      try {
        const endSnap = captureSnapshot(worktreePath);
        const startSnap = await this.storage.turnSnapshots.getStartBoundary(opts.sourceSessionId, turnEndIndex);
        if (endSnap && startSnap) scope = computeScope(startSnap, endSnap, worktreePath);
      } catch (err) {
        console.warn("[WorkflowEngine] scope computation failed:", (err as Error).message);
      }
```

Then in the `buildReviewerPrompt({ ... })` call (~line 522-529) add `scope,` to the options object:

```typescript
        const prompt = buildReviewerPrompt({
          taskContext,
          originalIntent: extractFirstUserMessage(entries),
          authorSelfReport: extractAuthorSelfReport(entries, turnEndIndex),
          intentBrief: opts.intentBrief ?? null,
          reviewFocus: opts.reviewFocus ?? null,
          target,
          scope,
        });
```

- [ ] **Step 5: Run the prompt tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts -t "buildReviewerPrompt scope"`
Expected: PASS.

- [ ] **Step 6: Run the full workflow-engine test file to check for regressions**

Run: `cd packages/vibedeckx && npx vitest run src/workflow-engine.test.ts`
Expected: PASS (existing `buildReviewerPrompt` tests still pass — they omit `scope`, so no scope section renders).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/workflow-engine.ts packages/vibedeckx/src/workflow-engine.test.ts
git commit -m "feat(review): scope reviewer prompt to snapshot-delta changed files"
```

---

### Task 6: End-to-end verification against the motivating scenario

**Files:**
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts` (integration case tying capture → compute)

**Interfaces:**
- Consumes: `recordTurnSnapshot`, `captureSnapshot`, `computeScope`, storage (all prior tasks).

- [ ] **Step 1: Write the scenario test**

Append to `packages/vibedeckx/src/utils/review-snapshot.test.ts`:

```typescript
describe("scenario: fix isolated from pre-existing dirt", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names only the fix file, not the pre-existing uncommitted change", async () => {
    const storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    await storage.agentSessions.create({
      id: "s1", project_id: "p1", branch: "dev",
      permission_mode: "edit", agent_type: "claude-code",
    });

    // Pre-existing uncommitted change from earlier work.
    writeFileSync(path.join(dir, "request-url.ts"), "earlier work\n");
    // Session-start baseline (index -1).
    await recordTurnSnapshot(storage, "s1", -1, dir);

    // The fix turn edits actions.ts only, leaves it uncommitted.
    writeFileSync(path.join(dir, "actions.ts"), "the fix\n");
    await recordTurnSnapshot(storage, "s1", 5, dir);

    // Review turn 5, "this turn" span: start = getStartBoundary(5) = the -1 baseline.
    const startSnap = (await storage.turnSnapshots.getStartBoundary("s1", 5))!;
    const endSnap = captureSnapshot(dir)!;
    const scope = computeScope(startSnap, endSnap, dir);

    expect(scope.changedFiles).toEqual(["actions.ts"]);
    await storage.close();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t "scenario"`
Expected: PASS — `changedFiles` is exactly `["actions.ts"]`; `request-url.ts` excluded.

- [ ] **Step 3: Run the entire backend test suite**

Run: `cd packages/vibedeckx && npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.test.ts
git commit -m "test(review): scenario coverage for snapshot scope isolation"
```

---

## Out of scope (Phase 2 — separate plan)

- Span selector UI (`review scope: this turn ▾`) + `workflow_runs.review_span` persistence + engine resolving `getSessionStart` / arbitrary earlier turns as start boundary.
- Distill downgrade: drop item 3 ("intended scope") from `review-brief.ts` `SYSTEM_PROMPT`, optionally feed `changedFiles` to the distiller as a constraint.
- Extending `captureReviewTarget` to reuse the `dirty` map for stronger drift detection.
- Worker-side snapshot capture wiring for remote (`skipDb`) sessions.

## Known limitations (from the spec, documented not fixed)

- A file left uncommitted across ≥2 consecutive turns can over-report at the line level within an in-scope file (the file set stays exact).
- Genuinely new human edits made between agent turns fold into the next turn's scope (inherent to any boundary-diff model).
