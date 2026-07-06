import type { AgentSessionStatus } from "./agent-types.js";

export interface AgentProcessSettings {
  maxResidentAgentProcesses: number;
}

export const DEFAULT_AGENT_PROCESS_SETTINGS: AgentProcessSettings = {
  maxResidentAgentProcesses: 3,
};

export const AGENT_PROCESS_SETTINGS_LIMITS = {
  min: 1,
  max: 10,
} as const;

export function normalizeAgentProcessSettings(value: unknown): AgentProcessSettings {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_PROCESS_SETTINGS;
  const maxResidentAgentProcesses = (value as { maxResidentAgentProcesses?: unknown }).maxResidentAgentProcesses;
  if (
    typeof maxResidentAgentProcesses !== "number" ||
    !Number.isInteger(maxResidentAgentProcesses) ||
    maxResidentAgentProcesses < AGENT_PROCESS_SETTINGS_LIMITS.min ||
    maxResidentAgentProcesses > AGENT_PROCESS_SETTINGS_LIMITS.max
  ) {
    return DEFAULT_AGENT_PROCESS_SETTINGS;
  }
  return { maxResidentAgentProcesses };
}

export interface ResidentProcessCandidate {
  id: string;
  processAlive: boolean;
  status: AgentSessionStatus;
  dormant: boolean;
  backgroundTaskCount: number;
  lastActiveAt: number;
}

export function isIdleResidentProcess(candidate: ResidentProcessCandidate): boolean {
  return (
    candidate.processAlive &&
    !candidate.dormant &&
    candidate.status !== "running" &&
    candidate.backgroundTaskCount === 0
  );
}

export function pickIdleResidentEvictionCandidate(
  candidates: ResidentProcessCandidate[],
): ResidentProcessCandidate | null {
  return candidates
    .filter(isIdleResidentProcess)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0] ?? null;
}

export function shouldShowBranchSessionInList(
  session: { entryCount: number; processAlive: boolean },
): boolean {
  return session.entryCount > 0 || session.processAlive;
}

export interface RunningResidentProcess {
  id: string;
  projectId: string;
  branch: string | null;
  title?: string | null;
  lastActiveAt: number;
}

export class ResidentProcessLimitError extends Error {
  readonly errorCode = "resident_limit_reached";
  readonly maxResidentAgentProcesses: number;
  readonly runningSessions: RunningResidentProcess[];

  constructor(maxResidentAgentProcesses: number, runningSessions: RunningResidentProcess[]) {
    super("Resident agent process limit reached");
    this.name = "ResidentProcessLimitError";
    this.maxResidentAgentProcesses = maxResidentAgentProcesses;
    this.runningSessions = runningSessions;
  }
}
