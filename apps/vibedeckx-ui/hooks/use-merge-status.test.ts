import { describe, it, expect } from "vitest";
import { groupBranchesByTarget, mergeTargetStorageKey } from "./use-merge-status";

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
