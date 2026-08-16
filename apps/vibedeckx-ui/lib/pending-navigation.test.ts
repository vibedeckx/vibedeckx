import { describe, expect, it } from "vitest";
import { selectionForProjectSwitch } from "./pending-navigation";

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
