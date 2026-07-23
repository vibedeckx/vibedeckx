# Review Scope Phase 2 — Span Selector + Distill Downgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose review scope span (`this_turn` default, or `session_start`) in the review dialog, thread it to the engine's start-boundary resolution, and stop the intent-brief distiller from guessing file scope.

**Architecture:** A new `ReviewSpan` field flows dialog → `createWorkflowRun` → `POST /api/workflow-runs` (local + remote-proxy + worker `/api/path/workflow-runs`) → `startAdhocReview`, where a small `resolveStartSnapshot` helper picks the start-boundary snapshot by span (`getStartBoundary` for `this_turn`, new `getSessionStart` for `session_start`). The end boundary and all Phase 1 scope/prompt logic are unchanged. Separately, one line is removed from the distiller's system prompt.

**Tech Stack:** TypeScript (ESM/NodeNext — local imports need `.js`), Fastify, Kysely/better-sqlite3, Next.js/React + Radix Select, vitest (backend + jsdom frontend).

## Global Constraints

- Backend is ESM/NodeNext — **every local import needs a `.js` extension**.
- Storage queries go through Kysely (`kdb`); table DDL + `PRAGMA`/`ALTER` migrations live in `sqlite.ts`.
- `ReviewSpan = "this_turn" | "session_start"`, default **`"this_turn"`**. Backend defines it in `storage/types.ts`; the frontend mirrors it in `lib/api.ts` (frontend cannot import backend types).
- Every layer treats an omitted/unknown span as `"this_turn"` (back-compat: existing callers send no span).
- `session_start` resolves the start boundary to the session-start snapshot (`turn_end_index = -1`). A missing start snapshot (pre-Phase-1 session, or capture failure) → `scope = null` → the existing "scope unknown" prompt fallback. Never throw.
- The span selector is shown **only in new-reviewer mode** (`reviewerMode === "new"`), mirroring the existing reviewer-agent select. The re-review prompt is untouched.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend typecheck: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Tests need Node 24 for `better-sqlite3`: `eval "$(fnm env)"; fnm use v24.16.0` (verify `node -v` = v24.x). Backend tests: `cd packages/vibedeckx && npx vitest run <path>`. Frontend tests: `cd apps/vibedeckx-ui && npx vitest run <path>`.

---

### Task 1: `ReviewSpan` type, `review_span` column, `getSessionStart`

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts` (add `ReviewSpan`; add `review_span` to `WorkflowRun` + `workflowRuns.create` opts; add `getSessionStart` to `turnSnapshots`)
- Modify: `packages/vibedeckx/src/storage/schema.ts` (`review_span` on `WorkflowRunsTable`)
- Modify: `packages/vibedeckx/src/storage/sqlite.ts` (`review_span` in `workflow_runs` DDL + idempotent ALTER migration)
- Modify: `packages/vibedeckx/src/storage/repositories/workflow-runs.ts` (`create` writes `review_span`)
- Modify: `packages/vibedeckx/src/storage/repositories/turn-snapshots.ts` (`getSessionStart`)
- Test: `packages/vibedeckx/src/storage/turn-snapshots.test.ts` and `packages/vibedeckx/src/storage/workflow-runs.test.ts`

**Interfaces:**
- Produces:
  - `export type ReviewSpan = "this_turn" | "session_start";`
  - `WorkflowRun.review_span: string`
  - `workflowRuns.create` accepts optional `review_span?: ReviewSpan`
  - `turnSnapshots.getSessionStart(session_id: string): Promise<{ head: string; dirty: Record<string,string> } | undefined>`

- [ ] **Step 1: Write failing tests**

Append to `packages/vibedeckx/src/storage/turn-snapshots.test.ts` (inside the existing `describe`, reusing its `beforeEach` storage + `s1` session):

```typescript
  it("getSessionStart returns the -1 row and undefined when absent", async () => {
    expect(await storage.turnSnapshots.getSessionStart("s1")).toBeUndefined();
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: -1, head: "H0", dirty: { "a.ts": "sha" } });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 4, head: "H4", dirty: {} });
    expect(await storage.turnSnapshots.getSessionStart("s1")).toEqual({ head: "H0", dirty: { "a.ts": "sha" } });
  });
```

Append to `packages/vibedeckx/src/storage/workflow-runs.test.ts` (inside the existing `describe`, reusing `baseRun`):

```typescript
  it("defaults review_span to this_turn and round-trips an explicit span", async () => {
    const run = await storage.workflowRuns.create(baseRun);
    expect(run.review_span).toBe("this_turn");
    const run2 = await storage.workflowRuns.create({ ...baseRun, id: "r2", review_span: "session_start" });
    expect(run2.review_span).toBe("session_start");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/storage/turn-snapshots.test.ts src/storage/workflow-runs.test.ts`
Expected: FAIL — `getSessionStart` undefined; `review_span` undefined on the run.

- [ ] **Step 3: Add the `ReviewSpan` type + storage interface changes**

In `packages/vibedeckx/src/storage/types.ts`, add near the `WorkflowRun` interface:

```typescript
export type ReviewSpan = "this_turn" | "session_start";
```

Add `review_span: string;` to the `WorkflowRun` interface (after `review_target`). Add `review_span?: ReviewSpan;` to the `workflowRuns.create` options object (after `review_target?`... it currently lists `review_focus`, `review_target`, `reviewer_session_id?` — add `review_span?: ReviewSpan;`). Add to the `turnSnapshots` interface:

```typescript
    getSessionStart(
      session_id: string,
    ): Promise<{ head: string; dirty: Record<string, string> } | undefined>;
```

- [ ] **Step 4: Schema + DDL + migration**

In `schema.ts`, add to `WorkflowRunsTable` (after `review_target`):

```typescript
  review_span: Generated<string>;
```

In `sqlite.ts` `workflow_runs` `CREATE TABLE` block, add the column (after `review_target TEXT,`):

```sql
      review_span TEXT NOT NULL DEFAULT 'this_turn',
```

And add an idempotent migration near the other `PRAGMA table_info` migrations (e.g. after the `session_search_cache` one ~line 842):

```typescript
  const workflowRunsInfo = db.prepare("PRAGMA table_info(workflow_runs)").all() as { name: string }[];
  if (!workflowRunsInfo.some((col) => col.name === "review_span")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN review_span TEXT NOT NULL DEFAULT 'this_turn'");
  }
```

- [ ] **Step 5: Repository changes**

In `repositories/workflow-runs.ts` `create`, ensure `review_span` is written (Kysely spreads `...opts`, but `review_span` is optional; make the default explicit):

```typescript
    create: async (opts) => {
      await kdb.insertInto("workflow_runs").values({
        ...opts,
        reviewer_session_id: opts.reviewer_session_id ?? null,
        review_span: opts.review_span ?? "this_turn",
        status: "waiting_reviewer",
      }).execute();
```

In `repositories/turn-snapshots.ts`, add `getSessionStart`:

```typescript
    getSessionStart: async (session_id) => {
      const row = await kdb
        .selectFrom("turn_snapshots")
        .select(["head", "dirty"])
        .where("session_id", "=", session_id)
        .where("turn_end_index", "=", -1)
        .executeTakeFirst();
      if (!row) return undefined;
      return { head: row.head, dirty: JSON.parse(row.dirty) as Record<string, string> };
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/storage/turn-snapshots.test.ts src/storage/workflow-runs.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/storage/
git commit -m "feat(review): review_span column, ReviewSpan type, getSessionStart"
```

---

### Task 2: `resolveStartSnapshot` helper + engine wiring

**Files:**
- Modify: `packages/vibedeckx/src/utils/review-snapshot.ts` (add `resolveStartSnapshot`)
- Modify: `packages/vibedeckx/src/workflow-engine.ts` (`startAdhocReview` opt + use helper + persist span)
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts`

**Interfaces:**
- Consumes: `Storage["turnSnapshots"]` (`getStartBoundary`, `getSessionStart` from Task 1), `ReviewSpan`, `SnapshotState`.
- Produces:
  - `resolveStartSnapshot(storage: Storage, sessionId: string, span: ReviewSpan, turnEndIndex: number): Promise<SnapshotState | undefined>` — `session_start` → `getSessionStart`; otherwise → `getStartBoundary(sessionId, turnEndIndex)`.
  - `startAdhocReview` accepts `reviewSpan?: ReviewSpan` (default `"this_turn"`).

- [ ] **Step 1: Write the failing test**

Append to `packages/vibedeckx/src/utils/review-snapshot.test.ts` (reuse `initRepo`, `git`, real sqlite via `createSqliteStorage` as the existing `recordTurnSnapshot`/scenario tests do):

```typescript
import { resolveStartSnapshot } from "./review-snapshot.js";

describe("resolveStartSnapshot", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("this_turn picks the boundary before the turn; session_start picks the -1 row", async () => {
    const storage = await createSqliteStorage(path.join(mkdtempSync(path.join(tmpdir(), "vdx-rss-")), "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev", permission_mode: "edit", agent_type: "claude-code" });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: -1, head: "H0", dirty: { "start.ts": "s0" } });
    await storage.turnSnapshots.create({ session_id: "s1", turn_end_index: 5, head: "H5", dirty: { "mid.ts": "s5" } });

    const thisTurn = await resolveStartSnapshot(storage, "s1", "this_turn", 9);
    expect(thisTurn?.head).toBe("H5"); // boundary before turn 9

    const sessionStart = await resolveStartSnapshot(storage, "s1", "session_start", 9);
    expect(sessionStart?.head).toBe("H0"); // the -1 session-start row

    expect(await resolveStartSnapshot(storage, "s2-missing", "session_start", 9)).toBeUndefined();
    await storage.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t resolveStartSnapshot`
Expected: FAIL — `resolveStartSnapshot` not exported.

- [ ] **Step 3: Implement the helper**

Append to `packages/vibedeckx/src/utils/review-snapshot.ts` (it already imports `Storage` for `recordTurnSnapshot`):

```typescript
import type { ReviewSpan } from "../storage/types.js";

/**
 * Resolve the start-boundary snapshot for a review's span. `session_start`
 * uses the session-start (-1) snapshot; `this_turn` uses the snapshot
 * immediately before the reviewed turn. Undefined when the chosen snapshot
 * is missing (pre-feature session / capture failure) — the caller degrades
 * to a null scope.
 */
export async function resolveStartSnapshot(
  storage: Storage,
  sessionId: string,
  span: ReviewSpan,
  turnEndIndex: number,
): Promise<SnapshotState | undefined> {
  return span === "session_start"
    ? storage.turnSnapshots.getSessionStart(sessionId)
    : storage.turnSnapshots.getStartBoundary(sessionId, turnEndIndex);
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t resolveStartSnapshot`
Expected: PASS.

- [ ] **Step 5: Wire the engine**

In `packages/vibedeckx/src/workflow-engine.ts`:

Add the import to the existing review-snapshot import line:

```typescript
import { captureSnapshot, computeScope, resolveStartSnapshot } from "./utils/review-snapshot.js";
```

Add `reviewSpan?: ReviewSpan;` to the `startAdhocReview` opts type (after `sourceTurnEndIndex?: number;`), and import `ReviewSpan` from `./storage/types.js` if not already imported.

In the new-reviewer scope block (the one moved inside the fresh-reviewer branch in Phase 1's fix wave — it currently calls `this.storage.turnSnapshots.getStartBoundary(opts.sourceSessionId, turnEndIndex)`), replace the start-boundary line with the helper:

```typescript
        const startSnap = await resolveStartSnapshot(
          this.storage, opts.sourceSessionId, opts.reviewSpan ?? "this_turn", turnEndIndex,
        );
```

(Keep the surrounding `try/catch`, the `endSnap = captureSnapshot(worktreePath)`, the `if (endSnap && startSnap) scope = computeScope(...)`, and the `scope = null` default exactly as they are.)

In the `workflowRuns.create({...})` call (~line 460-469), add:

```typescript
        review_span: opts.reviewSpan ?? "this_turn",
```

- [ ] **Step 6: Typecheck (covers engine wiring)**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Full review-snapshot test file**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.ts packages/vibedeckx/src/utils/review-snapshot.test.ts packages/vibedeckx/src/workflow-engine.ts
git commit -m "feat(review): resolve start snapshot by review span in startAdhocReview"
```

---

### Task 3: Route + API plumbing

**Files:**
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts` (both POST endpoints + proxy forward + a `parseReviewSpan` validator)
- Modify: `apps/vibedeckx-ui/lib/api.ts` (`ReviewSpan` mirror + `createWorkflowRun` arg + body)
- Test: `packages/vibedeckx/src/routes/workflow-run-routes.test.ts` if it exists; otherwise a focused unit test for `parseReviewSpan` colocated

**Interfaces:**
- Consumes: `startAdhocReview`'s `reviewSpan` opt (Task 2).
- Produces: both `POST /api/workflow-runs` and `POST /api/path/workflow-runs` accept optional `reviewSpan`; the remote proxy forwards it; `api.createWorkflowRun` sends it.

- [ ] **Step 1: Write the failing test**

Add `packages/vibedeckx/src/routes/workflow-run-routes.parse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseReviewSpan } from "./workflow-run-routes.js";

describe("parseReviewSpan", () => {
  it("accepts the two valid spans, defaults undefined to this_turn, rejects junk", () => {
    expect(parseReviewSpan("this_turn")).toBe("this_turn");
    expect(parseReviewSpan("session_start")).toBe("session_start");
    expect(parseReviewSpan(undefined)).toBe("this_turn");
    expect(parseReviewSpan("nonsense")).toBeNull();
    expect(parseReviewSpan(5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.parse.test.ts`
Expected: FAIL — `parseReviewSpan` not exported.

- [ ] **Step 3: Add `parseReviewSpan` and thread it through both endpoints**

In `packages/vibedeckx/src/routes/workflow-run-routes.ts`, add an exported helper near `parseReviewerAgentType`:

```typescript
export function parseReviewSpan(raw: unknown): ReviewSpan | null {
  if (raw === undefined) return "this_turn";
  return raw === "this_turn" || raw === "session_start" ? raw : null;
}
```

Import `ReviewSpan` from the storage types (`import type { ReviewSpan } from "../storage/types.js";` — or extend the existing type import).

In the `POST /api/workflow-runs` handler:
- Add `reviewSpan?: string` to the `Body` type.
- After the other validations, add:
  ```typescript
  const reviewSpan = parseReviewSpan(req.body?.reviewSpan);
  if (reviewSpan === null) return reply.code(400).send({ error: "reviewSpan must be one of: this_turn, session_start" });
  ```
- In the remote-proxy `proxyAuto(...)` body (~line 193), add `reviewSpan,`.
- In the local `startAdhocReview({...})` call (~line 291), add `reviewSpan,`.

In the `POST /api/path/workflow-runs` handler (worker side):
- Add `reviewSpan?: string` to the `Body` type.
- Add the same `parseReviewSpan` validation.
- Add `reviewSpan,` to its `startAdhocReview({...})` call (~line 544).

- [ ] **Step 4: Frontend API**

In `apps/vibedeckx-ui/lib/api.ts`, add near the workflow-run API:

```typescript
export type ReviewSpan = "this_turn" | "session_start";
```

Add `reviewSpan?: ReviewSpan;` to `createWorkflowRun`'s `opts` type. The body already serializes `opts` verbatim (`body: JSON.stringify(opts)`), so no other change is needed there.

- [ ] **Step 5: Run parse test + typechecks**

Run: `cd packages/vibedeckx && npx vitest run src/routes/workflow-run-routes.parse.test.ts` → PASS.
Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` → no errors.
Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts packages/vibedeckx/src/routes/workflow-run-routes.parse.test.ts apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(review): thread reviewSpan through workflow-run routes and api"
```

---

### Task 4: Span selector in `ReviewDialog`

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/review-dialog.tsx`
- Test: `apps/vibedeckx-ui/components/agent/review-dialog.test.tsx`

**Interfaces:**
- Consumes: `ReviewSpan` and `createWorkflowRun`'s `reviewSpan` arg (Task 3).

- [ ] **Step 1: Write the failing tests**

The harness (top of `review-dialog.test.tsx`) mocks `createWorkflowRun`. Add tests that (a) a fresh-reviewer start sends `reviewSpan: "this_turn"` by default, and (b) the span selector is absent in reuse mode. Use the existing `renderAndOpen` + `button(text)` helpers. Example (adapt to the file's helpers):

```typescript
  it("sends reviewSpan this_turn by default on a fresh review", async () => {
    await renderAndOpen({ available: false, sessionId: null }); // no reusable candidate → new-reviewer mode
    await act(async () => {
      button("开始 Review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ reviewSpan: "this_turn" }));
  });

  it("hides the span selector in reuse mode", async () => {
    await renderAndOpen({ available: true, sessionId: "rev-1", title: "Prev", agentType: "claude-code", reason: null });
    // reuse mode is auto-selected when a reusable candidate exists
    expect(Array.from(document.body.querySelectorAll("*")).some((el) => el.textContent === "审查范围")).toBe(false);
  });
```

(If the exact "开始 Review" button label or the candidate shape differs, match what the file already uses.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/vibedeckx-ui && npx vitest run components/agent/review-dialog.test.tsx`
Expected: FAIL — no `reviewSpan` sent; selector assertion not yet meaningful.

- [ ] **Step 3: Implement the selector**

In `review-dialog.tsx`:

- Import the type: `import { api, type AgentProviderInfo, type AgentType, type ReviewSpan, type ReviewerCandidate } from "@/lib/api";`
- Add state: `const [reviewSpan, setReviewSpan] = useState<ReviewSpan>("this_turn");`
- Reset on open: in the `useEffect(() => { if (open) setReviewerAgent(...) }, [open])`, also add `setReviewSpan("this_turn");`.
- In `start()`, add `reviewSpan,` to the `api.createWorkflowRun({ ... })` call.
- Render the selector inside the `{reviewerMode === "new" && ( ... )}` block (next to the reviewer-agent select), e.g.:

```tsx
        {reviewerMode === "new" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground shrink-0">审查范围</span>
            <Select value={reviewSpan} onValueChange={(v) => setReviewSpan(v as ReviewSpan)}>
              <SelectTrigger className="h-8 text-sm flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this_turn">仅本次 turn（默认）</SelectItem>
                <SelectItem value="session_start">整个 session（自起点）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
```

(Place it as its own `reviewerMode === "new"` block right after the existing reviewer-agent block, or fold both into one block — either is fine; keep the reviewer-agent select unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/vibedeckx-ui && npx vitest run components/agent/review-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Frontend typecheck + lint**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` → no errors.
Run: `pnpm --filter vibedeckx-ui lint` → clean (or no new warnings).

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/review-dialog.tsx apps/vibedeckx-ui/components/agent/review-dialog.test.tsx
git commit -m "feat(review): span selector in the review dialog"
```

---

### Task 5: Distill downgrade — drop "intended scope"

**Files:**
- Modify: `packages/vibedeckx/src/utils/review-brief.ts` (`SYSTEM_PROMPT`; export it for the test)
- Test: `packages/vibedeckx/src/utils/review-brief.test.ts`

**Interfaces:**
- Produces: `export const SYSTEM_PROMPT` (was module-private) so the test can assert its content.

- [ ] **Step 1: Write the failing test**

Append to `packages/vibedeckx/src/utils/review-brief.test.ts`:

```typescript
import { SYSTEM_PROMPT } from "./review-brief.js";

describe("SYSTEM_PROMPT", () => {
  it("no longer asks the distiller to guess the intended scope, but keeps goal/constraints/trade-offs", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/intended scope/i);
    expect(SYSTEM_PROMPT).toMatch(/original request/i);
    expect(SYSTEM_PROMPT).toMatch(/trade-offs|limitations/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-brief.test.ts -t SYSTEM_PROMPT`
Expected: FAIL — `SYSTEM_PROMPT` not exported (and currently contains "intended scope").

- [ ] **Step 3: Edit the prompt**

In `packages/vibedeckx/src/utils/review-brief.ts`, change `const SYSTEM_PROMPT` to `export const SYSTEM_PROMPT`, remove the line `"3. The intended scope of the changes.",`, and renumber the trade-offs line from `"4. ..."` to `"3. ..."`. Resulting numbered items:

```typescript
  "1. The original request and its goal.",
  "2. Constraints and explicit user decisions, including approaches the user rejected.",
  "3. Trade-offs or limitations that were acknowledged and accepted.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-brief.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/utils/review-brief.ts packages/vibedeckx/src/utils/review-brief.test.ts
git commit -m "feat(review): stop distiller from guessing file scope (drop intended-scope item)"
```

---

### Task 6: End-to-end span differentiation + full suite

**Files:**
- Test: `packages/vibedeckx/src/utils/review-snapshot.test.ts`

**Interfaces:**
- Consumes: `recordTurnSnapshot`, `captureSnapshot`, `computeScope`, `resolveStartSnapshot`, storage (all prior tasks).

- [ ] **Step 1: Write the scenario test**

Append to `packages/vibedeckx/src/utils/review-snapshot.test.ts` — proves span actually changes the reviewed file set across two turns:

```typescript
describe("scenario: span widens scope from one turn to the whole session", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("this_turn = last turn only; session_start = both turns", async () => {
    const storage = await createSqliteStorage(path.join(mkdtempSync(path.join(tmpdir(), "vdx-span-")), "db.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: dir });
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev", permission_mode: "edit", agent_type: "claude-code" });

    await recordTurnSnapshot(storage, "s1", -1, dir);        // session start (clean)
    writeFileSync(path.join(dir, "turnA.ts"), "A\n");
    await recordTurnSnapshot(storage, "s1", 3, dir);          // end of turn A (turnA.ts dirty)
    writeFileSync(path.join(dir, "turnB.ts"), "B\n");
    // review turn B (index 7): end boundary = live worktree (turnA.ts + turnB.ts dirty)

    const end = captureSnapshot(dir)!;
    const thisTurnStart = (await resolveStartSnapshot(storage, "s1", "this_turn", 7))!;   // -> index 3 snapshot
    const sessionStart = (await resolveStartSnapshot(storage, "s1", "session_start", 7))!; // -> -1 snapshot

    expect(computeScope(thisTurnStart, end, dir).changedFiles).toEqual(["turnB.ts"]);
    expect(computeScope(sessionStart, end, dir).changedFiles).toEqual(["turnA.ts", "turnB.ts"]);
    await storage.close();
  });
});
```

- [ ] **Step 2: Run the scenario test**

Run: `cd packages/vibedeckx && npx vitest run src/utils/review-snapshot.test.ts -t "span widens"`
Expected: PASS — `this_turn` → `["turnB.ts"]`; `session_start` → `["turnA.ts", "turnB.ts"]`.

- [ ] **Step 3: Full backend suite + frontend dialog suite**

Run: `cd packages/vibedeckx && npx vitest run` → all pass (no regressions; note pre-existing skips).
Run: `cd apps/vibedeckx-ui && npx vitest run components/agent/review-dialog.test.tsx` → pass.
If any non-skip FAILS, do not commit — report BLOCKED with the failing names.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/utils/review-snapshot.test.ts
git commit -m "test(review): span widens scope from one turn to whole session"
```

---

## Self-review checklist (controller, before executing)

- Every spec section maps to a task: types/column/getSessionStart → T1; engine span resolution → T2; route/API → T3; dialog selector → T4; distill downgrade → T5; span-differentiation test → T6. ✓
- Back-compat: omitted `reviewSpan` defaults to `this_turn` at the route (`parseReviewSpan(undefined)`), engine (`opts.reviewSpan ?? "this_turn"`), and column default. ✓
- No re-review prompt changes; selector new-reviewer-only. ✓

## Out of scope (later phases)

Earlier-turn picker; re-review (reuse) scoping; drift-detection reuse of the dirty map; remote worker-side snapshot capture for `skipDb` sessions.
