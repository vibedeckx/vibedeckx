"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/**
 * Remote server id → the name its owner gave it.
 *
 * Cross-remote tool calls carry the bare uuid in their arguments, which tells a
 * reader nothing about which machine the agent just touched; this is what
 * translates it. The list has to be the global one: a cross-remote call may
 * target any accessible remote, not only the ones linked to the open project,
 * so `useProjectRemotes` (whose rows carry `server_name`) is not a substitute.
 *
 * It is tiny and near-static, so it is fetched lazily — nothing happens until a
 * conversation actually renders a cross-remote card — and shared by every card
 * through an external store, since one session can hold dozens of them.
 */
const state: { names: Map<string, string> | null; loadedAt: number } = { names: null, loadedAt: 0 };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * How long a loaded list is trusted before the next card to mount revalidates
 * it. Renaming a remote in Settings has to reach an open conversation without a
 * page reload, and names are not worth a subscription or a poll — a bounded
 * staleness window is the whole mechanism.
 */
const REVALIDATE_AFTER_MS = 60_000;

/**
 * An id missing from a loaded list is a remote added after the fetch; one
 * refetch picks it up. The cooldown keeps an id that will never appear from
 * refetching on every render.
 */
const MISS_REFETCH_COOLDOWN_MS = 60_000;
let lastMissRefetchAt = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Map<string, string> | null {
  return state.names;
}

function getServerSnapshot(): Map<string, string> | null {
  return null;
}

/**
 * Publishes a list someone else already fetched. The screen that renames a
 * remote reloads its own list anyway, and the conversation behind it stays
 * mounted (the workspace view is hidden by CSS, not unmounted), so this is what
 * makes an open transcript stop showing the old name — no remount, no refetch.
 */
export function publishRemoteServerNames(servers: Array<{ id: string; name: string }>): void {
  // Merged into the previous names, not replacing them, and always a new Map so
  // the store's snapshot identity changes. A remote deleted since the last look
  // keeps its last known name: the card records a call that already happened,
  // and the name it ran against stays truer than a uuid prefix.
  const names = new Map(state.names);
  for (const server of servers) names.set(server.id, server.name);
  state.names = names;
  state.loadedAt = Date.now();
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  // Every card mounts at once on a history replay; they share one request.
  if (inFlight) return inFlight;
  const promise = api
    .getRemoteServers()
    .then((servers) => {
      publishRemoteServerNames(servers);
    })
    .catch((err) => {
      console.error("Failed to load remote server names:", err);
    })
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    });
  inFlight = promise;
  return promise;
}

/** Test seam: the cache is module-level, so it outlives a test's component tree. */
export function __resetRemoteServerNamesCache(): void {
  state.names = null;
  state.loadedAt = 0;
  inFlight = null;
  lastMissRefetchAt = 0;
  listeners.clear();
}

/**
 * Enough of a uuid to tell two remotes apart in a transcript, for when the name
 * is genuinely unavailable (list still loading, or the remote was deleted).
 * Never render an empty string there — a call with no visible target reads as a
 * local one.
 */
export function shortRemoteId(remoteId: string): string {
  return `remote ${remoteId.slice(0, 8)}`;
}

export interface RemoteServerName {
  /** The remote's name, or null while it is unknown. */
  name: string | null;
  /** What to show: the name when known, a short id otherwise, null with no id at all. */
  label: string | null;
  /** True only until the list is known for the first time. */
  loading: boolean;
}

export function useRemoteServerName(remoteId: string | null | undefined): RemoteServerName {
  const names = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!state.names || Date.now() - state.loadedAt > REVALIDATE_AFTER_MS) void load();
  }, []);

  // A remote created after this page loaded: refetch once, then stay quiet.
  useEffect(() => {
    if (!remoteId || !names || names.has(remoteId)) return;
    const now = Date.now();
    if (now - lastMissRefetchAt < MISS_REFETCH_COOLDOWN_MS) return;
    lastMissRefetchAt = now;
    void load();
  }, [remoteId, names]);

  const name = (remoteId && names?.get(remoteId)) || null;
  return {
    name,
    label: name ?? (remoteId ? shortRemoteId(remoteId) : null),
    loading: names === null,
  };
}
