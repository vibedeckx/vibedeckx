"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentModels } from "@/lib/api";

export interface MachineModelsTarget {
  /** Set once a session exists: its list comes from the machine it runs on. */
  sessionId?: string | null;
  projectId?: string | null;
  /** The project's agent target; only distinguishes pre-session lists. */
  agentTarget?: string | null;
  agentType: string;
}

/**
 * The picker's model list for the machine that would run the pick. Fetched
 * when the target changes and again on every `refresh()` (the picker calls it
 * on open), so a worker that came back or a changed fx login shows up without
 * a reload; the server's cache keeps re-opens cheap.
 *
 * `models` is `null` until an answer arrives (or after a failure with nothing
 * shown yet) — the caller keeps the static suggestions meanwhile. A refresh
 * keeps the current list on screen until its answer lands.
 */
export function useMachineModels({ sessionId, projectId, agentTarget, agentType }: MachineModelsTarget): {
  models: string[] | null;
  refresh: () => void;
} {
  const key = sessionId
    ? `s::${sessionId}::${agentType}`
    : projectId ? `p::${projectId}::${agentTarget ?? ""}::${agentType}` : null;
  const [state, setState] = useState<{ key: string | null; models: string[] | null }>({ key, models: null });
  const [nonce, setNonce] = useState(0);
  const lastRequest = useRef(0);

  useEffect(() => {
    if (!key) return;
    const scope = sessionId ? { sessionId } : projectId ? { projectId } : null;
    if (!scope) return;
    const request = ++lastRequest.current;
    getAgentModels(scope, agentType)
      // Only the newest request may write: an older, slower answer for the
      // same key must not overwrite a fresher one.
      .then((list) => { if (request === lastRequest.current) setState({ key, models: list.models }); })
      .catch(() => {});
  }, [key, sessionId, projectId, agentType, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // A previous target's answer is never shown for the new one.
  return { models: state.key === key ? state.models : null, refresh };
}
