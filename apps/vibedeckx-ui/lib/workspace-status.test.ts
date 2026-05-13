import { describe, it, expect } from "vitest";
import type { Worktree } from "@/lib/api";
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
} from "./workspace-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(branch: string | null): Worktree {
  return { branch };
}

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
    const result = computeWorkspaceStatuses(undefined, emptyBackend);
    expect(result.size).toBe(0);
  });

  it("no worktrees → empty map", () => {
    const result = computeWorkspaceStatuses([], emptyBackend);
    expect(result.size).toBe(0);
  });

  it("worktree with no backend entry → idle", () => {
    const result = computeWorkspaceStatuses([makeWorktree("feat")], emptyBackend);
    expect(result.get("feat")).toBe("idle");
  });

  it("backend says working → working", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], backend);
    expect(result.get("feat")).toBe("working");
  });

  it("backend says completed → completed", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat", "completed"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], backend);
    expect(result.get("feat")).toBe("completed");
  });

  it("backend says stopped → stopped", () => {
    const backend = new Map<string, WorkspaceStatus>([["feat", "stopped"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], backend);
    expect(result.get("feat")).toBe("stopped");
  });

  it("null branch worktree maps to empty-string key", () => {
    const backend = new Map<string, WorkspaceStatus>([["", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree(null)], backend);
    expect(result.get("")).toBe("working");
  });

  it("multiple worktrees evaluated independently", () => {
    const worktrees = [
      makeWorktree("feat-a"),
      makeWorktree("feat-b"),
      makeWorktree("feat-c"),
    ];
    const backend = new Map<string, WorkspaceStatus>([
      ["feat-a", "completed"],
      ["feat-b", "working"],
    ]);
    const result = computeWorkspaceStatuses(worktrees, backend);

    expect(result.get("feat-a")).toBe("completed");
    expect(result.get("feat-b")).toBe("working");
    expect(result.get("feat-c")).toBe("idle");
  });

  it("backend entries for unlisted branches are dropped", () => {
    // The output map is keyed by the visible worktree list, so a backend
    // entry for a branch that's not in the worktrees won't appear in the
    // result. Sidebar can't render a dot for a branch it doesn't know about.
    const backend = new Map<string, WorkspaceStatus>([["ghost", "working"]]);
    const result = computeWorkspaceStatuses([makeWorktree("feat")], backend);
    expect(result.has("ghost")).toBe(false);
    expect(result.get("feat")).toBe("idle");
  });
});
