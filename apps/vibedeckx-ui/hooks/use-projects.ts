"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Project, type ExecutionMode } from "@/lib/api";

export function useProjects(initialProjectId?: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoredRouteProjectId, setRestoredRouteProjectId] = useState(initialProjectId);
  const currentProjectRef = useRef(currentProject);
  const initialProjectIdRef = useRef(initialProjectId);
  currentProjectRef.current = currentProject;
  initialProjectIdRef.current = initialProjectId;
  const routeProjectChanged = restoredRouteProjectId !== initialProjectId;
  const routeProjectPending = loading || routeProjectChanged;
  const routeProjectNotFound = !routeProjectPending
    && Boolean(initialProjectId)
    && !projects.some((project) => project.id === initialProjectId);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProjects();
      setProjects(data);
      if (data.length > 0 && !currentProjectRef.current) {
        const preferred = initialProjectIdRef.current
          ? data.find((p) => p.id === initialProjectIdRef.current)
          : data[0];
        setCurrentProject(preferred ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!routeProjectChanged || loading) return;
    setRestoredRouteProjectId(initialProjectId);
    setCurrentProject(initialProjectId
      ? projects.find((project) => project.id === initialProjectId) ?? null
      : projects[0] ?? null);
  }, [initialProjectId, loading, projects, routeProjectChanged]);

  const createProject = async (opts: {
    name: string;
    path?: string;
    remotePath?: string;
  }) => {
    const project = await api.createProject(opts);
    setProjects((prev) => [project, ...prev]);
    setCurrentProject(project);
    return project;
  };

  const applyProject = useCallback((id: string, next: Project | ((prev: Project) => Project)) => {
    const resolve = (p: Project) => (typeof next === "function" ? next(p) : next);
    setProjects((prev) => prev.map((p) => (p.id === id ? resolve(p) : p)));
    setCurrentProject((prev) => (prev?.id === id ? resolve(prev) : prev));
  }, []);

  // One chain per project id for in-flight optimistic updates. `seq` marks the
  // latest request so an earlier response arriving late can't overwrite a newer
  // optimistic value; `baseline` is the last server-confirmed project, restored
  // if the chain's final request fails.
  const optimisticRef = useRef(new Map<string, { seq: number; baseline: Project }>());

  const updateProject = async (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    agentMode?: ExecutionMode;
    executorMode?: ExecutionMode;
  }) => {
    // Only the mode toggles are applied optimistically: they are pure
    // preferences the UI reads directly (executor target, agent target), so
    // waiting a PUT round trip just makes the toggle feel laggy. Name/path
    // edits go through dialogs with server-side validation and keep the
    // confirm-then-apply flow.
    const patch: Partial<Project> = {};
    if (opts.agentMode !== undefined) patch.agent_mode = opts.agentMode;
    if (opts.executorMode !== undefined) patch.executor_mode = opts.executorMode;
    const optimistic = Object.keys(patch).length > 0;

    let chain: { seq: number; baseline: Project } | undefined;
    if (optimistic) {
      const known = projects.find((p) => p.id === id) ?? currentProjectRef.current;
      chain = optimisticRef.current.get(id);
      if (!chain && known && known.id === id) {
        chain = { seq: 0, baseline: known };
        optimisticRef.current.set(id, chain);
      }
      if (chain) chain.seq += 1;
      applyProject(id, (p) => ({ ...p, ...patch }));
    }
    const mySeq = chain?.seq;
    const isLatest = () => !chain || chain.seq === mySeq;

    try {
      const updated = await api.updateProject(id, opts);
      if (isLatest()) {
        if (chain) optimisticRef.current.delete(id);
        applyProject(id, updated);
      }
      return updated;
    } catch (error) {
      if (chain && isLatest()) {
        optimisticRef.current.delete(id);
        applyProject(id, chain.baseline);
      }
      throw error;
    }
  };

  const deleteProject = async (id: string) => {
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (currentProject?.id === id) {
      setCurrentProject(projects.find((p) => p.id !== id) ?? null);
    }
  };

  const addProject = (project: Project) => {
    setProjects((prev) => [project, ...prev]);
    setCurrentProject(project);
  };

  const selectProject = (project: Project) => {
    setCurrentProject(project);
  };

  return {
    projects,
    currentProject: routeProjectChanged ? null : currentProject,
    routeProjectPending,
    routeProjectNotFound,
    loading,
    addProject,
    createProject,
    updateProject,
    deleteProject,
    selectProject,
    refresh: fetchProjects,
  };
}
