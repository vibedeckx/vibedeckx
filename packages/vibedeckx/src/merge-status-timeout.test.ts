import { describe, it, expect, vi } from "vitest";

vi.mock("./utils/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/git-exec.js")>();
  return {
    ...actual,
    runGit: vi.fn(async (_cwd: string, args: string[]) => {
      throw new actual.GitTimeoutError(args, 20_000);
    }),
  };
});

vi.mock("./utils/worktree-paths.js", () => ({
  parseGitWorktreeList: () => [],
}));

const { computeBranchMergeStatus, computeMergeStatusPairs, validateBranchExists } = await import(
  "./merge-status.js"
);

// Every "git failed → no" catch must let a timeout through: a slow repo has to
// fail the request, not show up as a missing branch or a wrong badge.
describe("merge-status git timeouts", () => {
  it("does not read a timed-out rev-parse as a missing branch", async () => {
    await expect(validateBranchExists("/repo", "main")).rejects.toMatchObject({ statusCode: 504 });
    await expect(computeBranchMergeStatus("/repo", "dev1", "main")).rejects.toMatchObject({
      statusCode: 504,
    });
  });

  it("fails the whole batch instead of reporting no-default-branch", async () => {
    await expect(computeMergeStatusPairs("/repo", [{ branch: "dev1" }])).rejects.toMatchObject({
      statusCode: 504,
    });
  });
});
