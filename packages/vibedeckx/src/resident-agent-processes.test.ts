import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROCESS_SETTINGS,
  normalizeAgentProcessSettings,
  pickIdleResidentEvictionCandidate,
  shouldShowBranchSessionInList,
} from "./resident-agent-processes.js";

describe("resident agent process helpers", () => {
  const baseCandidate = {
    projectId: "project-a",
    branch: "feature-a",
    processAlive: true,
    status: "stopped" as const,
    dormant: false,
    backgroundTaskCount: 0,
    lastActiveAt: 1,
  };

  it("defaults maxResidentAgentProcesses to 3", () => {
    expect(normalizeAgentProcessSettings(undefined)).toEqual(DEFAULT_AGENT_PROCESS_SETTINGS);
  });

  it("validates and clamps persisted settings shape", () => {
    expect(normalizeAgentProcessSettings({ maxResidentAgentProcesses: 5 })).toEqual({
      maxResidentAgentProcesses: 5,
    });
    expect(normalizeAgentProcessSettings({ maxResidentAgentProcesses: 0 })).toEqual(DEFAULT_AGENT_PROCESS_SETTINGS);
    expect(normalizeAgentProcessSettings({ maxResidentAgentProcesses: 11 })).toEqual(DEFAULT_AGENT_PROCESS_SETTINGS);
    expect(normalizeAgentProcessSettings({ maxResidentAgentProcesses: 2.5 })).toEqual(DEFAULT_AGENT_PROCESS_SETTINGS);
  });

  it("picks only idle live sessions and orders by least recent activity", () => {
    const candidate = pickIdleResidentEvictionCandidate([
      { ...baseCandidate, id: "running", status: "running", lastActiveAt: 10 },
      { ...baseCandidate, id: "dead", processAlive: false, dormant: true, lastActiveAt: 1 },
      { ...baseCandidate, id: "background", backgroundTaskCount: 1, lastActiveAt: 0 },
      { ...baseCandidate, id: "newer-idle", lastActiveAt: 20 },
      { ...baseCandidate, id: "oldest-idle", lastActiveAt: 5 },
    ]);

    expect(candidate?.id).toBe("oldest-idle");
  });

  it("only considers idle residents in the requested workspace branch scope", () => {
    const candidate = pickIdleResidentEvictionCandidate(
      [
        { ...baseCandidate, id: "other-project-oldest", projectId: "project-b", branch: "feature-a", lastActiveAt: 1 },
        { ...baseCandidate, id: "other-branch-oldest", branch: "feature-b", lastActiveAt: 2 },
        { ...baseCandidate, id: "same-branch-newer", lastActiveAt: 10 },
      ],
      { projectId: "project-a", branch: "feature-a" },
    );

    expect(candidate?.id).toBe("same-branch-newer");
  });

  it("returns null when every live resident is running", () => {
    expect(
      pickIdleResidentEvictionCandidate([
        { ...baseCandidate, id: "a", status: "running", lastActiveAt: 1 },
        { ...baseCandidate, id: "b", status: "running", lastActiveAt: 2 },
      ]),
    ).toBeNull();
  });

  it("keeps live resident sessions visible before their first entry is persisted", () => {
    expect(shouldShowBranchSessionInList({ entryCount: 0, processAlive: true })).toBe(true);
    expect(shouldShowBranchSessionInList({ entryCount: 1, processAlive: false })).toBe(true);
    expect(shouldShowBranchSessionInList({ entryCount: 0, processAlive: false })).toBe(false);
  });
});
