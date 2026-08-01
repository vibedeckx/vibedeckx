"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Project, type SyncButtonConfig, type ExecutionMode } from "@/lib/api";

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

  const updateProject = async (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    agentMode?: ExecutionMode;
    executorMode?: ExecutionMode;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }) => {
    const updated = await api.updateProject(id, opts);
    setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
    if (currentProject?.id === id) {
      setCurrentProject(updated);
    }
    return updated;
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
