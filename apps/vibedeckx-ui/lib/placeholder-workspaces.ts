"use client";

import { useSyncExternalStore } from "react";

/**
 * "This workspace is in placeholder mode" — the user clicked New Conversation
 * but hasn't sent a first message yet, so no DB session exists. Tracked per
 * `(projectId, branch, agentMode)` triple and persisted to localStorage so the
 * intent survives reloads and project switches.
 *
 * Single source of truth for the workspace dot's "idle" override: the backend
 * doesn't know this state (it sees only `agent_sessions` rows), so without
 * this signal the sidebar would happily show the prior session's `completed`
 * dot the moment branch activity is refetched (e.g. on project switch-back).
 *
 * Cleared at the natural exit points: `ensureSession` (first message creates a
 * real DB session) and the workspace-change effect (user picks an explicit
 * history session). See `use-agent-session.ts`.
 */

const STORAGE_KEY = "vibedeckx:placeholder-workspaces";

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function persist(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // quota exceeded or private-mode disable — accept loss; placeholder state
    // is best-effort UX, not a correctness requirement.
  }
}

let state: Set<string> = load();
const subscribers = new Set<() => void>();
// Singleton for SSR so `getServerSnapshot` returns a referentially stable
// value across server renders (required by `useSyncExternalStore`).
const EMPTY_SNAPSHOT: ReadonlySet<string> = new Set();

function notify(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): ReadonlySet<string> {
  return state;
}

function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY_SNAPSHOT;
}

export function workspaceKey(
  projectId: string,
  branch: string | null,
  agentMode: string | null | undefined,
): string {
  return `${projectId}:${branch ?? ""}:${agentMode ?? ""}`;
}

export function hasPlaceholder(key: string): boolean {
  return state.has(key);
}

export function addPlaceholder(key: string): void {
  if (state.has(key)) return;
  const next = new Set(state);
  next.add(key);
  state = next;
  persist(state);
  notify();
}

/** Returns true iff the key was present and got removed. */
export function removePlaceholder(key: string): boolean {
  if (!state.has(key)) return false;
  const next = new Set(state);
  next.delete(key);
  state = next;
  persist(state);
  notify();
  return true;
}

export function usePlaceholderWorkspaces(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
