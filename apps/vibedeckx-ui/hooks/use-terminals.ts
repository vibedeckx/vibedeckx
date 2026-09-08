"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type TerminalSession } from "@/lib/api";

export interface UseTerminalsResult {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  createTerminal: (location?: "local" | "remote", remoteServerId?: string) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  setActiveTerminal: (id: string) => void;
  removeTerminal: (id: string) => void;
}

export function useTerminals(
  projectId: string | null,
  branch?: string | null
): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  // Terminals belong to one (project, workspace). Opening a shell from a failed
  // delete switches the workspace and creates the terminal in the same commit,
  // so the create runs *while* that workspace's list is still in flight — and
  // the two answers have to be combined rather than one overwriting the other:
  // the list alone was taken before the new shell existed, and the create alone
  // leaves the previous workspace's shells on screen.
  const scope = `${projectId ?? ""}::${branch ?? ""}`;
  const scopeRef = useRef(scope);
  // Terminals created for this scope since its list was asked for.
  const createdWhileLoadingRef = useRef<TerminalSession[]>([]);

  // Fetch existing terminals when projectId or branch changes
  useEffect(() => {
    scopeRef.current = scope;
    createdWhileLoadingRef.current = [];
    if (!projectId) {
      setTerminals([]);
      setActiveTerminalId(null);
      return;
    }

    api.getTerminals(projectId, branch).then((list) => {
      // A later workspace already owns the panel; this list is not its own.
      if (scopeRef.current !== scope) return;
      const created = createdWhileLoadingRef.current;
      createdWhileLoadingRef.current = [];
      const merged = created.length === 0
        ? list
        : [...list.filter((existing) => !created.some((one) => one.id === existing.id)), ...created];
      setTerminals(merged);
      setActiveTerminalId(created.length > 0
        ? created[created.length - 1].id
        : (merged.length > 0 ? merged[0].id : null));
    });
  }, [projectId, branch, scope]);

  const createTerminal = useCallback(async (location?: "local" | "remote", remoteServerId?: string) => {
    if (!projectId) return;
    const requestedFor = scopeRef.current;
    try {
      const terminal = await api.createTerminal(projectId, branch, location, remoteServerId);
      // The user moved on while it was starting: it belongs to a workspace that
      // is no longer on screen, and must not be shown under this one.
      if (scopeRef.current !== requestedFor) return;
      createdWhileLoadingRef.current = [...createdWhileLoadingRef.current, terminal];
      setTerminals((prev) => [...prev, terminal]);
      setActiveTerminalId(terminal.id);
    } catch (error) {
      console.error("[useTerminals] Failed to create terminal:", error);
    }
  }, [projectId, branch]);

  // A terminal that is gone must also leave the pending-creation buffer, or a
  // list that answers afterwards merges it back in — closed, exited, dead — and
  // makes it the active one.
  const forget = useCallback((id: string) => {
    createdWhileLoadingRef.current = createdWhileLoadingRef.current.filter((one) => one.id !== id);
  }, []);

  const closeTerminal = useCallback(async (id: string) => {
    await api.closeTerminal(id);
    forget(id);
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTerminalId((prevActive) =>
        prevActive === id
          ? (next.length > 0 ? next[next.length - 1].id : null)
          : prevActive
      );
      return next;
    });
  }, [forget]);

  const setActiveTerminal = useCallback((id: string) => {
    setActiveTerminalId(id);
  }, []);

  // Remove a terminal from the list (called when shell exits on its own)
  const removeTerminal = useCallback((id: string) => {
    forget(id);
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTerminalId((prevActive) =>
        prevActive === id
          ? (next.length > 0 ? next[next.length - 1].id : null)
          : prevActive
      );
      return next;
    });
  }, [forget]);

  return {
    terminals,
    activeTerminalId,
    createTerminal,
    closeTerminal,
    setActiveTerminal,
    removeTerminal,
  };
}
