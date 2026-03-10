"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type ExecutorGroup } from "@/lib/api";

export function useExecutorGroups(projectId: string | null, selectedBranch: string | null | undefined) {
  const [groups, setGroups] = useState<ExecutorGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<ExecutorGroup | null>(null);
  const [loading, setLoading] = useState(true);

  const branch = selectedBranch ?? "";

  // Fetch all groups and the active group for the selected branch
  const fetchGroups = useCallback(async () => {
    if (!projectId) {
      setGroups([]);
      setActiveGroup(null);
      setLoading(false);
      return;
    }

    try {
      const [allGroups, branchGroup] = await Promise.all([
        api.getExecutorGroups(projectId),
        branch ? api.getExecutorGroupByBranch(projectId, branch) : Promise.resolve(null),
      ]);
      setGroups(allGroups);
      setActiveGroup(branchGroup);
    } catch (error) {
      console.error("Failed to fetch executor groups:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId, branch]);

  useEffect(() => {
    setLoading(true);
    fetchGroups();
  }, [fetchGroups]);

  const createGroup = useCallback(
    async (name: string) => {
      if (!projectId) return null;

      try {
        const group = await api.createExecutorGroup(projectId, { name, branch });
        setGroups((prev) => [...prev, group]);
        setActiveGroup(group);
        return group;
      } catch (error) {
        console.error("Failed to create executor group:", error);
        return null;
      }
    },
    [projectId, branch]
  );

  const updateGroup = useCallback(async (id: string, opts: { name?: string }) => {
    try {
      const group = await api.updateExecutorGroup(id, opts);
      setGroups((prev) => prev.map((g) => (g.id === id ? group : g)));
      setActiveGroup((prev) => (prev?.id === id ? group : prev));
      return group;
    } catch (error) {
      console.error("Failed to update executor group:", error);
      return null;
    }
  }, []);

  const deleteGroup = useCallback(async (id: string) => {
    try {
      await api.deleteExecutorGroup(id);
      setGroups((prev) => prev.filter((g) => g.id !== id));
      setActiveGroup((prev) => (prev?.id === id ? null : prev));
    } catch (error) {
      console.error("Failed to delete executor group:", error);
    }
  }, []);

  return {
    groups,
    activeGroup,
    loading,
    createGroup,
    updateGroup,
    deleteGroup,
    refetch: fetchGroups,
  };
}
