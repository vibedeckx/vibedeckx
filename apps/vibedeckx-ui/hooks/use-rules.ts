"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type Rule } from "@/lib/api";

export function useRules(projectId: string | null, branch: string | null) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRules = useCallback(async () => {
    if (!projectId) {
      setRules([]);
      setLoading(false);
      return;
    }

    try {
      const data = await api.getRules(projectId, branch);
      setRules(data);
    } catch (error) {
      console.error("Failed to fetch rules:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId, branch]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const createRule = useCallback(
    async (opts: { name: string; content: string; enabled?: boolean }) => {
      if (!projectId) return null;

      try {
        const rule = await api.createRule(projectId, { ...opts, branch });
        setRules((prev) => [...prev, rule]);
        return rule;
      } catch (error) {
        console.error("Failed to create rule:", error);
        return null;
      }
    },
    [projectId, branch]
  );

  const updateRule = useCallback(
    async (id: string, opts: { name?: string; content?: string; enabled?: boolean }) => {
      const previousRules = rules;
      setRules((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...opts, enabled: opts.enabled !== undefined ? (opts.enabled ? 1 : 0) : r.enabled, updated_at: new Date().toISOString() } : r))
      );

      try {
        const rule = await api.updateRule(id, opts);
        setRules((prev) => prev.map((r) => (r.id === id ? rule : r)));
        return rule;
      } catch (error) {
        console.error("Failed to update rule:", error);
        setRules(previousRules);
        return null;
      }
    },
    [rules]
  );

  const deleteRule = useCallback(async (id: string) => {
    const previousRules = rules;
    setRules((prev) => prev.filter((r) => r.id !== id));

    try {
      await api.deleteRule(id);
    } catch (error) {
      console.error("Failed to delete rule:", error);
      setRules(previousRules);
    }
  }, [rules]);

  return {
    rules,
    loading,
    createRule,
    updateRule,
    deleteRule,
    refetch: fetchRules,
  };
}
