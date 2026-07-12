import { describe, it, expect } from "vitest";
import {
  activeBranchSet,
  buildComparisons,
  deriveDefaultTarget,
  deserializeBranchSet,
  mergeTargetStorageKey,
  serializeBranchSet,
  someActivityEnded,
  staleTargetBranches,
} from "./use-merge-status";

describe("mergeTargetStorageKey", () => {
  it("is scoped by project and branch", () => {
    expect(mergeTargetStorageKey("p1", "dev3")).toBe("vibedeckx:mergeTarget:p1:dev3");
  });
});

describe("buildComparisons", () => {
  it("carries persisted targets and omits target otherwise", () => {
    const targets: Record<string, string | null> = { dev3: null, dev4: "dev1" };
    expect(buildComparisons(["dev3", "dev4"], (b) => targets[b])).toEqual([
      { branch: "dev3" },
      { branch: "dev4", target: "dev1" },
    ]);
  });
});

describe("staleTargetBranches", () => {
  const cmp = [{ branch: "dev3" }, { branch: "dev4", target: "gone" }];
  it("clears only explicit targets that errored target-not-found", () => {
    expect(
      staleTargetBranches(cmp, [
        { branch: "dev3", target: null, error: "no-default-branch" },
        { branch: "dev4", target: null, error: "target-not-found" },
      ]),
    ).toEqual(["dev4"]);
  });
  it("never clears on other errors or success", () => {
    expect(
      staleTargetBranches(cmp, [
        { branch: "dev3", target: "main", status: "merged", unmergedCount: 0, dirty: false },
        { branch: "dev4", target: "gone", error: "branch-not-found" },
      ]),
    ).toEqual([]);
  });
});

describe("deriveDefaultTarget", () => {
  it("takes the resolved target of a default-target pair", () => {
    expect(
      deriveDefaultTarget(
        [{ branch: "dev3" }, { branch: "dev4", target: "dev1" }],
        [
          { branch: "dev4", target: "dev1", status: "merged", unmergedCount: 0, dirty: false },
          { branch: "dev3", target: "main", status: "unmerged", unmergedCount: 2, dirty: false },
        ],
      ),
    ).toBe("main");
  });
  it("null when every pair was explicit or errored", () => {
    expect(
      deriveDefaultTarget(
        [{ branch: "dev3" }],
        [{ branch: "dev3", target: null, error: "no-default-branch" }],
      ),
    ).toBe(null);
  });
});

describe("activeBranchSet", () => {
  it("collects working and main-running branches", () => {
    const statuses = new Map<string, string>([
      ["dev1", "working"],
      ["", "main-running"],
      ["dev2", "idle"],
      ["dev3", "completed"],
    ]);
    expect(activeBranchSet(statuses)).toEqual(new Set(["dev1", ""]));
  });

  it("handles undefined and empty maps", () => {
    expect(activeBranchSet(undefined).size).toBe(0);
    expect(activeBranchSet(new Map()).size).toBe(0);
  });
});

describe("serializeBranchSet / deserializeBranchSet", () => {
  it("distinguishes the empty set from the main-workspace-only set", () => {
    expect(serializeBranchSet(new Set())).not.toBe(serializeBranchSet(new Set([""])));
  });

  it("round-trips sets including the empty-string key", () => {
    for (const s of [new Set<string>(), new Set([""]), new Set(["", "dev1"]), new Set(["dev2", "dev1"])]) {
      expect(deserializeBranchSet(serializeBranchSet(s))).toEqual(s);
    }
  });
});

describe("someActivityEnded", () => {
  it("true when a previously active branch is no longer active", () => {
    expect(someActivityEnded(new Set(["dev1"]), new Set())).toBe(true);
    expect(someActivityEnded(new Set(["dev1", "dev2"]), new Set(["dev2"]))).toBe(true);
  });

  it("false when active set only grows or stays", () => {
    expect(someActivityEnded(new Set(), new Set(["dev1"]))).toBe(false);
    expect(someActivityEnded(new Set(["dev1"]), new Set(["dev1", "dev2"]))).toBe(false);
    expect(someActivityEnded(new Set(), new Set())).toBe(false);
  });
});
