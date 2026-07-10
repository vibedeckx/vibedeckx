import { describe, it, expect } from "vitest";
import type { AgentSession, Storage } from "./storage/types.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import {
  BranchActivityDedupe,
  computeBranchActivity,
  overlayOrchestratorActivity,
  shouldEmitMainCompleted,
  type BranchActivityState,
} from "./branch-activity.js";

function session(opts: Partial<AgentSession> & { branch: string; id?: string }): AgentSession {
  return {
    id: opts.id ?? "sess-" + Math.random().toString(36).slice(2, 8),
    project_id: "proj-1",
    branch: opts.branch,
    status: opts.status ?? "running",
    created_at: opts.created_at ?? "2026-01-01 00:00:00.000",
    updated_at: opts.updated_at ?? opts.created_at ?? "2026-01-01 00:00:00.000",
    last_user_message_at: opts.last_user_message_at ?? null,
    last_completed_at: opts.last_completed_at ?? null,
  };
}

describe("computeBranchActivity", () => {
  it("no sessions → empty map", () => {
    expect(computeBranchActivity([]).size).toBe(0);
  });

  // ---- The four state-machine transitions ----------------------------------

  it("session with no timestamps → idle", () => {
    const result = computeBranchActivity([session({ id: "s1", branch: "feat-a" })]);
    expect(result.get("feat-a")).toEqual({ activity: "idle", since: 0, sessionId: "s1" });
  });

  it("user_message_at > completed_at (or completed_at null) → working", () => {
    const result = computeBranchActivity([
      session({ id: "s1", branch: "feat-a", last_user_message_at: 1000, last_completed_at: null }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "working", since: 1000, sessionId: "s1" });
  });

  it("completed_at > user_message_at → completed", () => {
    const result = computeBranchActivity([
      session({ id: "s1", branch: "feat-a", last_user_message_at: 1000, last_completed_at: 2000 }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "completed", since: 2000, sessionId: "s1" });
  });

  it("user message after completion → working again", () => {
    const result = computeBranchActivity([
      session({ id: "s1", branch: "feat-a", last_user_message_at: 3000, last_completed_at: 2000 }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "working", since: 3000, sessionId: "s1" });
  });

  it("user-stopped mid-turn (status=stopped, user > completed) → stopped", () => {
    // User clicked Stop while the agent was processing their message: the
    // turn was abandoned, not completed. Distinct from idle (which means
    // "fresh, never had activity") — `stopped` says "you have unfinished
    // work here, come back to it."
    const result = computeBranchActivity([
      session({ id: "s1", branch: "feat-a", status: "stopped",
                last_user_message_at: 1000, last_completed_at: null }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "stopped", since: 1000, sessionId: "s1" });
  });

  it("errored mid-turn (status=error, user > completed) → stopped", () => {
    // Agent process crashed before completing the user's turn. Same surface
    // as user-stopped: abandoned work, not "still working".
    const result = computeBranchActivity([
      session({ id: "s1", branch: "feat-a", status: "error",
                last_user_message_at: 3000, last_completed_at: 2000 }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "stopped", since: 3000, sessionId: "s1" });
  });

  it("naturally completed (status=stopped, completed >= user) → completed", () => {
    // After successful completion, agent-session-manager flips status to
    // "stopped" too. The completed-branch should still win because
    // last_completed_at >= last_user_message_at.
    const result = computeBranchActivity([
      session({ branch: "feat-a", status: "stopped",
                last_user_message_at: 1000, last_completed_at: 2000 }),
    ]);
    expect(result.get("feat-a")?.activity).toBe("completed");
  });

  // ---- Edge cases ----------------------------------------------------------

  it("equal user_message_at and completed_at → completed (completion wins on tie)", () => {
    // Defensive: completion timestamp is written AFTER the user message of the
    // same turn, so on tie we treat it as completed. Actual tie is unlikely
    // since timestamps are millisecond-precision.
    const result = computeBranchActivity([
      session({ branch: "feat-a", last_user_message_at: 1000, last_completed_at: 1000 }),
    ]);
    expect(result.get("feat-a")?.activity).toBe("completed");
  });

  // ---- Latest-session semantics (the New Conversation case) ---------------

  it("New Conversation: newer empty session resets branch to idle", () => {
    // Session A completed earlier; user clicks New Conversation, creating B.
    // B has no timestamps but a newer updated_at → branch is idle, NOT
    // "completed" leftover from A.
    const result = computeBranchActivity([
      session({ id: "A", branch: "feat-a", updated_at: "2026-01-01 00:00:00.000",
                last_user_message_at: 1000, last_completed_at: 2000 }),
      session({ id: "B", branch: "feat-a", updated_at: "2026-01-01 00:00:01.000" }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "idle", since: 0, sessionId: "B" });
  });

  it("user messages on new session → working from that session's timestamp", () => {
    const result = computeBranchActivity([
      session({ id: "A", branch: "feat-a", updated_at: "2026-01-01 00:00:00.000",
                last_user_message_at: 1000, last_completed_at: 2000 }),
      session({ id: "B", branch: "feat-a", updated_at: "2026-01-01 00:00:01.000",
                last_user_message_at: 5000 }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "working", since: 5000, sessionId: "B" });
  });

  it("user messages on older session bumps it to latest", () => {
    // A was older but a fresh user message touched its updated_at; B has no
    // recent activity. Branch follows A's state.
    const result = computeBranchActivity([
      session({ id: "A", branch: "feat-a", updated_at: "2026-01-01 00:00:02.000",
                last_user_message_at: 7000 }),
      session({ id: "B", branch: "feat-a", updated_at: "2026-01-01 00:00:01.000" }),
    ]);
    expect(result.get("feat-a")).toEqual({ activity: "working", since: 7000, sessionId: "A" });
  });

  // ---- Multi-branch & null branch ------------------------------------------

  it("multiple branches → independent states", () => {
    const result = computeBranchActivity([
      session({ branch: "feat-a", last_user_message_at: 1000 }),
      session({ branch: "feat-b", last_user_message_at: 1000, last_completed_at: 2000 }),
      session({ branch: "feat-c" }),
    ]);
    expect(result.get("feat-a")?.activity).toBe("working");
    expect(result.get("feat-b")?.activity).toBe("completed");
    expect(result.get("feat-c")?.activity).toBe("idle");
  });

  it("null branch → keyed by empty string", () => {
    const result = computeBranchActivity([
      session({ branch: null as unknown as string, last_user_message_at: 1000 }),
    ]);
    expect(result.get("")?.activity).toBe("working");
  });

  it("treats undefined/null timestamp fields as 0", () => {
    // Defends against the storage layer emitting `undefined` instead of `null`
    // (e.g. better-sqlite3 returns undefined for missing optional columns in
    // some configurations).
    const s: AgentSession = {
      id: "x",
      project_id: "p",
      branch: "feat-a",
      status: "running",
      created_at: "2026-01-01 00:00:00.000",
      // last_user_message_at, last_completed_at, updated_at omitted
    };
    expect(computeBranchActivity([s]).get("feat-a")?.activity).toBe("idle");
  });

  it("falls back to created_at when updated_at is missing", () => {
    const result = computeBranchActivity([
      session({ id: "A", branch: "feat-a",
                created_at: "2026-01-01 00:00:00.000",
                updated_at: undefined,
                last_user_message_at: 1000 }),
      session({ id: "B", branch: "feat-a",
                created_at: "2026-01-01 00:00:01.000",
                updated_at: undefined }),
    ]);
    // B has newer created_at, no timestamps → idle
    expect(result.get("feat-a")?.activity).toBe("idle");
  });
});

describe("computeBranchActivity sessionId", () => {
  // The completion-notification deep link (?session=<id>) needs to know WHICH
  // session produced the branch state, not just the branch — with several
  // sessions running on one branch, "latest-for-branch" at click time can be a
  // different session than the one that completed.

  it("carries the id of the session that determined the branch state", () => {
    const result = computeBranchActivity([
      session({ id: "sess-1", branch: "feat-a",
                last_user_message_at: 1000, last_completed_at: 2000 }),
    ]);
    expect(result.get("feat-a")?.sessionId).toBe("sess-1");
  });

  it("uses the latest session's id when several sessions share a branch", () => {
    const result = computeBranchActivity([
      session({ id: "old", branch: "feat-a", updated_at: "2026-01-01 00:00:00.000",
                last_user_message_at: 1000, last_completed_at: 2000 }),
      session({ id: "new", branch: "feat-a", updated_at: "2026-01-02 00:00:00.000",
                last_user_message_at: 3000, last_completed_at: 4000 }),
    ]);
    expect(result.get("feat-a")?.sessionId).toBe("new");
  });
});

describe("AgentSessionManager.emitBranchActivityIfChanged", () => {
  it("includes the state's sessionId in the emitted branch:activity event", () => {
    const manager = new AgentSessionManager({} as Storage);
    const bus = new EventBus();
    manager.setEventBus(bus);
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));

    manager.emitBranchActivityIfChanged("proj-1", "feat-a", {
      activity: "completed",
      since: 123,
      sessionId: "sess-9",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "branch:activity",
      projectId: "proj-1",
      branch: "feat-a",
      activity: "completed",
      sessionId: "sess-9",
    });
  });
});

describe("BranchActivityDedupe", () => {
  it("first emit for a branch → shouldEmit returns true", () => {
    const gate = new BranchActivityDedupe();
    expect(gate.shouldEmit("proj-1", "feat-a", "working")).toBe(true);
  });

  it("repeating the same activity for a branch → shouldEmit returns false", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", "feat-a", "working");
    expect(gate.shouldEmit("proj-1", "feat-a", "working")).toBe(false);
  });

  it("transition to a new activity → shouldEmit returns true", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", "feat-a", "working");
    expect(gate.shouldEmit("proj-1", "feat-a", "completed")).toBe(true);
  });

  it("regression: redundant stopped after Stop+New Conversation is dropped", () => {
    // The original bug: clicking Stop emitted branch:activity:stopped; the
    // subsequent New Conversation re-ran stopSession which re-emitted stopped.
    // The gate must suppress the second emit so the frontend's optimistic
    // "idle" overlay survives.
    const gate = new BranchActivityDedupe();
    expect(gate.shouldEmit("proj-1", "feat-a", "stopped")).toBe(true);
    expect(gate.shouldEmit("proj-1", "feat-a", "stopped")).toBe(false);
  });

  it("different branches are independent", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", "feat-a", "working");
    // Same activity on a different branch is a real first emit.
    expect(gate.shouldEmit("proj-1", "feat-b", "working")).toBe(true);
  });

  it("different projects are independent", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", "feat-a", "working");
    expect(gate.shouldEmit("proj-2", "feat-a", "working")).toBe(true);
  });

  it("null branch (main worktree) is keyed separately from empty-string", () => {
    // The cache uses `branch ?? ""` so null and "" share a key — both
    // represent the main worktree. This is the same convention as
    // `computeBranchActivity` and `toBranchKey` in the frontend.
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", null, "working");
    expect(gate.shouldEmit("proj-1", "", "working")).toBe(false);
  });

  it("forget(branch) lets the next emit through even if value is unchanged", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", "feat-a", "completed");
    gate.forget("proj-1", "feat-a");
    expect(gate.shouldEmit("proj-1", "feat-a", "completed")).toBe(true);
  });

  it("peek returns the last-emitted activity without mutating the cache", () => {
    const gate = new BranchActivityDedupe();
    expect(gate.peek("proj-1", "feat-a")).toBeUndefined();
    gate.shouldEmit("proj-1", "feat-a", "main-running");
    expect(gate.peek("proj-1", "feat-a")).toBe("main-running");
    // peek must not count as an emit — a repeat shouldEmit is still deduped.
    expect(gate.shouldEmit("proj-1", "feat-a", "main-running")).toBe(false);
  });

  it("getProjectStates returns every cached branch state for the project", () => {
    const gate = new BranchActivityDedupe();
    gate.shouldEmit("proj-1", null, "main-completed", 100);
    gate.shouldEmit("proj-1", "feat-a", "working", 200);
    gate.shouldEmit("proj-2", "feat-b", "completed", 300);

    const states = gate.getProjectStates("proj-1");
    expect(states.size).toBe(2);
    expect(states.get("")).toEqual({ activity: "main-completed", since: 100 });
    expect(states.get("feat-a")).toEqual({ activity: "working", since: 200 });
    // Other projects are not included.
    expect(states.has("feat-b")).toBe(false);
  });

  it("getProjectStates is empty for a project with no emits", () => {
    const gate = new BranchActivityDedupe();
    expect(gate.getProjectStates("proj-1").size).toBe(0);
  });
});

describe("overlayOrchestratorActivity", () => {
  const state = (activity: BranchActivityState["activity"], since: number): BranchActivityState => ({
    activity,
    since,
  });

  it("main-completed cache overrides the agent-derived completed (the project-switch bug)", () => {
    // The chat orchestrator finished (dot emerald = main-completed), but the
    // branch also has a completed agent_session (lime). On project switch the
    // REST snapshot must keep the orchestrator dot, not fall back to the agent.
    const computed = new Map([["", state("completed", 50)]]);
    const orchestrator = new Map([["", state("main-completed", 100)]]);
    const result = overlayOrchestratorActivity(computed, orchestrator);
    expect(result.get("")).toEqual({ activity: "main-completed", since: 100 });
  });

  it("main-* is overlaid even when the branch has no agent session at all", () => {
    // Chat ran on a branch but never spawned a coding agent → no agent_session
    // → computed has no entry. The dot should still be main-completed, not gray.
    const computed = new Map<string, BranchActivityState>();
    const orchestrator = new Map([["feat-a", state("main-running", 100)]]);
    const result = overlayOrchestratorActivity(computed, orchestrator);
    expect(result.get("feat-a")).toEqual({ activity: "main-running", since: 100 });
  });

  it("non-main cache values never override the DB-derived state", () => {
    // The DB owns idle/working/completed/stopped (it handles New Conversation
    // resets). Only main-* — which computeBranchActivity can never produce —
    // is overlaid from the cache.
    const computed = new Map([["", state("idle", 0)]]);
    const orchestrator = new Map([["", state("completed", 100)]]);
    const result = overlayOrchestratorActivity(computed, orchestrator);
    expect(result.get("")).toEqual({ activity: "idle", since: 0 });
  });

  it("leaves branches without an orchestrator entry untouched", () => {
    const computed = new Map([["feat-a", state("working", 50)]]);
    const orchestrator = new Map<string, BranchActivityState>();
    const result = overlayOrchestratorActivity(computed, orchestrator);
    expect(result.get("feat-a")).toEqual({ activity: "working", since: 50 });
  });

  it("does not mutate the input map", () => {
    const computed = new Map([["", state("completed", 50)]]);
    const orchestrator = new Map([["", state("main-completed", 100)]]);
    overlayOrchestratorActivity(computed, orchestrator);
    expect(computed.get("")).toEqual({ activity: "completed", since: 50 });
  });
});

describe("shouldEmitMainCompleted", () => {
  it("user-initiated turn always clears to main-completed", () => {
    expect(shouldEmitMainCompleted(false, "main-running")).toBe(true);
    expect(shouldEmitMainCompleted(false, "completed")).toBe(true);
    expect(shouldEmitMainCompleted(false, undefined)).toBe(true);
  });

  it("event-driven turn clears a stale orchestrator main-running", () => {
    // Regression: run executors, the [Executor Event: Process Finished] turn
    // calls complete_task. The dot still shows the prior user turn's violet
    // main-running, so complete_task must clear it to main-completed.
    expect(shouldEmitMainCompleted(true, "main-running")).toBe(true);
  });

  it("event-driven turn leaves a subsystem-owned dot untouched", () => {
    // The coding agent / executor owns the dot here — complete_task from a
    // reactive auto-summary turn must not repaint it.
    expect(shouldEmitMainCompleted(true, "working")).toBe(false);
    expect(shouldEmitMainCompleted(true, "completed")).toBe(false);
    expect(shouldEmitMainCompleted(true, "stopped")).toBe(false);
    expect(shouldEmitMainCompleted(true, "main-completed")).toBe(false);
    expect(shouldEmitMainCompleted(true, undefined)).toBe(false);
  });
});
