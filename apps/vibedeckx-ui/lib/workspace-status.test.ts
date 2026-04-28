import { describe, it, expect } from "vitest";
import type { Worktree, Task } from "@/lib/api";
import type { AgentSessionStatus } from "./workspace-status";
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
  applyStatusWorking,
  applyStatusCompleted,
  clearRealtimeStatus,
  applyGlobalSessionStatus,
} from "./workspace-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(branch: string | null): Worktree {
  return { branch };
}

function makeTask(
  branch: string | null,
  status: "todo" | "in_progress" | "done" | "cancelled" = "todo"
): Task {
  return {
    id: `task-${branch ?? "main"}`,
    project_id: "proj-1",
    title: `Task for ${branch ?? "main"}`,
    description: null,
    status,
    priority: "medium",
    assigned_branch: branch === null ? "" : branch,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const emptyRealtime = new Map<string, WorkspaceStatus>();
const emptySessions = new Map<string, AgentSessionStatus>();
const noTasks: Task[] = [];

// ---------------------------------------------------------------------------
// toBranchKey
// ---------------------------------------------------------------------------

describe("toBranchKey", () => {
  it("converts null to empty string", () => {
    expect(toBranchKey(null)).toBe("");
  });

  it("passes through a regular string", () => {
    expect(toBranchKey("feature-x")).toBe("feature-x");
  });

  it("preserves empty string", () => {
    expect(toBranchKey("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// computeWorkspaceStatuses
// ---------------------------------------------------------------------------

describe("computeWorkspaceStatuses", () => {
  it("returns empty map for undefined worktrees", () => {
    const result = computeWorkspaceStatuses(
      undefined,
      emptyRealtime,
      emptySessions,
      noTasks,
      null
    );
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty worktrees array", () => {
    const result = computeWorkspaceStatuses(
      [],
      emptyRealtime,
      emptySessions,
      noTasks,
      null
    );
    expect(result.size).toBe(0);
  });

  it("returns idle for a worktree with no data", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptySessions,
      noTasks,
      null
    );
    expect(result.get("feat")).toBe("idle");
  });

  it("returns assigned for a worktree with todo task", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptySessions,
      [makeTask("feat", "todo")],
      null
    );
    expect(result.get("feat")).toBe("assigned");
  });

  it("returns assigned for a worktree with in_progress task", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptySessions,
      [makeTask("feat", "in_progress")],
      null
    );
    expect(result.get("feat")).toBe("assigned");
  });

  it("returns completed for a worktree with done task", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptySessions,
      [makeTask("feat", "done")],
      null
    );
    expect(result.get("feat")).toBe("completed");
  });

  it("returns assigned for a worktree with cancelled task", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptySessions,
      [makeTask("feat", "cancelled")],
      null
    );
    expect(result.get("feat")).toBe("assigned");
  });

  it("returns working for a non-selected branch with running session", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      noTasks,
      null // selected = main, not "feat"
    );
    expect(result.get("feat")).toBe("working");
  });

  it("ignores running session on selected branch (returns idle)", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      noTasks,
      "feat" // selected = feat → session ignored
    );
    expect(result.get("feat")).toBe("idle");
  });

  it("ignores running session on selected branch when both are null/main", () => {
    const sessions = new Map<string, AgentSessionStatus>([["", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree(null)],
      emptyRealtime,
      sessions,
      noTasks,
      null // selected = main (null → ""), worktree branch = null → ""
    );
    expect(result.get("")).toBe("idle");
  });

  it("returns idle for stopped session", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "stopped"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      noTasks,
      null
    );
    expect(result.get("feat")).toBe("idle");
  });

  it("returns idle for error session", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "error"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      noTasks,
      null
    );
    expect(result.get("feat")).toBe("idle");
  });

  // Priority: done task > running session
  it("done task beats running session → completed", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      [makeTask("feat", "done")],
      null
    );
    expect(result.get("feat")).toBe("completed");
  });

  // Priority: running session > assigned task
  it("running session beats assigned (todo) task → working", () => {
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      sessions,
      [makeTask("feat", "todo")],
      null
    );
    expect(result.get("feat")).toBe("working");
  });

  // Realtime overrides
  it("realtime 'working' overrides everything (even done task)", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      realtime,
      emptySessions,
      [makeTask("feat", "done")],
      null
    );
    expect(result.get("feat")).toBe("working");
  });

  it("realtime 'completed' overrides everything", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      realtime,
      sessions,
      [makeTask("feat", "todo")],
      null
    );
    expect(result.get("feat")).toBe("completed");
  });

  it("realtime 'idle' overrides even running session", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat", "idle"]]);
    const sessions = new Map<string, AgentSessionStatus>([["feat", "running"]]);
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      realtime,
      sessions,
      noTasks,
      null
    );
    expect(result.get("feat")).toBe("idle");
  });

  it("handles multiple worktrees with mixed states", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat-a", "working"]]);
    const sessions = new Map<string, AgentSessionStatus>([
      ["feat-b", "running"],
    ]);
    const tasks = [makeTask("feat-c", "done"), makeTask("feat-d", "todo")];

    const result = computeWorkspaceStatuses(
      [
        makeWorktree("feat-a"),
        makeWorktree("feat-b"),
        makeWorktree("feat-c"),
        makeWorktree("feat-d"),
        makeWorktree("feat-e"),
      ],
      realtime,
      sessions,
      tasks,
      null
    );

    expect(result.get("feat-a")).toBe("working"); // realtime
    expect(result.get("feat-b")).toBe("working"); // session running
    expect(result.get("feat-c")).toBe("completed"); // done task
    expect(result.get("feat-d")).toBe("assigned"); // todo task
    expect(result.get("feat-e")).toBe("idle"); // no data
  });

  it("maps null branch worktree to '' key", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree(null)],
      emptyRealtime,
      emptySessions,
      noTasks,
      "other"
    );
    expect(result.has("")).toBe(true);
    expect(result.get("")).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Event handler helpers
// ---------------------------------------------------------------------------

describe("applyStatusWorking", () => {
  it("sets working for a branch", () => {
    const result = applyStatusWorking(new Map(), "feat");
    expect(result.get("feat")).toBe("working");
  });

  it("handles null branch (maps to '')", () => {
    const result = applyStatusWorking(new Map(), null);
    expect(result.get("")).toBe("working");
  });

  it("does not mutate original map", () => {
    const original = new Map<string, WorkspaceStatus>([["feat", "idle"]]);
    const result = applyStatusWorking(original, "feat");
    expect(result.get("feat")).toBe("working");
    expect(original.get("feat")).toBe("idle");
  });

  it("overwrites existing status", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = applyStatusWorking(prev, "feat");
    expect(result.get("feat")).toBe("working");
  });
});

describe("applyStatusCompleted", () => {
  it("sets completed for a branch", () => {
    const result = applyStatusCompleted(new Map(), "feat");
    expect(result.get("feat")).toBe("completed");
  });

  it("overwrites existing status", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = applyStatusCompleted(prev, "feat");
    expect(result.get("feat")).toBe("completed");
  });
});

describe("clearRealtimeStatus", () => {
  it("removes entry for a branch", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = clearRealtimeStatus(prev, "feat");
    expect(result.has("feat")).toBe(false);
  });

  it("no-op if branch is absent", () => {
    const prev = new Map<string, WorkspaceStatus>([["other", "working"]]);
    const result = clearRealtimeStatus(prev, "feat");
    expect(result.size).toBe(1);
    expect(result.get("other")).toBe("working");
  });

  it("handles null branch", () => {
    const prev = new Map<string, WorkspaceStatus>([["", "completed"]]);
    const result = clearRealtimeStatus(prev, null);
    expect(result.has("")).toBe(false);
  });

  it("does not mutate original map", () => {
    const original = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    clearRealtimeStatus(original, "feat");
    expect(original.get("feat")).toBe("working");
  });
});

describe("applyGlobalSessionStatus", () => {
  it("running → sets working, no refetch", () => {
    const result = applyGlobalSessionStatus(new Map(), "feat", "running");
    expect(result.realtimeStatuses.get("feat")).toBe("working");
    expect(result.shouldRefetchTasks).toBe(false);
  });

  it("stopped → clears entry, triggers refetch", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = applyGlobalSessionStatus(prev, "feat", "stopped");
    expect(result.realtimeStatuses.has("feat")).toBe(false);
    expect(result.shouldRefetchTasks).toBe(true);
  });

  it("stopped → preserves completed (taskCompleted-then-stopped race)", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = applyGlobalSessionStatus(prev, "feat", "stopped");
    expect(result.realtimeStatuses.get("feat")).toBe("completed");
    expect(result.shouldRefetchTasks).toBe(true);
  });

  it("error → clears entry even if completed", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = applyGlobalSessionStatus(prev, "feat", "error");
    expect(result.realtimeStatuses.has("feat")).toBe(false);
    expect(result.shouldRefetchTasks).toBe(true);
  });

  it("error → clears entry, triggers refetch", () => {
    const prev = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = applyGlobalSessionStatus(prev, "feat", "error");
    expect(result.realtimeStatuses.has("feat")).toBe(false);
    expect(result.shouldRefetchTasks).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event sequence simulations (the critical bug-prone area)
// ---------------------------------------------------------------------------

describe("event sequence simulations", () => {
  const worktrees = [makeWorktree("feat-a"), makeWorktree("feat-b")];

  it("start → working", () => {
    // Agent starts on feat-a (selected)
    let realtime = applyStatusWorking(new Map(), "feat-a");
    const result = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      noTasks,
      "feat-a"
    );
    expect(result.get("feat-a")).toBe("working");
  });

  it("start → complete on selected branch → completed", () => {
    let realtime = applyStatusWorking(new Map(), "feat-a");
    // Task completes on the selected branch
    realtime = applyStatusCompleted(realtime, "feat-a");
    const result = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      [makeTask("feat-a", "done")],
      "feat-a"
    );
    expect(result.get("feat-a")).toBe("completed");
  });

  it("start → complete on NON-selected branch → session stops → realtime cleared → fallback picks up done task → completed", () => {
    // 1. Agent starts on feat-b (non-selected; selected is feat-a)
    let realtime = applyStatusWorking(new Map(), "feat-b");

    // 2. Task completes on feat-b (task marked done in DB)
    const tasks = [makeTask("feat-b", "done")];

    // 3. Session finishes → global event: stopped → clear realtime
    const result = applyGlobalSessionStatus(realtime, "feat-b", "stopped");
    realtime = result.realtimeStatuses;
    expect(result.shouldRefetchTasks).toBe(true);

    // 4. Realtime cleared → fallback picks up done task
    const statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      tasks,
      "feat-a" // selected is feat-a
    );
    expect(statuses.get("feat-b")).toBe("completed");
  });

  it("taskCompleted → stopped on selected branch with no assigned task → completed", () => {
    // Reproduces the bug where backend emits session:status=stopped right
    // after taskCompleted, previously erasing the green dot.

    // 1. User sends a message → working
    let realtime = applyStatusWorking(new Map(), "feat-a");

    // 2. Agent finishes turn successfully → completed (via WS taskCompleted)
    realtime = applyStatusCompleted(realtime, "feat-a");

    // 3. Backend immediately emits session:status=stopped (post-taskCompleted)
    const result = applyGlobalSessionStatus(realtime, "feat-a", "stopped");
    realtime = result.realtimeStatuses;

    // 4. Even with no assigned task, the dot must stay green
    const statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      noTasks,
      "feat-a"
    );
    expect(statuses.get("feat-a")).toBe("completed");
  });

  it("session stops without task completion → assigned", () => {
    let realtime = applyStatusWorking(new Map(), "feat-b");
    const tasks = [makeTask("feat-b", "in_progress")];

    // Session stops
    const result = applyGlobalSessionStatus(realtime, "feat-b", "stopped");
    realtime = result.realtimeStatuses;

    const statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      tasks,
      "feat-a"
    );
    expect(statuses.get("feat-b")).toBe("assigned");
  });

  it("session stops, no task → idle", () => {
    let realtime = applyStatusWorking(new Map(), "feat-b");

    const result = applyGlobalSessionStatus(realtime, "feat-b", "stopped");
    realtime = result.realtimeStatuses;

    const statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      noTasks,
      "feat-a"
    );
    expect(statuses.get("feat-b")).toBe("idle");
  });

  it("reset task → clear realtime → idle", () => {
    let realtime = new Map<string, WorkspaceStatus>([["feat-a", "completed"]]);
    // User resets task: clears realtime and unassigns task
    realtime = clearRealtimeStatus(realtime, "feat-a");

    const statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      noTasks, // task was unassigned
      "feat-a"
    );
    expect(statuses.get("feat-a")).toBe("idle");
  });

  it("multiple events same branch (working → completed → working)", () => {
    let realtime = applyStatusWorking(new Map(), "feat-a");
    expect(realtime.get("feat-a")).toBe("working");

    realtime = applyStatusCompleted(realtime, "feat-a");
    expect(realtime.get("feat-a")).toBe("completed");

    realtime = applyStatusWorking(realtime, "feat-a");
    expect(realtime.get("feat-a")).toBe("working");
  });

  it("realtime cleared → fallback re-evaluated correctly", () => {
    // feat-b has realtime "working" overriding a done task
    let realtime = new Map<string, WorkspaceStatus>([["feat-b", "working"]]);
    const tasks = [makeTask("feat-b", "done")];

    // Before clearing: realtime wins
    let statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      tasks,
      "feat-a"
    );
    expect(statuses.get("feat-b")).toBe("working");

    // Clear realtime
    realtime = clearRealtimeStatus(realtime, "feat-b");

    // After clearing: fallback picks up done task
    statuses = computeWorkspaceStatuses(
      worktrees,
      realtime,
      emptySessions,
      tasks,
      "feat-a"
    );
    expect(statuses.get("feat-b")).toBe("completed");
  });
});
