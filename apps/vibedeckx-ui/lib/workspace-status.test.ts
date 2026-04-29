import { describe, it, expect } from "vitest";
import type { Worktree } from "@/lib/api";
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
  applyStatusWorking,
  clearRealtimeStatus,
} from "./workspace-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(branch: string | null): Worktree {
  return { branch };
}

const emptyRealtime = new Map<string, WorkspaceStatus>();
const emptyBackend = new Map<string, WorkspaceStatus>();

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
  it("undefined worktrees → empty map", () => {
    const result = computeWorkspaceStatuses(undefined, emptyRealtime, emptyBackend);
    expect(result.size).toBe(0);
  });

  it("no worktrees → empty map", () => {
    const result = computeWorkspaceStatuses([], emptyRealtime, emptyBackend);
    expect(result.size).toBe(0);
  });

  it("worktree with no realtime, no backend → idle", () => {
    const result = computeWorkspaceStatuses(
      [makeWorktree("feat")],
      emptyRealtime,
      emptyBackend
    );
    expect(result.get("feat")).toBe("idle");
  });

  it("backend says working → working", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], emptyRealtime, backend);
    expect(result.get("feat")).toBe("working");
  });

  it("backend says completed → completed", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], emptyRealtime, backend);
    expect(result.get("feat")).toBe("completed");
  });

  it("realtime overrides backend (working over completed)", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const backend = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], realtime, backend);
    expect(result.get("feat")).toBe("working");
  });

  it("realtime overrides backend (idle over working — New Conversation)", () => {
    const realtime = new Map<string, WorkspaceStatus>([["feat", "idle"]]);
    const backend = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], realtime, backend);
    expect(result.get("feat")).toBe("idle");
  });

  it("null branch worktree maps to empty-string key", () => {
    const realtime = new Map<string, WorkspaceStatus>([["", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree(null)], realtime, emptyBackend);
    expect(result.get("")).toBe("working");
  });

  it("multiple worktrees evaluated independently", () => {
    const worktrees = [
      makeWorktree("feat-a"),
      makeWorktree("feat-b"),
      makeWorktree("feat-c"),
    ];
    const realtime = new Map<string, WorkspaceStatus>([["feat-a", "completed"]]);
    const backend = new Map<string, WorkspaceStatus>([["feat-b", "working"]]);
    const result = computeWorkspaceStatuses(worktrees, realtime, backend);

    expect(result.get("feat-a")).toBe("completed");
    expect(result.get("feat-b")).toBe("working");
    expect(result.get("feat-c")).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// applyStatusWorking
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

// ---------------------------------------------------------------------------
// clearRealtimeStatus
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Event sequence simulations
// ---------------------------------------------------------------------------

describe("event sequence simulations", () => {
  const worktrees = [makeWorktree("feat-a"), makeWorktree("feat-b")];

  it("send message: realtime working overlays backend → working", () => {
    // User just clicked send — backend hasn't echoed branch:activity yet.
    const realtime = applyStatusWorking(new Map(), "feat-a");
    const result = computeWorkspaceStatuses(worktrees, realtime, emptyBackend);
    expect(result.get("feat-a")).toBe("working");
  });

  it("agent completes: backend says completed, realtime cleared → completed", () => {
    // Realtime overlay was set on send; backend's branch:activity:completed
    // arrived and the consumer cleared the overlay (handled in page.tsx).
    const backend = new Map<string, WorkspaceStatus>([["feat-a", "completed"]]);
    const result = computeWorkspaceStatuses(worktrees, emptyRealtime, backend);
    expect(result.get("feat-a")).toBe("completed");
  });

  it("user clicks New Conversation: realtime idle overlays stale completed", () => {
    // Backend's last-known state for this branch is "completed" (from a
    // previous session). Realtime overlay forces idle until the backend
    // emits branch:activity:idle (which createNewSession does fire).
    const realtime = new Map<string, WorkspaceStatus>([["feat-a", "idle"]]);
    const backend = new Map<string, WorkspaceStatus>([["feat-a", "completed"]]);
    const result = computeWorkspaceStatuses(worktrees, realtime, backend);
    expect(result.get("feat-a")).toBe("idle");
  });

  it("page reload (empty realtime), backend says completed → completed survives", () => {
    // Refresh persistence regression: the green dot stays after reload
    // because backend persists last_completed_at.
    const backend = new Map<string, WorkspaceStatus>([["feat-a", "completed"]]);
    const result = computeWorkspaceStatuses(worktrees, emptyRealtime, backend);
    expect(result.get("feat-a")).toBe("completed");
  });

  it("page reload, backend says idle → idle", () => {
    const result = computeWorkspaceStatuses(worktrees, emptyRealtime, emptyBackend);
    expect(result.get("feat-a")).toBe("idle");
    expect(result.get("feat-b")).toBe("idle");
  });

  it("non-selected branch goes working via backend → working", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat-b", "working"]]);
    const result = computeWorkspaceStatuses(worktrees, emptyRealtime, backend);
    expect(result.get("feat-b")).toBe("working");
  });
});
