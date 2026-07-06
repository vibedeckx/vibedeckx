import { describe, expect, it } from "vitest";
import {
  updateResidentSessionTitle,
  upsertResidentSession,
  type ResidentSidebarSession,
} from "./use-resident-sessions";

describe("upsertResidentSession", () => {
  it("adds a freshly created live session immediately", () => {
    const created: ResidentSidebarSession = {
      id: "s-new",
      projectId: "p1",
      branch: "feature",
      title: "New Session",
      status: "running",
      processAlive: true,
      updated_at: "2026-07-06T00:00:00.000Z",
    };

    expect(upsertResidentSession([], created)).toEqual([created]);
  });

  it("updates an existing resident session instead of duplicating it", () => {
    const previous: ResidentSidebarSession = {
      id: "s1",
      projectId: "p1",
      branch: null,
      title: "Old",
      status: "stopped",
      processAlive: true,
    };
    const updated = { ...previous, title: "Updated", status: "running" };

    expect(upsertResidentSession([previous], updated)).toEqual([updated]);
  });

  it("updates a resident session title from the websocket title event", () => {
    const previous: ResidentSidebarSession = {
      id: "s1",
      projectId: "p1",
      branch: null,
      title: "New Session",
      status: "running",
      processAlive: true,
    };

    expect(updateResidentSessionTitle([previous], "s1", "Generated title")).toEqual([
      { ...previous, title: "Generated title" },
    ]);
    expect(updateResidentSessionTitle([previous], "missing", "Generated title")).toEqual([previous]);
  });
});
