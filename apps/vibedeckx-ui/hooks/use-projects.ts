"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type Project, type SyncButtonConfig, type ExecutionMode } from "@/lib/api";

export function useProjects(initialProjectId?: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProjects();
      setProjects(data);
      if (data.length > 0 && !currentProject) {
        const preferred = initialProjectId
          ? data.find((p) => p.id === initialProjectId)
          : null;
        setCurrentProject(preferred ?? data[0]);
      }
    } finally {
      setLoading(false);
    }
  }, [currentProject, initialProjectId]);

  useEffect(() => {
    fetchProjects();
  }, []);

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
    currentProject,
    loading,
    addProject,
    createProject,
    updateProject,
    deleteProject,
    selectProject,
    refresh: fetchProjects,
  };
}
