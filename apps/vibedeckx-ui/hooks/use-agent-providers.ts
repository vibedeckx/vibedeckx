"use client";

import { useEffect, useState } from "react";
import { getAgentProviders, type AgentProviderInfo } from "@/lib/api";

/** Dialogs load the server's list when opened; no invented available providers. */
export function useAgentProviders(enabled: boolean) {
  type Result = { providers: AgentProviderInfo[]; error: string | null };
  const [state, setState] = useState<{ enabled: boolean; result: Result | null }>({ enabled, result: null });
  // Reset before painting a new open, so a previous empty/error result cannot
  // flash while this open's request is pending.
  if (state.enabled !== enabled) setState({ enabled, result: null });
  const result = state.enabled === enabled ? state.result : null;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getAgentProviders().then((providers) => {
      if (active) setState({ enabled: true, result: { providers, error: null } });
    }).catch(() => {
      if (active) setState({ enabled: true, result: { providers: [], error: "Failed to load agent providers" } });
    });
    return () => { active = false; };
  }, [enabled]);
  return { providers: result?.providers ?? [], error: result?.error ?? null, loading: enabled && result === null };
}
