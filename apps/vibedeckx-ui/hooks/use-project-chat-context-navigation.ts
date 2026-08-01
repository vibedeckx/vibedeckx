"use client";

import { useCallback, useRef } from "react";

import type { Project, ProjectChatContextRef, Schedule, Task } from "@/lib/api";

export interface ProjectChatContextNavigationOptions {
  projectId: string | null;
  schedules: Schedule[];
  getTask: (projectId: string, taskId: string) => Promise<Task>;
  resolveProjectForTarget: (projectId: string, target: string) => Promise<Project | null>;
  openTask: (task: Task) => void;
  selectAgentSession: (branch: string | null, sessionId: string, projectId: string) => void;
  selectWorkspace: (branch: string | null, projectId: string) => void;
  selectSchedule: (scheduleId: string) => void;
  openScheduleRun: (runId: string, scheduleId: string) => Promise<void> | void;
  onError: (error: unknown) => void;
}

interface Scope { projectId: string | null; generation: number }

export function useProjectChatContextNavigation(options: ProjectChatContextNavigationOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const scopeRef = useRef<Scope>({ projectId: options.projectId, generation: 0 });
  if (scopeRef.current.projectId !== options.projectId) {
    scopeRef.current = { projectId: options.projectId, generation: scopeRef.current.generation + 1 };
  }
  const isCurrent = useCallback((scope: Scope) => (
    scope.projectId === scopeRef.current.projectId && scope.generation === scopeRef.current.generation
  ), []);

  const open = useCallback(async (ref: ProjectChatContextRef): Promise<void> => {
    const scope = { ...scopeRef.current };
    const navigation = ref.navigation;
    if (!scope.projectId || ref.deleted || !navigation) {
      if (isCurrent(scope)) optionsRef.current.onError(new Error("This Context item is no longer available"));
      return;
    }
    try {
      if (navigation.kind === "task") {
        const task = await optionsRef.current.getTask(scope.projectId, navigation.taskId);
        if (!isCurrent(scope)) return;
        if (task.id !== navigation.taskId || task.project_id !== scope.projectId) {
          throw new Error("Task is no longer available in this project");
        }
        optionsRef.current.openTask(task);
        return;
      }
      if (navigation.kind === "agent_session" || navigation.kind === "workspace") {
        const project = await optionsRef.current.resolveProjectForTarget(scope.projectId, navigation.target);
        if (!isCurrent(scope)) return;
        if (!project || project.id !== scope.projectId) throw new Error("Workspace target is no longer available");
        if (navigation.kind === "agent_session") {
          optionsRef.current.selectAgentSession(navigation.branch, navigation.sessionId, project.id);
        } else {
          optionsRef.current.selectWorkspace(navigation.branch, project.id);
        }
        return;
      }
      if (navigation.kind === "schedule") {
        const schedule = optionsRef.current.schedules.find((candidate) => (
          candidate.id === navigation.scheduleId && candidate.project_id === scope.projectId
        ));
        if (!schedule) throw new Error("Schedule is no longer available in this project");
        optionsRef.current.selectSchedule(schedule.id);
        return;
      }
      await optionsRef.current.openScheduleRun(navigation.runId, navigation.scheduleId);
    } catch (error) {
      if (isCurrent(scope)) optionsRef.current.onError(error);
    }
  }, [isCurrent]);

  return { open };
}
