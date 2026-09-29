import { describe, expect, it } from "vitest";
import { selectionForProjectSwitch, workspacePlacement } from "./pending-navigation";

describe("selectionForProjectSwitch", () => {
  it("applies a staged jump target instead of parking on main", () => {
    expect(
      selectionForProjectSwitch({ projectId: "p2", branch: "dev7", sessionId: "s1" }, "p2"),
    ).toEqual({ branch: "dev7", sessionId: "s1" });
  });

  it("applies a workspace-only jump with no session pinned", () => {
    expect(
      selectionForProjectSwitch({ projectId: "p2", branch: "dev7", sessionId: null }, "p2"),
    ).toEqual({ branch: "dev7", sessionId: null });
  });

  it("clears the selection on a plain project switch", () => {
    expect(selectionForProjectSwitch(undefined, "p2")).toEqual({ branch: null, sessionId: null });
  });

  it("ignores a target staged for a different project", () => {
    // A superseded navigation leaves its target behind. Branch names are
    // per-project, so applying it here would query p3 for one of p2's
    // branches — the mismatch the render-phase clear exists to prevent.
    expect(
      selectionForProjectSwitch({ projectId: "p2", branch: "dev7", sessionId: "s1" }, "p3"),
    ).toEqual({ branch: null, sessionId: null });
  });

  it("ignores a target when no project is current", () => {
    expect(
      selectionForProjectSwitch({ projectId: "p2", branch: "dev7", sessionId: "s1" }, undefined),
    ).toEqual({ branch: null, sessionId: null });
  });
});

describe("placement-checked jumps", () => {
  it("are not applied optimistically — they wait for the loaded list", () => {
    expect(
      selectionForProjectSwitch({ projectId: "p2", branch: "dev7", sessionId: null, checkPlacement: true }, "p2"),
    ).toEqual({ branch: null, sessionId: null });
  });
});

describe("workspacePlacement", () => {
  const machine = (serverId: string, state: "present" | "absent" | "creating") =>
    ({ serverId, name: `M-${serverId}`, state }) as never;

  it("prompts when the current remote lacks the workspace", () => {
    const worktree = { branch: "3000", machines: [machine("a", "present"), machine("b", "absent")] } as never;
    const placement = workspacePlacement(worktree, "b");
    expect(placement.kind).toBe("absent");
    if (placement.kind !== "absent") return;
    expect(placement.missing.branch).toBe("3000");
    expect(placement.missing.current).toMatchObject({ serverId: "b" });
    expect(placement.missing.presentOn.map((m) => m.serverId)).toEqual(["a"]);
  });

  it("opens normally when the current remote has it", () => {
    const worktree = { branch: "3000", machines: [machine("a", "present"), machine("b", "absent")] } as never;
    expect(workspacePlacement(worktree, "a")).toEqual({ kind: "present" });
  });

  it("names the machine still creating it", () => {
    const worktree = { branch: "3000", machines: [machine("a", "creating")] } as never;
    expect(workspacePlacement(worktree, "a")).toEqual({ kind: "creating", machineName: "M-a" });
  });

  it("never prompts for the root workspace or without machine info", () => {
    expect(workspacePlacement({ branch: null } as never, "a")).toEqual({ kind: "present" });
    expect(workspacePlacement(undefined, "a")).toEqual({ kind: "present" });
  });
});
