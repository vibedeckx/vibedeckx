import { describe, it, expect } from "vitest";
import {
  activeBranchSet,
  buildStatusMap,
  deriveDefaultTarget,
  deserializeBranchSet,
  effectiveTarget,
  serializeBranchSet,
  someActivityEnded,
} from "./use-merge-status";

describe("deriveDefaultTarget", () => {
  it("skips stored targets and takes the first resolved default target", () => {
    expect(
      deriveDefaultTarget([
        { branch: "dev4", target: "release", targetSource: "stored", requestedTarget: "release", status: "merged" },
        { branch: "dev3", target: "main", targetSource: "default", requestedTarget: "main", status: "unmerged" },
        { branch: "dev2", target: "master", targetSource: "default", requestedTarget: "master", status: "merged" },
      ]),
    ).toBe("main");
  });

  it("returns null when every target is stored", () => {
    expect(
      deriveDefaultTarget([
        { branch: "dev3", target: "release", targetSource: "stored", requestedTarget: "release", status: "merged" },
      ]),
    ).toBe(null);
  });

  it("returns null when the default target errored", () => {
    expect(
      deriveDefaultTarget([
        { branch: "dev3", target: null, targetSource: "default", requestedTarget: null, error: "no-default-branch" },
      ]),
    ).toBe(null);
  });
});

describe("buildStatusMap", () => {
  it("maps successful and missing-target entries while skipping other errors", () => {
    expect(
      buildStatusMap([
        { branch: "dev1", target: "main", targetSource: "default", requestedTarget: "main", status: "partial" },
        { branch: "dev2", target: null, targetSource: "stored", requestedTarget: "ghost", error: "target-not-found" },
        { branch: "dev3", target: null, targetSource: "default", requestedTarget: null, error: "no-default-branch" },
        { branch: "dev4", target: null, targetSource: "request", requestedTarget: "missing", error: "branch-not-found" },
      ]),
    ).toEqual(
      new Map([
        ["dev1", { branch: "dev1", status: "partial", unmergedCount: 0, dirty: false, target: "main" }],
        ["dev2", { branch: "dev2", error: "target-not-found", requestedTarget: "ghost", targetSource: "stored" }],
      ]),
    );
  });
});

describe("effectiveTarget", () => {
  it("returns null without info", () => {
    expect(effectiveTarget(undefined)).toBe(null);
  });

  it("returns the requested target for a warning", () => {
    expect(effectiveTarget({ branch: "dev1", error: "target-not-found", requestedTarget: "ghost", targetSource: "stored" })).toBe("ghost");
  });

  it("returns the resolved target for a successful status", () => {
    expect(effectiveTarget({ branch: "dev1", status: "merged", unmergedCount: 0, dirty: false, target: "main" })).toBe("main");
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
