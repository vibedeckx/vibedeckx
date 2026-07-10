import { describe, expect, it } from "vitest";
import { isWorktreesLoading } from "./use-worktrees";

describe("isWorktreesLoading", () => {
  it("is loading while a fetch is in flight", () => {
    expect(isWorktreesLoading(true, "proj-a", "proj-a")).toBe(true);
  });

  it("is not loading once the fetch for the current project has landed", () => {
    expect(isWorktreesLoading(false, "proj-a", "proj-a")).toBe(false);
  });

  // The cross-project notification race: in the commit where currentProject
  // changes, the fetch effect's setLoading(true) is not yet visible to the
  // auto-select effect running in the same pass — it would consume the pending
  // workspace selection against the PREVIOUS project's worktree list and fall
  // back to the main workspace. Deriving loading from the list's owning
  // project closes that window: a list loaded for another project is never
  // trusted, no matter what the fetch flag says.
  it("is loading when the list on hand was loaded for a different project", () => {
    expect(isWorktreesLoading(false, "proj-a", "proj-b")).toBe(true);
  });

  it("is loading before anything was fetched for a real project", () => {
    expect(isWorktreesLoading(false, null, "proj-a")).toBe(true);
  });

  it("is not loading in the no-project state", () => {
    expect(isWorktreesLoading(false, null, null)).toBe(false);
  });
});
