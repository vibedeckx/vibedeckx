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
  projectId: string;
  branch: string | null;
  processAlive: boolean;
  status: AgentSessionStatus;
  dormant: boolean;
  /**
   * Whether live background tasks still shield this session from eviction.
   * Not a raw count: a task that outlived its turn past the park deadline has
   * been judged anomalous and stops protecting, so one stuck shell can no
   * longer pin a resident slot forever. See TurnCompletionLedger.
   */
  backgroundTasksProtect: boolean;
  lastActiveAt: number;
}

export interface ResidentProcessScope {
  projectId: string;
  branch: string | null;
}

export function isResidentProcessInScope(
  candidate: ResidentProcessScope,
  scope: ResidentProcessScope,
): boolean {
  return candidate.projectId === scope.projectId && candidate.branch === scope.branch;
}

export function isIdleResidentProcess(candidate: ResidentProcessCandidate): boolean {
  return (
    candidate.processAlive &&
    !candidate.dormant &&
    candidate.status !== "running" &&
    !candidate.backgroundTasksProtect
  );
}

export function pickIdleResidentEvictionCandidate(
  candidates: ResidentProcessCandidate[],
  scope?: ResidentProcessScope,
): ResidentProcessCandidate | null {
  return candidates
    .filter((candidate) => !scope || isResidentProcessInScope(candidate, scope))
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

/**
 * One session that currently holds a live agent process — the unit the sidebar
 * shows under a workspace. Deliberately NOT `RunningResidentProcess`: that one
 * serves eviction bookkeeping and demands `status === "running"`, whereas an
 * idle-but-alive session is exactly what the sidebar must keep listing.
 */
export interface AliveAgentSession {
  id: string;
  projectId: string;
  branch: string | null;
  status: AgentSessionStatus;
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
