# Reuse Reviewer Session Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Default a follow-up review to the source session's most recent valid reviewer, continue that reviewer's preserved conversation, and retain an explicit create-new-reviewer option.

**Architecture:** Keep `workflow_runs` as the relationship history and add a newest-completed-run query. The workflow engine validates and reserves both sessions, creates a new run for every iteration, and either sends a follow-up turn to the old reviewer or follows the existing spawn path. Local and remote HTTP routes expose the candidate and creation modes; the Review dialog selects reuse by default and falls back to new-session mode when the candidate is unavailable.

**Tech Stack:** TypeScript, Fastify, Kysely/SQLite, React 19, Next.js, Radix UI, Vitest, pnpm.

---

### Task 1: Query the latest completed review relationship

**Files:**
- Modify: `packages/vibedeckx/src/storage/types.ts`
- Modify: `packages/vibedeckx/src/storage/repositories/workflow-runs.ts`
- Test: `packages/vibedeckx/src/storage/workflow-runs.test.ts`

**Step 1: Write the failing repository tests**

Add tests that create several runs for the same source, assign reviewers, and
move them to different terminal states. Assert that the newest completed run
with a reviewer is returned and that active/cancelled/failed/reviewer-less runs
are ignored.

```ts
it("getLatestCompletedBySource returns the newest completed run with a reviewer", async () => {
  await storage.workflowRuns.create(baseRun);
  await storage.workflowRuns.update("r1", {
    reviewer_session_id: "rev-old",
    status: "completed",
  });
  await storage.workflowRuns.create({ ...baseRun, id: "r2" });
  await storage.workflowRuns.update("r2", {
    reviewer_session_id: "rev-new",
    status: "completed",
  });

  expect(
    (await storage.workflowRuns.getLatestCompletedBySource("s-src"))?.reviewer_session_id,
  ).toBe("rev-new");
});

it("getLatestCompletedBySource ignores non-completed and reviewer-less runs", async () => {
  await storage.workflowRuns.create(baseRun);
  await storage.workflowRuns.update("r1", { status: "completed" });
  await storage.workflowRuns.create({ ...baseRun, id: "r2" });
  await storage.workflowRuns.update("r2", {
    reviewer_session_id: "rev-cancelled",
    status: "cancelled",
  });

  expect(await storage.workflowRuns.getLatestCompletedBySource("s-src"))
    .toBeUndefined();
});
```

Use distinct timestamps if SQLite's one-second `created_at` resolution makes
insertion order ambiguous. Prefer ordering by `created_at DESC, rowid DESC` in
the query, or explicitly advance `updated_at` in the fixture if Kysely cannot
address `rowid` cleanly.

**Step 2: Run the repository tests and verify the new tests fail**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/workflow-runs.test.ts
```

Expected: FAIL because `getLatestCompletedBySource` is not part of `Storage`.

**Step 3: Add the storage contract and minimal query**

Extend `Storage["workflowRuns"]`:

```ts
getLatestCompletedBySource(sourceSessionId: string): Promise<WorkflowRun | undefined>;
```

Implement it in `createWorkflowRunRepos`:

```ts
getLatestCompletedBySource: async (sourceSessionId) => {
  const row = await kdb
    .selectFrom("workflow_runs")
    .selectAll()
    .where("source_session_id", "=", sourceSessionId)
    .where("status", "=", "completed")
    .where("reviewer_session_id", "is not", null)
    .orderBy("created_at", "desc")
    .orderBy("rowid", "desc")
    .executeTakeFirst();
  return row ? asRun(row) : undefined;
},
```

If Kysely rejects `rowid`, use `sql<number>\`rowid\`` as the secondary order.
Do not add a schema column or duplicate the relationship on `agent_sessions`.

**Step 4: Run the repository tests**

Run:

```bash
pnpm --filter vibedeckx test -- src/storage/workflow-runs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vibedeckx/src/storage/types.ts \
  packages/vibedeckx/src/storage/repositories/workflow-runs.ts \
  packages/vibedeckx/src/storage/workflow-runs.test.ts
git commit -m "feat(workflow): query previous reviewer relationship"
```

### Task 2: Add reviewer candidate resolution and reusable review turns

**Files:**
- Modify: `packages/vibedeckx/src/workflow-engine.ts`
- Test: `packages/vibedeckx/src/workflow-engine.test.ts`

**Step 1: Write failing tests for candidate classification**

Create source and reviewer session rows and a completed workflow run. Cover an
available result and deleted/cross-project/cross-branch results.

```ts
it("returns the most recent compatible reviewer candidate", async () => {
  await storage.agentSessions.create({
    id: "s-rev", project_id: "p1", branch: "dev",
    agent_type: "codex", title: "Review - Fix login bug",
  });
  const previous = await start();
  await storage.workflowRuns.update(previous.id, { status: "completed" });

  await expect(engine.getReviewerCandidate("s-src")).resolves.toEqual({
    available: true,
    sessionId: "s-rev",
    title: "Review - Fix login bug",
    agentType: "codex",
    reason: null,
  });
});
```

Represent unavailable results with a stable reason union:

```ts
export interface ReviewerCandidate {
  available: boolean;
  sessionId: string | null;
  title: string | null;
  agentType: AgentType | null;
  reason:
    | "deleted"
    | "project-mismatch"
    | "branch-mismatch"
    | "running"
    | "busy"
    | "unsupported-agent"
    | "unavailable"
    | null;
}
```

Return `null` from `getReviewerCandidate` when there has never been a completed
review. Return an unavailable object when history exists but its latest reviewer
cannot be reused; do not skip to an older reviewer.

**Step 2: Write failing tests for the reuse execution path**

Add tests proving:

- `createNewSession` is not called;
- `sendUserMessage` targets the existing reviewer;
- the new run stores that reviewer ID;
- an edit-mode stopped reviewer is switched back to plan before delivery;
- failure to restore plan mode fails the run and releases both reservations;
- the re-review prompt mentions previous feedback, includes the captured
  commit/dirty-worktree anchor and latest source-turn context, and remains
  read-only;
- reviewer equals source, project mismatch, branch mismatch, running reviewer,
  and active-run reviewer are rejected;
- two concurrent starts for different sources but the same reviewer have one
  winner;
- send failure marks the run failed and releases both participants.

Use this call shape:

```ts
await engine.startAdhocReview({
  project,
  branch: "dev",
  sourceSessionId: "s-src",
  reviewerSessionId: "s-rev",
  reviewFocus: "check the regression test",
});
```

Add a regression test where the reused reviewer emits no assistant message in
the new turn. The extractor must stop at the new user message instead of
reusing the old turn's assistant output.

**Step 3: Run the engine tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- src/workflow-engine.test.ts
```

Expected: FAIL because candidate resolution, `reviewerSessionId`, and
new-turn-bounded extraction do not exist.

**Step 4: Add pure helpers for the follow-up prompt and turn extraction**

Add:

```ts
export function buildRereviewerPrompt(opts: {
  taskContext: string | null;
  reviewFocus: string | null;
  target: ReviewTarget;
}): string {
  return [
    "The source agent has addressed feedback from your previous review.",
    "Review the latest workspace state again.",
    opts.taskContext ? `\n## Latest source turn\n${opts.taskContext}` : null,
    opts.reviewFocus ? `\n## Review focus\n${opts.reviewFocus}` : null,
    "\n## How to review",
    "- Verify whether your previous feedback was addressed correctly.",
    "- Check for regressions and remaining correctness or test gaps.",
    "- Do NOT modify files — remain in read-only review mode.",
    opts.target.baseHead
      ? `- Review target: commit ${opts.target.baseHead}${
          opts.target.diffStat
            ? ` with uncommitted changes (${opts.target.diffStat})`
            : " with no uncommitted changes"
        }.`
      : null,
    "- End with actionable feedback, or explicitly state that it looks good.",
  ].filter((line): line is string => line !== null).join("\n");
}

export function extractLastAssistantInTurn(
  entries: AgentMessage[],
  beforeIndex: number,
): string | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "user") return null;
    if (entry?.type === "assistant" &&
        typeof entry.content === "string" && entry.content.trim()) {
      return entry.content;
    }
  }
  return null;
}
```

Use `extractLastAssistantInTurn` in `handleTaskCompleted` so a silent follow-up
cannot snapshot an old review. A user entry carrying an injected
`agent_task_completed` event is still a `type: "user"` boundary, so this helper
already handles that variant. Do not add a separate persisted start-index or
in-memory turn-boundary map unless a failing test demonstrates a case this
boundary cannot represent.

**Step 5: Implement candidate resolution**

Add `getReviewerCandidate(sourceSessionId)` to `WorkflowEngine`. Resolve the
latest completed relationship through the repository, then load both session
rows and compare normalized branches (`row.branch || null`). Return stable
candidate fields only; do not expose the whole database rows.

Treat an unsupported or missing `agent_type` as unavailable. Use the same
allowed reviewer agent set as the routes, ideally exported once from a shared
workflow module to avoid drift.

An edit-mode reviewer is not automatically unavailable: if it is stopped, the
start path can safely normalize it back to plan mode. A genuinely running
reviewer or one already reserved by a workflow is unavailable.

**Step 6: Refactor participant reservation to support two known sessions**

Generate the run ID before the first `await`. Validate `sourceSessionId !==
reviewerSessionId`, synchronously check `participants` for both IDs, and reserve
both with that run ID:

```ts
const runId = randomUUID();
const participantIds = [opts.sourceSessionId, opts.reviewerSessionId]
  .filter((id): id is string => Boolean(id));

for (const id of participantIds) {
  if (this.participants.has(id)) {
    throw new WorkflowError("session-busy", "该 session 已在一个进行中的 review 里");
  }
}
this.participants.set(opts.sourceSessionId, { runId, role: "source" });
if (opts.reviewerSessionId) {
  this.participants.set(opts.reviewerSessionId, { runId, role: "reviewer" });
}
```

Keep this check-and-reserve block synchronous. Add one cleanup helper that only
deletes entries whose `runId` matches this attempt, so a failed attempt cannot
release another run's reservation.

After reserving, repeat authoritative DB checks with `getActiveBySession` for
both participants and validate the stored source/reviewer rows. A reviewer with
status `running` is unavailable; a stopped or dormant reviewer may receive a
new turn.

Extend the structural `AgentOps` surface with the existing manager operation:

```ts
switchMode(
  sessionId: string,
  projectPath: string,
  newMode: "plan" | "edit",
): Promise<boolean>;
```

If the stored reviewer `permission_mode` is not `plan`, call `switchMode` after
both participants are reserved and before delivering the re-review prompt.
`AgentSessionManager.switchMode` preserves the entry history, persists the new
mode, and respawns the provider with plan/read-only flags. Treat `false` or a
throw as a failed start; never rely on the prompt alone to enforce read-only
behavior.

**Step 7: Implement the reused reviewer branch**

Create the run, set `reviewer_session_id` before sending, track both
participants, and call:

```ts
const sent = await this.agentOps.sendUserMessage(
  opts.reviewerSessionId,
  buildRereviewerPrompt({
    taskContext: extractTaskContextBefore(entries, turnEndIndex),
    reviewFocus: opts.reviewFocus ?? null,
    target,
  }),
  opts.project.path,
);
```

The current storage `create` contract does not accept a reviewer ID. Either
extend it to accept optional `reviewer_session_id` and insert atomically, or
create then immediately update before message delivery. Prefer extending
`create` so persisted participant identity is never temporarily incomplete.
Update Task 1's storage types/repository tests if this is needed.

On failed delivery, set status to `failed`, untrack both participants, and throw
`WorkflowError("send-failed", ...)`. Do not fall back to a new reviewer.

Keep the current new-reviewer branch behavior unchanged except for using the
shared reservation/cleanup helpers.

**Step 8: Run the engine tests**

Run:

```bash
pnpm --filter vibedeckx test -- src/workflow-engine.test.ts
```

Expected: PASS.

**Step 9: Commit**

```bash
git add packages/vibedeckx/src/workflow-engine.ts \
  packages/vibedeckx/src/workflow-engine.test.ts \
  packages/vibedeckx/src/storage/types.ts \
  packages/vibedeckx/src/storage/repositories/workflow-runs.ts \
  packages/vibedeckx/src/storage/workflow-runs.test.ts
git commit -m "feat(workflow): continue previous reviewer session"
```

### Task 3: Expose candidate lookup and reviewer reuse through local routes

**Files:**
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts`
- Test: `packages/vibedeckx/src/routes/workflow-run-routes.test.ts`
- Create: `packages/vibedeckx/src/routes/agent-session-workflow-guard-routes.test.ts`

**Step 1: Write failing route tests**

Add tests for:

- `GET /api/workflow-runs/reviewer-candidate?projectId=p1&sourceSessionId=s-src`;
- 404 for a source owned by another project;
- passing `reviewerSessionId` into `startAdhocReview`;
- rejecting a request containing both `reviewerSessionId` and
  `reviewerAgentType`;
- rejecting an empty or whitespace-only `reviewerSessionId`;
- the path-based candidate mirror and path-based reuse POST;
- mapping reviewer validation errors to 400/409 without a 500.

```ts
it("POST forwards an existing reviewer selection", async () => {
  const startAdhocReview = vi.fn(async () => run);
  const app = makeApp({ engine: { startAdhocReview } });
  await app.register(workflowRunRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/api/workflow-runs",
    payload: {
      projectId: "p1",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    },
  });

  expect(res.statusCode).toBe(201);
  expect(startAdhocReview).toHaveBeenCalledWith(
    expect.objectContaining({ reviewerSessionId: "s-rev" }),
  );
});
```

**Step 2: Run route tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- src/routes/workflow-run-routes.test.ts
```

Expected: FAIL because the candidate route and request field do not exist.

**Step 3: Add request parsing and mutual-exclusion validation**

Extend both POST body types with `reviewerSessionId?: string`. Reject non-string
or blank IDs and reject both modes together. Check property presence rather
than truthiness so `""` cannot silently select new-session mode:

```ts
if (reviewerSessionId !== undefined &&
    (typeof reviewerSessionId !== "string" || reviewerSessionId.trim() === "")) {
  return reply.code(400).send({
    error: "reviewerSessionId must be a non-empty string",
  });
}
if (reviewerSessionId !== undefined && reviewerAgentType !== undefined) {
  return reply.code(400).send({
    error: "reviewerSessionId and reviewerAgentType are mutually exclusive",
  });
}
```

Pass `reviewerSessionId.trim()` to the engine. Do not trust the route body for
project or branch compatibility; the engine performs the authoritative checks.

**Step 4: Add local and path candidate routes**

The project-based route authenticates the project and source session before
calling `workflowEngine.getReviewerCandidate(sourceSessionId)`.

```ts
fastify.get<{
  Querystring: { projectId?: string; sourceSessionId?: string };
}>("/api/workflow-runs/reviewer-candidate", async (req, reply) => {
  // require auth, validate project/source ownership
  const candidate = await fastify.workflowEngine
    .getReviewerCandidate(req.query.sourceSessionId!);
  return reply.send({ candidate });
});
```

Add `/api/path/workflow-runs/reviewer-candidate?sourceSessionId=...` for worker
access. It resolves the source session locally and returns the same response.

Register static candidate routes before generic `/:id` routes for readability,
even though Fastify prioritizes static paths.

**Step 5: Guard permission-mode changes during active reviews**

Before running tests, guard permission changes during an active workflow. In
the local/worker branches of both
`/api/agent-sessions/:sessionId/switch-mode` and
`/api/agent-sessions/:sessionId/accept-plan`, check
`fastify.workflowEngine.isSessionInActiveRun(sessionId)` and return 409 before
calling `AgentSessionManager.switchMode`/`acceptPlan`. Perform this after each
synthetic-remote proxy branch so the front still proxies; the worker performs
the authoritative bare-session check.
This prevents a user from switching a reviewer back to edit after the engine
has normalized it to plan.

Add focused route tests for active and inactive sessions on both endpoints. The
active cases must return 409 and must not call `switchMode` or `acceptPlan`; the
inactive cases retain the current 200 behavior.

**Step 6: Run route tests**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/routes/workflow-run-routes.test.ts \
  src/routes/agent-session-workflow-guard-routes.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/routes/workflow-run-routes.ts \
  packages/vibedeckx/src/routes/workflow-run-routes.test.ts \
  packages/vibedeckx/src/routes/agent-session-routes.ts \
  packages/vibedeckx/src/routes/agent-session-workflow-guard-routes.test.ts
git commit -m "feat(api): expose reusable reviewer selection"
```

### Task 4: Map reusable reviewers across remote front/worker boundaries

**Files:**
- Modify: `packages/vibedeckx/src/routes/remote-status-bridge.ts`
- Modify: `packages/vibedeckx/src/routes/workflow-run-routes.ts`
- Test: `packages/vibedeckx/src/routes/remote-status-bridge.test.ts`
- Test: `packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts`

**Step 1: Write failing remote mapping tests**

Define a mapper for reviewer candidate responses and test available, unavailable,
and null candidates:

```ts
expect(mapRemoteReviewerCandidate({
  available: true,
  sessionId: "rev1",
  title: "Review - Task",
  agentType: "codex",
  reason: null,
}, "srv1", "p1")).toMatchObject({
  sessionId: "remote-srv1-p1-rev1",
});
```

Add proxy tests proving:

- the front candidate GET calls the worker path mirror with bare source ID;
- the returned reviewer ID is mapped and registered in `remoteSessionMap`;
- POST reuse accepts the mapped reviewer, verifies that it points to the same
  remote server/project, and forwards the bare reviewer ID;
- an unmapped or cross-remote reviewer is rejected;
- new-reviewer POST behavior remains unchanged.

**Step 2: Run remote tests and verify failure**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/routes/remote-status-bridge.test.ts \
  src/routes/workflow-run-remote-routes.test.ts
```

Expected: FAIL because candidate mapping/proxying is absent.

**Step 3: Add candidate ID mapping**

Export `mapRemoteReviewerCandidate`. Preserve null and unavailable metadata;
prefix only a non-null session ID with `remote-{serverId}-{projectId}-`.

Keep the candidate DTO in one shared backend module so engine, routes, and
bridge use the same shape.

**Step 4: Proxy candidate lookup and hydrate the reviewer handle**

For a remote source, use its authorized `remoteSessionMap` entry to call:

```text
GET /api/path/workflow-runs/reviewer-candidate?sourceSessionId=<bare-source-id>
```

Map the response. If it contains a reviewer ID, add its bare/local mapping to
`remoteSessionMap` and `remoteSessionMappings`, using the source's remote server
and the source handle's branch. Compatibility validation guarantees that the
reviewer has the same branch, and the candidate DTO deliberately does not
duplicate it. This makes a subsequent POST reuse independently authorizable
after the candidate response.

Do not open the reviewer stream during a read-only candidate lookup. The
existing POST response path opens it when the re-review turn actually starts.

**Step 5: Unmap and forward a selected remote reviewer**

When `reviewerSessionId` is supplied for a remote source:

- load both source and reviewer handles from `remoteSessionMap`;
- require equal `remoteServerId` and the same derived front project;
- send `reviewerSessionId: reviewerInfo.remoteSessionId` to the worker;
- do not forward `reviewerAgentType`.

Reuse the existing response mapping, stream registration, and workflow update
emission after the worker starts the run.

**Step 6: Run remote tests**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/routes/remote-status-bridge.test.ts \
  src/routes/workflow-run-remote-routes.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/routes/remote-status-bridge.ts \
  packages/vibedeckx/src/routes/remote-status-bridge.test.ts \
  packages/vibedeckx/src/routes/workflow-run-routes.ts \
  packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts
git commit -m "feat(workflow): proxy reusable reviewers remotely"
```

### Task 5: Default the Review dialog to the previous reviewer

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`
- Modify: `apps/vibedeckx-ui/components/agent/review-dialog.tsx`
- Create: `apps/vibedeckx-ui/components/agent/review-dialog.test.tsx`

**Step 1: Add failing API/component tests**

Use the repository's jsdom + `createRoot` pattern. Mock `@/lib/api` before
importing the dialog. Cover:

- opening the dialog fetches the candidate;
- an available candidate becomes the default;
- submitting sends `reviewerSessionId` and omits `reviewerAgentType`;
- choosing “Create new reviewer session” shows the agent selector and submits
  `reviewerAgentType` without `reviewerSessionId`;
- unavailable/null/error responses choose new-session mode and show an
  explanation for unavailable/error responses;
- closing and reopening refetches, preventing a stale candidate from another
  completed review.

Prefer accessible labels or `data-testid` only where Radix's portal behavior
makes text/button selection unreliable.

```ts
expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
  sourceSessionId: "s-src",
  reviewerSessionId: "s-rev",
}));
expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerAgentType");
```

**Step 2: Run the frontend test and verify failure**

Run:

```bash
pnpm --filter vibedeckx-ui test -- components/agent/review-dialog.test.tsx
```

Expected: FAIL because the candidate API and selection UI are absent.

**Step 3: Add frontend DTOs and API methods**

In `lib/api.ts`, add:

```ts
export interface ReviewerCandidate {
  available: boolean;
  sessionId: string | null;
  title: string | null;
  agentType: AgentType | null;
  reason:
    | "deleted"
    | "project-mismatch"
    | "branch-mismatch"
    | "running"
    | "busy"
    | "unsupported-agent"
    | "unavailable"
    | null;
}
```

Extend `createWorkflowRun` options with `reviewerSessionId?: string`. Add:

```ts
async getReviewerCandidate(
  projectId: string,
  sourceSessionId: string,
): Promise<ReviewerCandidate | null> {
  const params = new URLSearchParams({ projectId, sourceSessionId });
  const res = await authFetch(
    `${getApiBase()}/api/workflow-runs/reviewer-candidate?${params}`,
  );
  if (!res.ok) throw new Error(`Failed to load reviewer candidate: ${res.status}`);
  return (await res.json()).candidate;
}
```

**Step 4: Implement dialog state and loading behavior**

Use an explicit mode instead of inferring it from nullable fields:

```ts
type ReviewerMode = "reuse" | "new";
const [mode, setMode] = useState<ReviewerMode>("new");
const [candidate, setCandidate] = useState<ReviewerCandidate | null>(null);
const [candidateNotice, setCandidateNotice] = useState<string | null>(null);
```

On every open:

1. reset mode to `new` and clear the old candidate;
2. fetch the latest candidate with a cancellation flag;
3. choose `reuse` only when `candidate.available && candidate.sessionId`;
4. otherwise retain `new` and translate the reason into a short notice.

Render a mode selector with:

- `Continue previous reviewer — {title || "Review session"} · {agentType}`
  only when a valid candidate exists;
- `Create new reviewer session` always.

Only render the current agent-type selector in `new` mode. Disable submit while
the candidate lookup or create request is in progress so the default cannot
change under a click.

Build the request without undefined competing fields:

```ts
const reviewerSelection = mode === "reuse" && candidate?.sessionId
  ? { reviewerSessionId: candidate.sessionId }
  : { reviewerAgentType: reviewerAgent };

await api.createWorkflowRun({
  projectId,
  branch,
  sourceSessionId: sessionId,
  reviewFocus: focus.trim() || undefined,
  ...reviewerSelection,
});
```

On a stale-candidate 409, keep the dialog open, show the server error, refetch
the candidate, and allow the user to select a new reviewer. Do not automatically
submit a second request.

Do not add iteration counts or automatic context compaction in this change.
Repeated reuse grows the reviewer conversation; the explicit new-session choice
is the v1 reset mechanism documented in the design.

**Step 5: Run the component test and frontend lint**

Run:

```bash
pnpm --filter vibedeckx-ui test -- components/agent/review-dialog.test.tsx
pnpm --filter vibedeckx-ui lint -- \
  components/agent/review-dialog.tsx \
  components/agent/review-dialog.test.tsx \
  lib/api.ts
```

Expected: tests PASS and ESLint exits 0.

**Step 6: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts \
  apps/vibedeckx-ui/components/agent/review-dialog.tsx \
  apps/vibedeckx-ui/components/agent/review-dialog.test.tsx
git commit -m "feat(ui): default reviews to previous reviewer"
```

### Task 6: Run focused and full verification

**Files:**
- Review only; modify implementation/test files only if verification exposes a
  defect.

**Step 1: Run all focused workflow tests together**

Run:

```bash
pnpm --filter vibedeckx test -- \
  src/storage/workflow-runs.test.ts \
  src/workflow-engine.test.ts \
  src/routes/workflow-run-routes.test.ts \
  src/routes/agent-session-workflow-guard-routes.test.ts \
  src/routes/remote-status-bridge.test.ts \
  src/routes/workflow-run-remote-routes.test.ts
pnpm --filter vibedeckx-ui test -- components/agent/review-dialog.test.tsx
```

Expected: all focused tests PASS.

**Step 2: Run complete backend and frontend test suites**

Run:

```bash
pnpm --filter vibedeckx test
pnpm --filter vibedeckx-ui test
```

Expected: both suites PASS.

**Step 3: Run builds and lint**

Run:

```bash
pnpm build:main
pnpm build:ui
pnpm --filter vibedeckx-ui lint
git diff --check
```

Expected: backend/UI builds and lint succeed; `git diff --check` prints no
errors.

**Step 4: Manually smoke-test both choices**

In a local development workspace:

1. Complete work in a source session.
2. Start a review with a new reviewer and approve its feedback.
3. Let the source address the feedback and finish.
4. Open Review and confirm the previous reviewer is selected.
5. Start the review and confirm the same reviewer session receives a new turn.
6. Complete and approve that review; confirm feedback returns to the source.
7. Open Review again, select “Create new reviewer session,” and confirm a new
   session is created with the selected agent type.
8. Repeat the candidate/start path for a remote workspace if a worker is
   configured.

Expected: both paths complete the unchanged approval state machine and no
session participates in overlapping active review runs.

**Step 5: Commit any verification-only fixes**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix(workflow): address reviewer reuse verification"
```

If no changes were required, do not create an empty commit.
