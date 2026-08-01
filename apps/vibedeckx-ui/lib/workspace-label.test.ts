import { describe, it, expect } from "vitest";
import type { ProjectRemote } from "@/lib/api";
import { remoteNameMap, workspaceLabel } from "./workspace-label";

const remote = (id: string, name: string): ProjectRemote => ({
  id: `association-${id}`,
  project_id: "project-1",
  remote_server_id: id,
  remote_path: "/srv/project-1",
  sort_order: 0,
  server_name: name,
});

const names = remoteNameMap([
  remote("6b0f1a2c-9d4e-4c1b-8f77-2a5d3e6c1b90", "gpu-01"),
]);

describe("workspaceLabel", () => {
  it("shows the branch alone for local workspaces", () => {
    expect(workspaceLabel({ target: "local", branch: "feature-x" }, names)).toBe("feature-x");
  });

  it("leads with the branch and names the remote after it, never its server id", () => {
    expect(workspaceLabel(
      { target: "6b0f1a2c-9d4e-4c1b-8f77-2a5d3e6c1b90", branch: "feature-x" },
      names,
    )).toBe("feature-x · gpu-01");
  });

  it("falls back to the id when the remote is no longer attached", () => {
    expect(workspaceLabel({ target: "detached-server", branch: "feature-x" }, names))
      .toBe("feature-x · detached-server");
  });

  it("calls a missing branch the main workspace", () => {
    expect(workspaceLabel({ target: "local", branch: null }, names)).toBe("main");
    expect(workspaceLabel(
      { target: "6b0f1a2c-9d4e-4c1b-8f77-2a5d3e6c1b90", branch: null },
      names,
    )).toBe("main · gpu-01");
  });
});
