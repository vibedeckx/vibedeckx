import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROCESS_SETTINGS,
  normalizeAgentProcessSettings,
  pickIdleResidentEvictionCandidate,
  shouldShowBranchSessionInList,
} from "./resident-agent-processes.js";

describe("resident agent process helpers", () => {
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
      { id: "running", processAlive: true, status: "running", dormant: false, backgroundTaskCount: 0, lastActiveAt: 10 },
      { id: "dead", processAlive: false, status: "stopped", dormant: true, backgroundTaskCount: 0, lastActiveAt: 1 },
      { id: "background", processAlive: true, status: "stopped", dormant: false, backgroundTaskCount: 1, lastActiveAt: 0 },
      { id: "newer-idle", processAlive: true, status: "stopped", dormant: false, backgroundTaskCount: 0, lastActiveAt: 20 },
      { id: "oldest-idle", processAlive: true, status: "stopped", dormant: false, backgroundTaskCount: 0, lastActiveAt: 5 },
    ]);

    expect(candidate?.id).toBe("oldest-idle");
  });

  it("returns null when every live resident is running", () => {
    expect(
      pickIdleResidentEvictionCandidate([
        { id: "a", processAlive: true, status: "running", dormant: false, backgroundTaskCount: 0, lastActiveAt: 1 },
        { id: "b", processAlive: true, status: "running", dormant: false, backgroundTaskCount: 0, lastActiveAt: 2 },
      ]),
    ).toBeNull();
  });

  it("keeps live resident sessions visible before their first entry is persisted", () => {
    expect(shouldShowBranchSessionInList({ entryCount: 0, processAlive: true })).toBe(true);
    expect(shouldShowBranchSessionInList({ entryCount: 1, processAlive: false })).toBe(true);
    expect(shouldShowBranchSessionInList({ entryCount: 0, processAlive: false })).toBe(false);
  });
});
