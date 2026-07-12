import { describe, it, expect } from "vitest";
import type { MergeStatusResult } from "@/lib/api";
import {
  activeBranchSet,
  groupBranchesByTarget,
  mergeTargetStorageKey,
  shouldClearStaleTarget,
  someActivityEnded,
} from "./use-merge-status";

describe("mergeTargetStorageKey", () => {
  it("is scoped by project and branch", () => {
    expect(mergeTargetStorageKey("p1", "dev3")).toBe("vibedeckx:mergeTarget:p1:dev3");
  });
});

describe("groupBranchesByTarget", () => {
  it("groups branches by their persisted target, null for default", () => {
    const targets: Record<string, string | null> = { dev3: null, dev4: "dev1", dev5: "dev1" };
    const groups = groupBranchesByTarget(["dev3", "dev4", "dev5"], (b) => targets[b]);
    expect(groups.get(null)).toEqual(["dev3"]);
    expect(groups.get("dev1")).toEqual(["dev4", "dev5"]);
  });

  it("returns an empty map for no branches", () => {
    expect(groupBranchesByTarget([], () => null).size).toBe(0);
  });
});

describe("shouldClearStaleTarget", () => {
  const okResult: MergeStatusResult = { ok: true, data: { target: "main", entries: [] } };

  it("clears on a genuine 400 for an explicit target", () => {
    const result: MergeStatusResult = { ok: false, status: 400 };
    expect(shouldClearStaleTarget(result, "dev1")).toBe(true);
  });

  it("does not clear on a 400 for the default group (null target)", () => {
    const result: MergeStatusResult = { ok: false, status: 400 };
    expect(shouldClearStaleTarget(result, null)).toBe(false);
  });

  it("does not clear on a thrown network error (status 0) for an explicit target", () => {
    const result: MergeStatusResult = { ok: false, status: 0 };
    expect(shouldClearStaleTarget(result, "dev1")).toBe(false);
  });

  it("does not clear on a 502 for an explicit target", () => {
    const result: MergeStatusResult = { ok: false, status: 502 };
    expect(shouldClearStaleTarget(result, "dev1")).toBe(false);
  });

  it("does not clear on a 404 for an explicit target", () => {
    const result: MergeStatusResult = { ok: false, status: 404 };
    expect(shouldClearStaleTarget(result, "dev1")).toBe(false);
  });

  it("does not clear on an ok result", () => {
    expect(shouldClearStaleTarget(okResult, "dev1")).toBe(false);
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
