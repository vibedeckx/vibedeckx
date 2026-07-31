"use client";

import { useCallback, useRef } from "react";
import type { Project, Schedule, ScheduleRun } from "@/lib/api";

export interface ManualScheduleRunRequest {
  requestId: string;
  runId: string;
  sourceRunId: string;
}

export interface ProjectActivityActionsOptions {
  projectId: string | null;
  resolveProjectForTarget: (projectId: string, target: string) => Promise<Project | null>;
  getScheduleRun: (runId: string) => Promise<ScheduleRun>;
  getSchedules: (projectId: string) => Promise<Schedule[]>;
  runScheduleNow: (scheduleId: string, request: ManualScheduleRunRequest) => Promise<{ runId: string }>;
  selectAgentSession: (branch: string | null, sessionId: string, projectId: string) => void;
  openScheduleRun: (scheduleId: string, runId: string) => void;
  onRerunStarted: () => void;
  onError: (kind: "session-navigation" | "schedule-navigation" | "schedule-rerun", error: unknown) => void;
}

interface Scope {
  projectId: string | null;
  generation: number;
}

const RERUN_INTENT_PREFIX = "vibedeckx:schedule-rerun:v1";

function intentKey(projectId: string, sourceRunId: string): string {
  return `${RERUN_INTENT_PREFIX}:${encodeURIComponent(projectId)}:${encodeURIComponent(sourceRunId)}`;
}

function readIntent(key: string): ManualScheduleRunRequest | undefined {
  try {
    const value = window.sessionStorage.getItem(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<ManualScheduleRunRequest>;
    return typeof parsed.requestId === "string" && typeof parsed.runId === "string"
      && typeof parsed.sourceRunId === "string" ? parsed as ManualScheduleRunRequest : undefined;
  } catch { return undefined; }
}

function persistIntent(key: string, value: ManualScheduleRunRequest): void {
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* in-memory copy remains */ }
}

function clearIntent(key: string): void {
  try { window.sessionStorage.removeItem(key); } catch { /* storage may be unavailable */ }
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status?: unknown }).status === status;
}

export function useProjectActivityActions(options: ProjectActivityActionsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const scopeRef = useRef<Scope>({ projectId: options.projectId, generation: 0 });
  if (scopeRef.current.projectId !== options.projectId) {
    scopeRef.current = { projectId: options.projectId, generation: scopeRef.current.generation + 1 };
  }
  const intentsRef = useRef(new Map<string, ManualScheduleRunRequest>());
  const inFlightRef = useRef(new Map<string, Promise<void>>());

  const isCurrent = useCallback((scope: Scope) => (
    scopeRef.current.projectId === scope.projectId && scopeRef.current.generation === scope.generation
  ), []);

  const verifyScheduleRun = useCallback(async (scope: Scope, sourceRunId: string) => {
    if (!scope.projectId) return null;
    const current = optionsRef.current;
    const run = await current.getScheduleRun(sourceRunId);
    if (!isCurrent(scope)) return null;
    if (run.project_id !== scope.projectId) throw new Error("Schedule run does not belong to the active project");
    const schedules = await current.getSchedules(scope.projectId);
    if (!isCurrent(scope)) return null;
    const schedule = schedules.find((candidate) => candidate.id === run.schedule_id);
    if (!schedule || schedule.project_id !== scope.projectId) {
      throw new Error("Schedule does not belong to the active project");
    }
    return { run, schedule };
  }, [isCurrent]);

  const openAgentSession = useCallback(async (sessionId: string, target: string, branch: string | null) => {
    const scope = { ...scopeRef.current };
    if (!scope.projectId) return;
    try {
      const project = await optionsRef.current.resolveProjectForTarget(scope.projectId, target);
      if (!isCurrent(scope) || !project || project.id !== scope.projectId) return;
      optionsRef.current.selectAgentSession(branch, sessionId, project.id);
    } catch (error) {
      if (isCurrent(scope)) optionsRef.current.onError("session-navigation", error);
    }
  }, [isCurrent]);

  const openScheduleRun = useCallback(async (runId: string, knownScheduleId?: string) => {
    const scope = { ...scopeRef.current };
    try {
      const verified = await verifyScheduleRun(scope, runId);
      if (!verified || !isCurrent(scope)) return;
      if (knownScheduleId && knownScheduleId !== verified.schedule.id) {
        throw new Error("Schedule run target changed while opening");
      }
      optionsRef.current.openScheduleRun(verified.schedule.id, runId);
    } catch (error) {
      if (isCurrent(scope)) optionsRef.current.onError("schedule-navigation", error);
    }
  }, [isCurrent, verifyScheduleRun]);

  const runScheduleAgain = useCallback((sourceRunId: string): Promise<void> => {
    const scope = { ...scopeRef.current };
    if (!scope.projectId) return Promise.resolve();
    const flightKey = `${scope.projectId}:${sourceRunId}`;
    const existingFlight = inFlightRef.current.get(flightKey);
    if (existingFlight) return existingFlight;

    const operation = (async () => {
      try {
        const verified = await verifyScheduleRun(scope, sourceRunId);
        if (!verified || !isCurrent(scope)) return;
        const key = intentKey(scope.projectId!, sourceRunId);
        let request = intentsRef.current.get(key) ?? readIntent(key);
        if (!request) {
          const id = crypto.randomUUID();
          request = { requestId: id, runId: id, sourceRunId };
          intentsRef.current.set(key, request);
          persistIntent(key, request);
        }
        await optionsRef.current.runScheduleNow(verified.schedule.id, request);
        intentsRef.current.delete(key);
        clearIntent(key);
        if (!isCurrent(scope)) return;
        optionsRef.current.onRerunStarted();
      } catch (error) {
        if (scope.projectId && hasStatus(error, 409)) {
          const key = intentKey(scope.projectId, sourceRunId);
          intentsRef.current.delete(key);
          clearIntent(key);
        }
        if (isCurrent(scope)) optionsRef.current.onError("schedule-rerun", error);
        throw error;
      }
    })();
    const tracked = operation.finally(() => {
      if (inFlightRef.current.get(flightKey) === tracked) inFlightRef.current.delete(flightKey);
    });
    inFlightRef.current.set(flightKey, tracked);
    return tracked;
  }, [isCurrent, verifyScheduleRun]);

  return { openAgentSession, openScheduleRun, runScheduleAgain };
}
