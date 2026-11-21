"use client";

import { useCallback, useState, useSyncExternalStore, useEffect } from "react";
import { getAgentModels, type MachineModelList, type ModelListScope } from "@/lib/api";

export interface MachineModelsTarget {
  /** Set once a session exists; only used to find (and authorize) its machine. */
  sessionId?: string | null;
  projectId?: string | null;
  /** The project's agent target: the machine a new session would run on. */
  agentTarget?: string | null;
  /** Remote server ids linked to the project, to tell which one a session is on. */
  knownRemoteIds?: readonly string[];
  agentType: string;
}

export interface MachineModels {
  /** null until an answer arrives — the caller shows the static suggestions meanwhile. */
  models: string[] | null;
  /** A forced refresh is in flight. */
  refreshing: boolean;
  /**
   * Re-asks only when what is held is not the machine's own list (nothing yet,
   * or the static fallback after an offline worker or a CLI error), or when the
   * machine's cache entry behind it has expired. The picker calls it on open.
   */
  revalidate: () => void;
  /** Re-runs the CLI on the machine, skipping its cache (the refresh button). */
  refresh: () => void;
}

/**
 * The machine a session runs on. Remote session ids are
 * `remote-<serverId>-<projectId>-<sessionId>`; matched against the project's
 * known server ids rather than split, since the ids themselves contain dashes.
 * null = a remote session on a server this project no longer lists.
 */
export function machineOfSession(sessionId: string, knownRemoteIds: readonly string[]): string | null {
  if (!sessionId.startsWith("remote-")) return "local";
  return knownRemoteIds.find((id) => sessionId.startsWith(`remote-${id}-`)) ?? null;
}

// ---- Page-lifetime store, keyed by machine + agent type ----
// A model list belongs to a machine's CLI login, not to a session or project:
// switching sessions on one machine, or a first message turning the new
// conversation into a session, reuses what is already here.

interface StoreEntry {
  list: MachineModelList;
  /** This browser's clock: past it, the machine has a fresh answer to give. */
  staleAt: number;
}

/** When an answer carries no expiry, ask again after this long. */
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;

const store = new Map<string, StoreEntry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function fetchInto(key: string, scope: ModelListScope, agentType: string, force: boolean): Promise<void> {
  const pending = inFlight.get(key);
  // A forced refresh does not join a plain load: that one may be answered
  // from the machine's cache, which is what the user asked to skip.
  if (pending && !force) return pending;
  const run = getAgentModels(scope, agentType, force ? { refresh: true } : undefined)
    .then((list) => {
      const expiresIn = typeof list.expiresInMs === "number" && list.expiresInMs >= 0 ? list.expiresInMs : DEFAULT_EXPIRY_MS;
      store.set(key, { list, staleAt: Date.now() + expiresIn });
      notify();
    })
    // A failed request keeps whatever is held.
    .catch(() => {})
    .finally(() => { if (inFlight.get(key) === run) inFlight.delete(key); });
  inFlight.set(key, run);
  return run;
}

/** Test hook. */
export function resetMachineModelsStore(): void {
  store.clear();
  inFlight.clear();
  notify();
}

export function useMachineModels({ sessionId, projectId, agentTarget, knownRemoteIds = [], agentType }: MachineModelsTarget): MachineModels {
  const machine = sessionId ? machineOfSession(sessionId, knownRemoteIds) : agentTarget ?? null;
  const scope: ModelListScope | null = sessionId ? { sessionId } : projectId ? { projectId } : null;
  // An unknown machine (a session on an unlisted server) is keyed by its
  // session, so it can never borrow another machine's list.
  const key = scope === null
    ? null
    : machine !== null ? `m::${machine}::${agentType}` : `s::${sessionId}::${agentType}`;
  const scopeId = scope ? ("sessionId" in scope ? `s:${scope.sessionId}` : `p:${scope.projectId}`) : null;

  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) ?? null : null),
    () => null,
  );
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);

  const load = useCallback((force: boolean) => {
    if (!key || !scope) return Promise.resolve();
    // Held and not yet stale: the machine would answer exactly this. The
    // fallback list is always re-asked for — it is what a failure left.
    const held = store.get(key);
    if (!force && held?.list.source === "machine" && Date.now() < held.staleAt) return Promise.resolve();
    return fetchInto(key, scope, agentType, force);
    // scopeId stands in for `scope`, which is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scopeId, agentType]);

  useEffect(() => { void load(false); }, [load]);

  const revalidate = useCallback(() => { void load(false); }, [load]);
  // The spinner is set here, in the click handler, and cleared by the forced
  // request itself, so it can never outlive that request.
  const refresh = useCallback(() => {
    if (!key) return;
    setRefreshingKey(key);
    void load(true).finally(() => setRefreshingKey((k) => (k === key ? null : k)));
  }, [key, load]);

  return { models: entry?.list.models ?? null, refreshing: refreshingKey !== null && refreshingKey === key, revalidate, refresh };
}
