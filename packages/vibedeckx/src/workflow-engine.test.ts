import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { EventBus } from "./event-bus.js";
import {
  WorkflowEngine,
  WorkflowError,
  buildReviewerPrompt,
  buildRereviewerPrompt,
  buildFeedbackMessage,
  extractLatestTurnEndIndex,
  extractLastAssistantBefore,
  extractLastAssistantInTurn,
  extractTaskContextBefore,
  extractFirstUserMessage,
  extractAuthorSelfReport,
  FINAL_VERDICT_PROMPT,
} from "./workflow-engine.js";
import type { AgentMessage } from "./agent-types.js";

const entries: AgentMessage[] = [];
entries[0] = { type: "user", content: "please fix the bug", timestamp: 1 };
entries[1] = { type: "assistant", content: "working on it", timestamp: 2 };
entries[3] = { type: "assistant", content: "done — fixed in foo.ts", timestamp: 3 };
entries[4] = { type: "turn_end", timestamp: 4 };

describe("pure helpers", () => {
  it("extractLatestTurnEndIndex finds the last turn_end in a sparse array", () => {
    expect(extractLatestTurnEndIndex(entries)).toBe(4);
    expect(extractLatestTurnEndIndex([])).toBeNull();
  });

  it("extractLastAssistantBefore walks down past holes", () => {
    expect(extractLastAssistantBefore(entries, 4)).toBe("done — fixed in foo.ts");
    expect(extractLastAssistantBefore(entries, 3)).toBe("working on it");
    expect(extractLastAssistantBefore(entries, 0)).toBeNull();
  });

  it("extractTaskContextBefore finds the turn's user message", () => {
    expect(extractTaskContextBefore(entries, 4)).toBe("please fix the bug");
  });

  it("extractLastAssistantInTurn never falls back to an older review", () => {
    const turns: AgentMessage[] = [
      { type: "assistant", content: "old feedback", timestamp: 1 },
      { type: "turn_end", timestamp: 2 },
      { type: "user", content: "review again", timestamp: 3 },
      { type: "tool_result", tool: "Read", output: "ok", timestamp: 4 },
      { type: "turn_end", timestamp: 5 },
    ];
    expect(extractLastAssistantInTurn(turns, 4)).toBeNull();
    turns.splice(4, 0, { type: "assistant", content: "new feedback", timestamp: 5 });
    expect(extractLastAssistantInTurn(turns, 5)).toBe("new feedback");
  });

  it("buildRereviewerPrompt anchors the latest source turn and workspace target", () => {
    const prompt = buildRereviewerPrompt({
      taskContext: "also cover the new API requirement",
      authorSelfReport: "I reworked the API layer and added the missing integration test as requested.",
      reviewFocus: "tests",
      target: { baseHead: "abc123", diffDigest: "digest", diffStat: "2 files changed", capturedAt: 1 },
    });
    expect(prompt).toContain("also cover the new API requirement");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("2 files changed");
    expect(prompt).toContain("read-only review mode");
    expect(prompt).toContain("I reworked the API layer");
    expect(prompt).toContain("Treat every claim as unverified");
    expect(prompt).toContain("Treat the changed areas as new code");
  });

  it("extractFirstUserMessage skips event notifications and joins content parts", () => {
    const msgs: AgentMessage[] = [];
    msgs[1] = {
      type: "user", content: "notify", timestamp: 1,
      event: { kind: "agent_task_completed", sessionId: "x", turnEndEntryIndex: 0 },
    };
    msgs[3] = {
      type: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: "build the login page" },
      ],
      timestamp: 2,
    };
    expect(extractFirstUserMessage(msgs)).toBe("build the login page");
    expect(extractFirstUserMessage([])).toBeNull();
  });

  it("extractFirstUserMessage caps long intents", () => {
    const msgs: AgentMessage[] = [{ type: "user", content: "x".repeat(3000), timestamp: 1 }];
    expect(extractFirstUserMessage(msgs)).toHaveLength(2001); // 2000 + ellipsis
  });

  it("extractAuthorSelfReport prefers a substantial summary over a done-stub", () => {
    const long = "I implemented the feature by refactoring the session manager and adding the new review-context extraction path with tests.";
    const msgs: AgentMessage[] = [
      { type: "user", content: "go", timestamp: 1 },
      { type: "assistant", content: long, timestamp: 2 },
      { type: "assistant", content: "Done.", timestamp: 3 },
      { type: "turn_end", timestamp: 4 },
    ];
    expect(extractAuthorSelfReport(msgs, 3)).toBe(long);
  });

  it("extractAuthorSelfReport falls back to the last stub when nothing substantial exists", () => {
    const msgs: AgentMessage[] = [
      { type: "assistant", content: "ok", timestamp: 1 },
      { type: "assistant", content: "Done.", timestamp: 2 },
      { type: "turn_end", timestamp: 3 },
    ];
    expect(extractAuthorSelfReport(msgs, 2)).toBe("Done.");
    expect(extractAuthorSelfReport([], 0)).toBeNull();
  });

  it("extractAuthorSelfReport withinTurn stops at the previous user message", () => {
    const staleSummary = "Earlier I built the whole feature end to end, including the schema migration and the UI wiring.";
    const msgs: AgentMessage[] = [
      { type: "assistant", content: staleSummary, timestamp: 1 },
      { type: "turn_end", timestamp: 2 },
      { type: "user", content: "[Review Feedback] fix X", timestamp: 3 },
      { type: "assistant", content: "Fixed.", timestamp: 4 },
      { type: "turn_end", timestamp: 5 },
    ];
    expect(extractAuthorSelfReport(msgs, 4, { withinTurn: true })).toBe("Fixed.");
    expect(extractAuthorSelfReport(msgs, 4)).toBe(staleSummary);
  });

  it("buildReviewerPrompt frames the self-report as unverified and marks the context tier", () => {
    const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
    const prompt = buildReviewerPrompt({
      taskContext: "now add rate limiting",
      originalIntent: "build a public API for widgets",
      authorSelfReport: "I added a token-bucket limiter in middleware and covered it with tests.",
      reviewFocus: null,
      target,
    });
    expect(prompt).toContain("## Original request");
    expect(prompt).toContain("build a public API for widgets");
    expect(prompt).toContain("## Latest user message (verbatim)");
    expect(prompt).toContain("now add rate limiting");
    expect(prompt).toContain("<author-self-report>");
    expect(prompt).toContain("Treat every claim as unverified");
    expect(prompt).toContain("deterministic excerpt");
  });

  it("buildReviewerPrompt: an intent brief replaces both verbatim sections but keeps the self-report", () => {
    const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
    const prompt = buildReviewerPrompt({
      taskContext: "now add rate limiting",
      originalIntent: "build a public API for widgets",
      authorSelfReport: "I added a token-bucket limiter in middleware and covered it with tests.",
      intentBrief: "1. Goal: public widgets API\n2. Constraints: no external deps",
      reviewFocus: null,
      target,
    });
    expect(prompt).toContain("## Intent brief (distilled from the source conversation)");
    expect(prompt).toContain("no external deps");
    // The brief subsumes both verbatim excerpts — in confirmation-style
    // conversations the latest user message is often just "ok".
    expect(prompt).not.toContain("now add rate limiting");
    expect(prompt).not.toContain("## Latest user message");
    expect(prompt).not.toContain("## Original request");
    // The self-report stays: it carries the author's claims to audit, which
    // the distillation deliberately strips from the brief.
    expect(prompt).toContain("<author-self-report>");
    expect(prompt).toContain("I added a token-bucket limiter");
    expect(prompt).toContain("Treat every claim as unverified");
    expect(prompt).toContain("distilled intent brief + author self-report + live workspace");
    expect(prompt).not.toContain("deterministic excerpt");
  });

  it("buildReviewerPrompt: brief without a self-report omits it from the context trailer", () => {
    const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
    const prompt = buildReviewerPrompt({
      taskContext: "now add rate limiting",
      originalIntent: "build a public API for widgets",
      authorSelfReport: null,
      intentBrief: "1. Goal: public widgets API",
      reviewFocus: null,
      target,
    });
    expect(prompt).not.toContain("<author-self-report>");
    expect(prompt).toContain("distilled intent brief + live workspace");
  });

  it("buildReviewerPrompt dedupes intent in single-turn sessions and degrades to workspace-only", () => {
    const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
    const single = buildReviewerPrompt({
      taskContext: "fix the bug",
      originalIntent: "fix the bug",
      authorSelfReport: null,
      reviewFocus: null,
      target,
    });
    expect(single).not.toContain("## Original request");
    expect(single).toContain("## Latest user message (verbatim)");

    const bare = buildReviewerPrompt({
      taskContext: null, originalIntent: null, authorSelfReport: null, reviewFocus: null, target,
    });
    expect(bare).toContain("live workspace only");
    expect(bare).not.toContain("deterministic excerpt");
  });
});

describe("buildReviewerPrompt blind mode", () => {
  const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
  const loaded = {
    taskContext: "now add rate limiting",
    originalIntent: "build a public API for widgets",
    authorSelfReport: "I added a token-bucket limiter in middleware and covered it with tests.",
    intentBrief: "1. Goal: public widgets API\n2. Constraints: no external deps",
    reviewFocus: "focus on the middleware ordering",
    target,
    blind: true,
  };

  it("withholds every session-derived section even when all are supplied", () => {
    const prompt = buildReviewerPrompt(loaded);
    expect(prompt).not.toContain("## Intent brief");
    expect(prompt).not.toContain("## Original request");
    expect(prompt).not.toContain("## Latest user message");
    expect(prompt).not.toContain("<author-self-report>");
    expect(prompt).not.toContain("no external deps");
    expect(prompt).not.toContain("token-bucket");
    expect(prompt).toContain("## Independent review");
    expect(prompt).toContain("state");
    expect(prompt).toContain("possibly intended — needs author confirmation");
  });

  it("keeps repo-derived context (scope) and the user's review focus", () => {
    const prompt = buildReviewerPrompt({
      ...loaded,
      scope: { changedFiles: ["src/a.ts"], startHead: "abc123" },
    });
    expect(prompt).toContain("## Review focus (from the user)");
    expect(prompt).toContain("focus on the middleware ordering");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("git diff abc123");
  });

  it("marks the trailer as deliberately withheld, distinct from the unavailable tier", () => {
    const prompt = buildReviewerPrompt(loaded);
    expect(prompt).toContain("deliberately withheld");
    expect(prompt).not.toContain("was unavailable");
    // and the settled-suppression rules never fire without a brief
    expect(prompt).not.toContain("[settled]");
  });

  it("never routes a no-diff turn to the analysis-review branch — the self-report is withheld", () => {
    const prompt = buildReviewerPrompt({
      ...loaded,
      scope: { changedFiles: [], startHead: "abc123" },
    });
    expect(prompt).toContain("there is nothing in scope for this turn");
    expect(prompt).not.toContain("review THAT");
  });
});

describe("buildReviewerPrompt verdict & settled semantics", () => {
  const target = { baseHead: null, diffDigest: null, diffStat: null, capturedAt: 1 };
  const base = {
    taskContext: "fix login",
    originalIntent: "build a login page",
    authorSelfReport: null,
    reviewFocus: null,
    target,
  };

  // A binary ship/no-ship forces overconfidence when evidence is thin; the
  // three-way verdict gives "cannot-verify" an honest exit. Layered findings
  // stop cosmetic notes from diluting blockers.
  it("ends with a three-way verdict and layered findings instead of a flat list", () => {
    const prompt = buildReviewerPrompt(base);
    expect(prompt).toContain("ship / needs-changes / cannot-verify");
    expect(prompt).toMatch(/blocking/i);
    expect(prompt).toMatch(/non-blocking/i);
    expect(prompt).not.toContain("looks good");
  });

  // Without a stated cost model "blocking" drifts into "anything I'd have done
  // differently", and the author side of the loop pays for it in complexity.
  it("states the blocking bar — real and worth fixing, not over-engineering", () => {
    for (const prompt of [
      buildReviewerPrompt(base),
      buildRereviewerPrompt({ taskContext: null, authorSelfReport: null, reviewFocus: null, target }),
      FINAL_VERDICT_PROMPT,
    ]) {
      expect(prompt).toMatch(/bar for blocking/i);
      expect(prompt).toMatch(/worth fixing/i);
      expect(prompt).toMatch(/over-engineering/i);
      expect(prompt).toMatch(/more complexity than the problem it prevents/i);
    }
  });

  it("rereviewer prompt carries the same verdict structure", () => {
    const prompt = buildRereviewerPrompt({
      taskContext: null,
      authorSelfReport: null,
      reviewFocus: null,
      target,
    });
    expect(prompt).toContain("ship / needs-changes / cannot-verify");
    expect(prompt).not.toContain("looks good");
  });

  // Re-review is the loop's convergence point: "treat the changed areas as new
  // code" invites new findings, so without a scope guard the reviewer can keep
  // the loop alive by escalating polish into blockers.
  it("rereviewer prompt forbids scope escalation so the loop converges", () => {
    const prompt = buildRereviewerPrompt({
      taskContext: null,
      authorSelfReport: null,
      reviewFocus: null,
      target,
    });
    expect(prompt).toMatch(/do not expand scope/i);
    expect(prompt).toMatch(/abstractions for hypothetical cases/i);
    expect(prompt).toMatch(/real defect the fix introduced or exposed/i);
  });

  // The suppression is scoped to the *choice itself*: a settled "no retries"
  // must not silence a data-loss consequence that choice turns out to cause.
  it("with a brief: settled choices are not re-raised, but their consequences must be reported", () => {
    const prompt = buildReviewerPrompt({ ...base, intentBrief: "0. Dominant question: does X work" });
    expect(prompt).toMatch(/do not re-raise the choice itself/i);
    expect(prompt).toMatch(/core goal|correctness, security, or data loss/i);
    expect(prompt).toMatch(/scope expansion is a product decision/i);
  });

  // Tier 2 has no distiller and therefore no settled/dominant-question data;
  // the prompt must not imply the reviewer holds equally reliable versions.
  it("without a brief (tier 2): no settled/dominant-question semantics are implied", () => {
    const prompt = buildReviewerPrompt(base);
    expect(prompt).not.toMatch(/settled/i);
    expect(prompt).not.toMatch(/dominant question/i);
    expect(prompt).not.toMatch(/re-raise/i);
  });

  it("self-report verification is prioritized by bearing on the core goal, not exhaustive", () => {
    const prompt = buildReviewerPrompt({
      ...base,
      authorSelfReport: "I added a token-bucket limiter in middleware and covered it with tests.",
    });
    expect(prompt).toContain("Treat every claim as unverified");
    expect(prompt).toMatch(/claims that bear on/i);
    expect(prompt).not.toContain("check each one against the actual code");
  });
});

describe("buildFeedbackMessage", () => {
  const msg = buildFeedbackMessage("blocking: the retry loop never terminates");

  it("keeps the feedback body and the marker the source session sees", () => {
    expect(msg).toContain("[Review Feedback]");
    expect(msg).toContain("blocking: the retry loop never terminates");
  });

  // Mirror of the reviewer prompt's "self-report is unverified" framing: the
  // reviewer's information disadvantage is named so the source calibrates on
  // it, instead of a bare "don't blindly comply".
  it("frames the findings as unverified input from a read-only, partial-context reviewer", () => {
    expect(msg).toMatch(/read-only/i);
    expect(msg).toMatch(/wrong premises/i);
    expect(msg).toMatch(/input to verify, not as conclusions/i);
    expect(msg).not.toMatch(/please address the following feedback/i);
  });

  // The escape hatch must not become the cheap path: pushing back is allowed
  // only with grounds, and every item has to be accounted for either way.
  it("pairs the right to push back with a per-item accounting duty", () => {
    expect(msg).toMatch(/push back when you have grounds/i);
    expect(msg).toMatch(/per-item account.*fixed, or not fixed and why/i);
  });

  it("separates blocking from non-blocking and forbids widening the scope", () => {
    expect(msg).toMatch(/blocking findings first/i);
    expect(msg).toMatch(/non-blocking notes need not be done this turn/i);
    expect(msg).toMatch(/do not widen the scope/i);
  });
});

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

  it("still renders a scope note (not a free-roam fallback) when the turn changed no files", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "fix login", originalIntent: "fix login",
      authorSelfReport: null, intentBrief: null, reviewFocus: null, target,
      scope: { changedFiles: [], startHead: "base9" },
    });
    expect(prompt).toContain("## Scope — the change under review");
    expect(prompt).toContain("changed no files");
    expect(prompt).toContain("nothing in scope for this turn");
    expect(prompt).not.toContain("scope unknown");
  });

  it("points a no-diff turn with a substantial self-report at the analysis/plan itself", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "why is the adjacency asymmetric?", originalIntent: "why is the adjacency asymmetric?",
      authorSelfReport:
        "Root cause located: computeBidirectionalAdjacency can't see the unloaded cross-graph peer, so only the loaded endpoint gets symmetrized. Proposed fix: make the handler async and prefetch peers first. Not implemented yet.",
      intentBrief: null, reviewFocus: null, target,
      scope: { changedFiles: [], startHead: "base9" },
    });
    expect(prompt).toContain("## Scope — the change under review");
    expect(prompt).toContain("changed no files");
    // Redirected to the deliverable, not told "nothing in scope".
    expect(prompt).toContain("deliverable is the analysis and proposed approach");
    expect(prompt).toContain("stress-test the proposed fix as a plan");
    expect(prompt).not.toContain("nothing in scope for this turn");
    // How-to line reflects that there is no diff to judge for code quality.
    expect(prompt).toContain("the work under review is the reasoning and the proposal");
  });

  it("keeps the plain no-op scope note when the no-diff turn left only a stub self-report", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "fix login", originalIntent: "fix login",
      authorSelfReport: "done", intentBrief: null, reviewFocus: null, target,
      scope: { changedFiles: [], startHead: "base9" },
    });
    expect(prompt).toContain("nothing in scope for this turn");
    expect(prompt).not.toContain("deliverable is the analysis");
  });

  it("renders no Scope section when scope is omitted entirely (back-compat)", () => {
    const prompt = buildReviewerPrompt({
      taskContext: "fix login", originalIntent: "fix login",
      authorSelfReport: null, intentBrief: null, reviewFocus: null, target,
    });
    expect(prompt).not.toContain("## Scope");
  });
});

describe("WorkflowEngine", () => {
  let dir: string;
  let storage: Storage;
  let engine: WorkflowEngine;
  let bus: EventBus;
  const reviewerEntries: AgentMessage[] = [];
  const agentOps = {
    createNewSession: vi.fn(async () => "s-rev"),
    sendUserMessage: vi.fn(async () => true),
    switchMode: vi.fn(async () => true),
    setFinalSessionTitle: vi.fn(async () => undefined),
    getRawMessages: vi.fn((sessionId: string) => (sessionId === "s-rev" ? reviewerEntries : entries)),
    broadcastRawToSession: vi.fn(),
  };
  const project = { id: "p1", path: "/tmp/does-not-exist-vdx" }; // non-git → null review target, still fine

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-eng-"));
    storage = await createSqliteStorage(path.join(dir, "t.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: project.path });
    // Represents the source session having already finished its turn — most
    // tests exercise the "ready to review" state, so default to "stopped"
    // and let the running-source-guard test flip it back to "running".
    await storage.agentSessions.create({ id: "s-src", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus("s-src", "stopped");
    bus = new EventBus();
    engine = new WorkflowEngine(storage, agentOps);
    engine.setEventBus(bus);
    await engine.init();
    reviewerEntries.length = 0;
    reviewerEntries[0] = { type: "assistant", content: "Feedback: rename X; add test for Y", timestamp: 1 };
    reviewerEntries[1] = { type: "turn_end", timestamp: 2 };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    return engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewFocus: "focus on tests",
    });
  }

  async function createReviewer(opts: {
    id?: string;
    projectId?: string;
    branch?: string;
    status?: "running" | "stopped" | "error";
    permissionMode?: "plan" | "edit";
    agentType?: "claude-code" | "codex";
    title?: string;
  } = {}) {
    const id = opts.id ?? "s-rev";
    const projectId = opts.projectId ?? "p1";
    if (projectId !== "p1" && !(await storage.projects.getById(projectId))) {
      await storage.projects.create({ id: projectId, name: projectId, path: project.path });
    }
    await storage.agentSessions.create({
      id,
      project_id: projectId,
      branch: opts.branch ?? "dev",
      permission_mode: opts.permissionMode ?? "plan",
      agent_type: opts.agentType ?? "codex",
    });
    await storage.agentSessions.updateStatus(id, opts.status ?? "stopped");
    if (opts.title) await storage.agentSessions.updateTitle(id, opts.title);
    return id;
  }

  async function seedCompletedReview(reviewerId = "s-rev") {
    const run = await storage.workflowRuns.create({
      id: `past-${reviewerId}`,
      project_id: "p1",
      branch: "dev",
      source_session_id: "s-src",
      source_turn_end_index: 4,
      review_focus: null,
      review_target: null,
    });
    await storage.workflowRuns.update(run.id, {
      reviewer_session_id: reviewerId,
      status: "completed",
    });
    return run;
  }

  it("startAdhocReview creates run, spawns reviewer, sends prompt", async () => {
    const run = await start();
    expect(run.status).toBe("waiting_reviewer");
    expect(run.reviewer_session_id).toBe("s-rev");
    expect(run.source_turn_end_index).toBe(4); // derived from entries
    // Trailing args: no forced eviction, and the worktree snapshot taken for
    // the scope handed over so the new session doesn't re-walk it.
    expect(agentOps.createNewSession).toHaveBeenCalledWith(
      "p1", "dev", project.path, false, "plan", "claude-code", true,
      false, { startSnapshot: null },
    );
    const prompt = agentOps.sendUserMessage.mock.calls[0][1] as string;
    // Machine-authored: `origin` marks it so the UI renders it as markdown
    // rather than verbatim, and the disposition hands the attention event to
    // the run — the reviewer's own completion must not also ding as a generic
    // session result.
    expect(agentOps.sendUserMessage.mock.calls[0][4]).toEqual({
      origin: "workflow",
      notificationDisposition: "milestone-managed",
    });
    expect(prompt).toContain("please fix the bug");   // task context
    expect(prompt).toContain("focus on tests");        // review focus
    expect(prompt).toContain("read-only review mode"); // reviewer must not edit
    // Author self-report wired through (fixture has only stubs → last stub used).
    expect(prompt).toContain("done — fixed in foo.ts");
    expect(prompt).toContain("Treat every claim as unverified");
    // Deterministic title, set before the prompt goes out (no AI generation).
    // Source has no title here → falls back to the task-context snippet.
    expect(agentOps.setFinalSessionTitle).toHaveBeenCalledWith("s-rev", "Review - please fix the bug");
    expect(agentOps.setFinalSessionTitle.mock.invocationCallOrder[0])
      .toBeLessThan(agentOps.sendUserMessage.mock.invocationCallOrder[0]);
  });

  it("replays preallocated workflow and reviewer identities without spawning twice", async () => {
    agentOps.createNewSession.mockImplementationOnce(async (...args: unknown[]) =>
      ((args[8] as { sessionId?: string }).sessionId ?? "unexpected"));
    const request = {
      project,
      branch: "dev" as const,
      sourceSessionId: "s-src",
      reviewFocus: "focus on tests",
      runId: "durable-run",
      newReviewerSessionId: "durable-reviewer",
    };

    const first = await engine.startAdhocReview(request);
    const replay = await engine.startAdhocReview(request);

    expect(first).toMatchObject({ id: "durable-run", reviewer_session_id: "durable-reviewer" });
    expect(replay).toEqual(first);
    expect(agentOps.createNewSession).toHaveBeenCalledTimes(1);
    expect(agentOps.createNewSession.mock.calls[0]?.[8]).toMatchObject({
      sessionId: "durable-reviewer",
    });
    expect(agentOps.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("resumes a durable run left between run creation and reviewer binding", async () => {
    await storage.workflowRuns.create({
      id: "interrupted-run",
      project_id: "p1",
      branch: "dev",
      source_session_id: "s-src",
      source_turn_end_index: 4,
      review_focus: "focus on tests",
      review_target: null,
      review_span: "this_turn",
    });
    agentOps.createNewSession.mockImplementationOnce(async (...args: unknown[]) =>
      ((args[8] as { sessionId?: string }).sessionId ?? "unexpected"));

    const resumed = await engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewFocus: "focus on tests",
      runId: "interrupted-run",
      newReviewerSessionId: "interrupted-reviewer",
    });

    expect(resumed).toMatchObject({
      id: "interrupted-run", reviewer_session_id: "interrupted-reviewer", status: "waiting_reviewer",
    });
    expect(agentOps.createNewSession).toHaveBeenCalledTimes(1);
    expect(agentOps.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not revive a terminal preallocated workflow run", async () => {
    const failed = await storage.workflowRuns.create({
      id: "failed-run",
      project_id: "p1",
      branch: "dev",
      source_session_id: "s-src",
      source_turn_end_index: 4,
      review_focus: null,
      review_target: null,
    });
    await storage.workflowRuns.update(failed.id, { status: "failed", error: "explicit failure" });

    await expect(engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      runId: "failed-run",
      newReviewerSessionId: "failed-reviewer",
    })).rejects.toMatchObject({ code: "bad-state" });
    expect(agentOps.createNewSession).not.toHaveBeenCalled();
  });

  it("uses checkout ownership when source compatibility snapshots disagree", async () => {
    await storage.projects.create({ id: "snapshot-project", name: "snapshot", path: "/tmp/snapshot" });
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "actual", targetId: "local",
      worktreePath: "/tmp/exact-review-checkout", expectedBranch: "actual",
    });
    await storage.agentSessions.createBound({
      id: "bound-source", project_id: "p1", branch: "actual", target_id: "local",
      checkout_id: registered.checkout.id,
    });
    await storage.agentSessions.updateStatus("bound-source", "stopped");
    const raw = new Database(path.join(dir, "t.sqlite"));
    try {
      raw.prepare("UPDATE agent_sessions SET project_id = ?, branch = ? WHERE id = ?")
        .run("snapshot-project", "wrong", "bound-source");
    } finally {
      raw.close();
    }

    await expect(engine.startAdhocReview({
      project, branch: "actual", sourceSessionId: "bound-source",
    })).resolves.toMatchObject({ project_id: "p1", branch: "actual" });
  });

  it("fails closed when the source checkout is tombstoned", async () => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId: "p1", branch: "gone", targetId: "local",
      worktreePath: "/tmp/gone-review-checkout", expectedBranch: "gone",
    });
    await storage.agentSessions.createBound({
      id: "gone-source", project_id: "p1", branch: "gone", target_id: "local",
      checkout_id: registered.checkout.id,
    });
    await storage.agentSessions.updateStatus("gone-source", "stopped");
    await storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);

    await expect(engine.startAdhocReview({
      project, branch: "gone", sourceSessionId: "gone-source",
    })).rejects.toMatchObject({ code: "reviewer-unavailable" });
    expect(agentOps.createNewSession).not.toHaveBeenCalled();
  });

  it("startAdhocReview threads an intent brief into the reviewer prompt", async () => {
    await engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src",
      intentBrief: "1. Goal: fix the login bug\n2. Constraints: keep the session API stable",
    });
    const prompt = agentOps.sendUserMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("keep the session API stable");
    expect(prompt).toContain("distilled intent brief");
    // The brief subsumes the verbatim conversation excerpts.
    expect(prompt).not.toContain("## Latest user message");
    expect(prompt).not.toContain("## Original request");
    // Self-report rides along with the brief (claims to audit).
    expect(prompt).toContain("<author-self-report>");
  });

  it("spawns the reviewer with the requested agent type", async () => {
    await engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerAgentType: "codex",
    });
    expect(agentOps.createNewSession).toHaveBeenCalledWith(
      "p1", "dev", project.path, false, "plan", "codex", true,
      false, { startSnapshot: null },
    );
  });

  it("reviewer title prefers the source session's own title", async () => {
    await storage.agentSessions.updateTitle("s-src", "Fix login bug");
    await start();
    expect(agentOps.setFinalSessionTitle).toHaveBeenCalledWith("s-rev", "Review - Fix login bug");
  });

  it("returns the most recent compatible reviewer candidate", async () => {
    await createReviewer({ title: "Review - Fix login bug" });
    await seedCompletedReview();

    await expect(engine.getReviewerCandidate("s-src")).resolves.toEqual({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login bug",
      agentType: "codex",
      lastActiveAt: expect.any(Number),
      reason: null,
    });
  });

  it("classifies a deleted previous reviewer as unavailable without falling back", async () => {
    await seedCompletedReview("missing-reviewer");
    await expect(engine.getReviewerCandidate("s-src")).resolves.toEqual({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      lastActiveAt: null,
      reason: "deleted",
    });
  });

  it("reuses an existing reviewer session instead of creating one", async () => {
    await createReviewer();
    const run = await engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
      reviewFocus: "focus on tests",
    });

    expect(run.reviewer_session_id).toBe("s-rev");
    expect(agentOps.createNewSession).not.toHaveBeenCalled();
    expect(agentOps.sendUserMessage).toHaveBeenCalledWith(
      "s-rev",
      expect.stringContaining("previous review"),
      project.path,
      undefined,
      // A reused reviewer is still a reviewer: the run owns its milestone.
      { origin: "workflow", notificationDisposition: "milestone-managed" },
    );
    const prompt = agentOps.sendUserMessage.mock.calls.at(-1)?.[1] as string;
    expect(prompt).toContain("please fix the bug");
    expect(prompt).toContain("focus on tests");
  });

  it("switches a stopped edit-mode reviewer back to plan before reuse", async () => {
    await createReviewer({ permissionMode: "edit" });
    await engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    });

    expect(agentOps.switchMode).toHaveBeenCalledWith("s-rev", project.path, "plan");
    expect(agentOps.switchMode.mock.invocationCallOrder[0])
      .toBeLessThan(agentOps.sendUserMessage.mock.invocationCallOrder[0]);
  });

  it("fails the run and releases both sessions when plan-mode restoration fails", async () => {
    await createReviewer({ permissionMode: "edit" });
    agentOps.switchMode.mockResolvedValueOnce(false);

    await expect(engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "reviewer-unavailable" });

    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
    expect(await storage.workflowRuns.getActive("p1", "dev")).toEqual([]);
  });

  it("rejects an incompatible or running reviewer and releases reservations", async () => {
    await createReviewer({ branch: "other" });
    await expect(engine.startAdhocReview({
      project,
      branch: "dev",
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "reviewer-unavailable" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
  });

  it("allows exactly one concurrent run to reserve a reused reviewer", async () => {
    await storage.agentSessions.create({ id: "s-src-2", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateStatus("s-src-2", "stopped");
    await createReviewer();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    agentOps.sendUserMessage.mockImplementationOnce(async () => {
      await sendGate;
      return true;
    });

    const first = engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerSessionId: "s-rev",
    });
    const second = engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src-2", reviewerSessionId: "s-rev",
    });
    await expect(second).rejects.toMatchObject({ code: "session-busy" });
    releaseSend();
    await expect(first).resolves.toMatchObject({ reviewer_session_id: "s-rev" });
  });

  it("marks the run failed and releases both sessions when reused-reviewer delivery fails", async () => {
    await createReviewer();
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.startAdhocReview({
      project, branch: "dev", sourceSessionId: "s-src", reviewerSessionId: "s-rev",
    })).rejects.toMatchObject({ code: "send-failed" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
    expect(engine.isSessionInActiveRun("s-rev")).toBe(false);
    expect((await storage.workflowRuns.getActive("p1", "dev"))).toHaveLength(0);
  });

  it("mirrors run updates onto participant session streams", async () => {
    await start();
    const frames = agentOps.broadcastRawToSession.mock.calls.map(
      ([sid, frame]: [string, Record<string, unknown>]) => [sid, Object.keys(frame)[0]],
    );
    expect(frames).toContainEqual(["s-src", "workflowRunUpdated"]);
    expect(frames).toContainEqual(["s-rev", "workflowRunUpdated"]);
  });

  it("rejects when a participant session is already in an active run", async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: "session-busy" });
  });

  it("rejects a source session with no completed turn", async () => {
    agentOps.getRawMessages.mockReturnValueOnce([]);
    await expect(start()).rejects.toMatchObject({ code: "no-completed-turn" });
  });

  it("rejects a source session that is currently running", async () => {
    await storage.agentSessions.updateStatus("s-src", "running");
    await expect(start()).rejects.toMatchObject({ code: "source-running" });
    // The reservation from the failed attempt must not linger.
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("two concurrent startAdhocReview calls for the same session: exactly one succeeds", async () => {
    // Force interleaving: the first call's createNewSession hangs on a
    // deferred promise (simulating a slow reviewer spawn), so the second
    // call is issued while the first is still deep inside its awaits —
    // not just back-to-back before either has started.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    agentOps.createNewSession.mockImplementationOnce(async () => {
      await gate;
      return "s-rev";
    });

    const first = start();
    const second = start(); // issued while `first` is in-flight

    await expect(second).rejects.toMatchObject({ code: "session-busy" });
    // The lock is still held by the in-flight first call, not released by
    // the second call's rejection.
    expect(engine.isSessionInActiveRun("s-src")).toBe(true);

    releaseFirst();
    const run = await first;
    expect(run.status).toBe("waiting_reviewer");
  });

  it("run fails and releases the source lock when the reviewer prompt send fails", async () => {
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(start()).rejects.toMatchObject({ code: "spawn-failed" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);

    const runs = await storage.workflowRuns.getActive("p1", "dev");
    expect(runs).toHaveLength(0); // not "active" — status flipped to failed

    // Assert the persisted outcome rather than the storage call used to reach
    // it: failure now rides a guarded transition (so the failure milestone can
    // only come from the caller that actually performed it), not a bare update.
    const all = await storage.workflowRuns.getAllActive();
    expect(all).toHaveLength(0);
    const failed = (await storage.workflowRuns.getActiveBySession("s-src")) ?? undefined;
    expect(failed).toBeUndefined();
    const run = await storage.workflowRuns.getById(
      (await storage.notificationOutbox.listAfter(0, 10))[0].workflow_run_id!,
    );
    expect(run).toMatchObject({ status: "failed", error: "向 reviewer 投递任务失败" });
  });

  it("claims reviewer completion: suppresses, snapshots full feedback, waits for gate", async () => {
    const run = await start();
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(true);
    expect(engine.shouldSuppressAgentEvent("s-src")).toBe(false);
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const updated = await storage.workflowRuns.getById(run.id);
    expect(updated?.feedback_snapshot).toBe("Feedback: rename X; add test for Y");
  });

  it("approveFeedback CAS-sends edited payload back to source and completes", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const done = await engine.approveFeedback(run.id, "edited feedback");
    expect(done.status).toBe("completed");
    const sent = agentOps.sendUserMessage.mock.calls.at(-1)!;
    expect(sent[0]).toBe("s-src");
    expect(sent[1]).toContain("edited feedback");
    // Workflow-authored, but disposition "result": the source's modification is
    // its own attention milestone, separate from the review-ready one.
    expect(sent[4]).toEqual({ origin: "workflow", notificationDisposition: "result" });
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("failed send returns run to waiting_feedback with error, no auto-retry", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.approveFeedback(run.id)).rejects.toMatchObject({ code: "send-failed" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("未运行");
  });

  it("cancelRun cancels a run in waiting_feedback", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    const cancelled = await engine.cancelRun(run.id, "user cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe("user cancelled");
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  it("cancelRun is a CAS: rejects with bad-state while a send is in flight (sending_feedback)", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    // Simulate approveFeedback having claimed the run (mid-send, still
    // awaiting agentOps.sendUserMessage) via its own CAS.
    const claimed = await storage.workflowRuns.transition(run.id, "waiting_feedback", "sending_feedback");
    expect(claimed).toBe(true);

    await expect(engine.cancelRun(run.id)).rejects.toMatchObject({ code: "bad-state" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("sending_feedback"); // untouched by the failed cancel
  });

  it("keeps review running when the user continues the source conversation", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-src");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_reviewer");
    expect(engine.shouldSuppressAgentEvent("s-rev")).toBe(true);

    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });

    const updated = await storage.workflowRuns.getById(run.id);
    expect(updated?.feedback_snapshot).toBe("Feedback: rename X; add test for Y");
    const reviewReady = (await storage.notificationOutbox.listAfter(0, 10)).filter((row) => row.kind === "review_ready");
    expect(reviewReady).toHaveLength(1);
    expect(reviewReady[0].workflow_run_id).toBe(run.id);
  });

  it("a user message to the reviewer moves waiting_feedback → discussing instead of cancelling", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    await engine.handleExternalUserMessage("s-rev");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
    // Run 仍活跃:参与者保留,后续 finalize/cancel 都要用。
    expect(engine.isSessionInActiveRun("s-rev")).toBe(true);
  });

  it("interrupting the reviewer mid-review (waiting_reviewer) also moves the run to discussing", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev");
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
  });

  it("reviewer taskCompleted during discussing neither reopens the gate nor creates a milestone", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev"); // → discussing
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing");
    expect(await storage.notificationOutbox.listAfter(0, 10)).toHaveLength(0);
  });

  it("cancelRun cancels a discussing run", async () => {
    const run = await start();
    await engine.handleExternalUserMessage("s-rev"); // → discussing
    const cancelled = await engine.cancelRun(run.id, "user cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(engine.isSessionInActiveRun("s-src")).toBe(false);
  });

  async function startDiscussion() {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    await engine.handleExternalUserMessage("s-rev");
    return run;
  }

  it("requestFinalVerdict sends the verdict prompt to the reviewer and returns to waiting_reviewer", async () => {
    const run = await startDiscussion();
    const updated = await engine.requestFinalVerdict(run.id);
    expect(updated.status).toBe("waiting_reviewer");
    const sent = agentOps.sendUserMessage.mock.calls.at(-1)!;
    expect(sent[0]).toBe("s-rev");
    expect(sent[1]).toBe(FINAL_VERDICT_PROMPT);
    // 终稿 turn 与初审/复审同处置:run 拥有注意力事件,不另发通用会话通知。
    expect(sent[4]).toEqual({ origin: "workflow", notificationDisposition: "milestone-managed" });
  });

  it("full loop: v1 gate → discussion → final verdict → v2 gate, distinct milestone ids", async () => {
    const run = await startDiscussion();
    await engine.requestFinalVerdict(run.id);
    reviewerEntries[2] = { type: "assistant", content: "Final: only rename X", timestamp: 3 };
    reviewerEntries[3] = { type: "turn_end", timestamp: 4 };
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 3 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    expect((await storage.workflowRuns.getById(run.id))?.feedback_snapshot).toBe("Final: only rename X");
    const ids = (await storage.notificationOutbox.listAfter(0, 100)).map((r) => r.id);
    expect(ids).toContain(`workflow:${run.id}:turn:1:review-ready`);
    expect(ids).toContain(`workflow:${run.id}:turn:3:review-ready`);
  });

  it("requestFinalVerdict send failure rolls back to discussing with an error", async () => {
    const run = await startDiscussion();
    agentOps.sendUserMessage.mockResolvedValueOnce(false);
    await expect(engine.requestFinalVerdict(run.id)).rejects.toMatchObject({ code: "send-failed" });
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("discussing");
    expect(after?.error).toContain("发送失败");
  });

  it("requestFinalVerdict outside discussing rejects with bad-state", async () => {
    const run = await start(); // waiting_reviewer
    await expect(engine.requestFinalVerdict(run.id)).rejects.toMatchObject({ code: "bad-state" });
  });

  it("requestFinalVerdict rejects with session-busy while the reviewer is mid-turn", async () => {
    await createReviewer({ agentType: "claude-code" }); // s-rev row, stopped
    const run = await startDiscussion();
    await storage.agentSessions.updateStatus("s-rev", "running");
    await expect(engine.requestFinalVerdict(run.id)).rejects.toMatchObject({ code: "session-busy" });
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("discussing"); // claim never happened
    await storage.agentSessions.updateStatus("s-rev", "stopped");
    await expect(engine.requestFinalVerdict(run.id)).resolves.toMatchObject({ status: "waiting_reviewer" });
  });

  it("handleExternalUserMessage never throws when storage rejects during the reviewer transition", async () => {
    // 本方法在 /message 路由投递前内联调用:异常冒出会阻断用户消息的投递,
    // 所以 reviewer 分支的 storage 失败必须吞掉。
    const run = await start();
    vi.spyOn(storage.workflowRuns, "transition").mockRejectedValueOnce(new Error("db locked"));
    await expect(engine.handleExternalUserMessage("s-rev")).resolves.toBeUndefined();
    expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_reviewer"); // 原状态未动
  });

  it("a reviewer message leaves a mid-send run unchanged", async () => {
    const run = await start();
    bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
    await vi.waitFor(async () => {
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
    });
    // Simulate approveFeedback having claimed the run (mid-send, still
    // awaiting agentOps.sendUserMessage) via its own CAS — same setup as the
    // cancelRun CAS test above. A discussion cannot interrupt that send.
    const claimed = await storage.workflowRuns.transition(run.id, "waiting_feedback", "sending_feedback");
    expect(claimed).toBe(true);

    await expect(engine.handleExternalUserMessage("s-rev")).resolves.toBeUndefined();
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("sending_feedback");
  });

  it("boot recovery: sending_feedback → waiting_feedback with unknown-send warning", async () => {
    const run = await start();
    await storage.workflowRuns.update(run.id, { status: "sending_feedback", feedback_snapshot: "fb" });
    const engine2 = new WorkflowEngine(storage, agentOps);
    await engine2.init();
    const after = await storage.workflowRuns.getById(run.id);
    expect(after?.status).toBe("waiting_feedback");
    expect(after?.error).toContain("发送状态未知");
    expect(engine2.isSessionInActiveRun("s-src")).toBe(true);
  });

  /**
   * Workflow attention milestones. The run — not the reviewer session — owns the
   * "review is ready" event, and it is written in the same transaction as the
   * waiting_reviewer → waiting_feedback transition that proves it.
   */
  describe("workflow milestones", () => {
    const outboxRows = () => storage.notificationOutbox.listAfter(0, 100);

    async function completeReview(run: { id: string }) {
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
      await vi.waitFor(async () => {
        expect((await storage.workflowRuns.getById(run.id))?.status).toBe("waiting_feedback");
      });
    }

    it("waiting_reviewer → waiting_feedback creates exactly one review_ready targeting the reviewer", async () => {
      const run = await start();
      await completeReview(run);

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(`workflow:${run.id}:turn:1:review-ready`);
      expect(rows[0].kind).toBe("review_ready");
      // The reviewer session is where the review controls live.
      expect(rows[0].session_id).toBe("s-rev");
      expect(rows[0].workflow_run_id).toBe(run.id);
      expect(rows[0].project_id).toBe("p1");
      expect(rows[0].branch).toBe("dev");
    });

    it("a duplicate reviewer taskCompleted cannot produce a second review_ready", async () => {
      const run = await start();
      await completeReview(run);
      // Replay: the second event finds the run already past waiting_reviewer.
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s-rev", turnEndEntryIndex: 1 });
      await new Promise((r) => setTimeout(r, 20));
      expect(await outboxRows()).toHaveLength(1);
    });

    it("approving feedback creates no workflow milestone of its own", async () => {
      const run = await start();
      await completeReview(run);
      await engine.approveFeedback(run.id, "go fix it");

      const rows = await outboxRows();
      // Only the review_ready. Feedback DELIVERY is not an attention milestone —
      // the source's later completion is, and that arrives as its own session
      // milestone from the agent-session manager (disposition "result").
      expect(rows.map((r) => r.kind)).toEqual(["review_ready"]);
    });

    it("cancelling a run creates no failure milestone", async () => {
      const run = await start();
      await engine.cancelRun(run.id, "user took over");
      expect((await storage.workflowRuns.getById(run.id))?.status).toBe("cancelled");
      expect(await outboxRows()).toEqual([]);
    });

    it("a transition to failed creates one workflow_failed stamped with the state it failed out of", async () => {
      const run = await start();
      await completeReview(run);
      // Delivery fails → approveFeedback rolls back, then the run is failed.
      // `Once`, not a persistent implementation: beforeEach's clearAllMocks
      // resets call history but NOT implementations, so a sticky false would
      // leak into later tests.
      agentOps.sendUserMessage.mockResolvedValueOnce(false);
      await expect(engine.approveFeedback(run.id)).rejects.toMatchObject({ code: "send-failed" });
      await engine.failRunForTest(run.id, "delivery gave up");

      const rows = await outboxRows();
      const failure = rows.filter((r) => r.kind === "workflow_failed");
      expect(failure).toHaveLength(1);
      expect(failure[0].id).toBe(`workflow:${run.id}:failed:waiting_feedback`);
      expect(failure[0].workflow_run_id).toBe(run.id);
      // Targets the participant the user should inspect.
      expect(failure[0].session_id).toBe("s-rev");
    });

    it("a reviewer-stage failure targets the source session when no reviewer exists yet", async () => {
      agentOps.createNewSession.mockRejectedValueOnce(new Error("spawn boom"));
      await expect(start()).rejects.toMatchObject({ code: "spawn-failed" });

      const rows = await outboxRows();
      const failure = rows.filter((r) => r.kind === "workflow_failed");
      expect(failure).toHaveLength(1);
      expect(failure[0].id).toMatch(/:failed:waiting_reviewer$/);
      expect(failure[0].session_id).toBe("s-src");
    });

    /**
     * A reused reviewer keeps its whole prior history, including the turn_end of
     * every earlier review. Keying review_ready on the RUN id (not on scanning
     * back for a turn_end) is what makes a second review of the same reviewer
     * produce a fresh, distinct milestone instead of colliding with the first.
     */
    it("a reused reviewer session yields a new review_ready keyed by run id", async () => {
      // A real reviewer session row, so the reuse path's existence checks pass.
      await createReviewer();
      const reuse = () =>
        engine.startAdhocReview({
          project, branch: "dev", sourceSessionId: "s-src", reviewerSessionId: "s-rev",
        });

      const first = await reuse();
      await completeReview(first);
      await engine.approveFeedback(first.id, "fix it");

      // Second review of the SAME reviewer session — its history still holds the
      // first review's turn_end.
      await storage.agentSessions.updateStatus("s-rev", "stopped");
      reviewerEntries[2] = { type: "assistant", content: "Second round feedback", timestamp: 3 };
      reviewerEntries[3] = { type: "turn_end", timestamp: 4 };
      const second = await reuse();
      await completeReview(second);

      const reviewReady = (await outboxRows()).filter((r) => r.kind === "review_ready");
      expect(reviewReady).toHaveLength(2);
      expect(reviewReady.map((r) => r.id)).toEqual([
        `workflow:${first.id}:turn:1:review-ready`,
        `workflow:${second.id}:turn:1:review-ready`,
      ]);
      expect(second.id).not.toBe(first.id);
    });

    it("failing an already-terminal run writes nothing (lost CAS)", async () => {
      const run = await start();
      await engine.cancelRun(run.id);
      await engine.failRunForTest(run.id, "too late");
      expect(await outboxRows()).toEqual([]);
    });
  });
});
