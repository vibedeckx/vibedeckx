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

/**
 * Map of placeholder key → epoch ms when the reset happened. The timestamp
 * lets the workspace dot order a reset against a terminal orchestrator
 * (`main-completed`) state: a reset newer than the completion wins (gray), an
 * older one yields to the green dot. See `computeWorkspaceStatuses`.
 */
function load(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, number>();
    for (const item of parsed) {
      // Current format: [key, since] entries.
      if (
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "number"
      ) {
        out.set(item[0], item[1]);
      } else if (typeof item === "string") {
        // Legacy format: array of bare keys with no timestamp. Treat as a
        // fresh reset so existing placeholders keep their gray dot.
        out.set(item, Date.now());
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function persist(map: Map<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...map]));
  } catch {
    // quota exceeded or private-mode disable — accept loss; placeholder state
    // is best-effort UX, not a correctness requirement.
  }
}

let state: Map<string, number> = load();
const subscribers = new Set<() => void>();
// Singleton for SSR so `getServerSnapshot` returns a referentially stable
// value across server renders (required by `useSyncExternalStore`).
const EMPTY_SNAPSHOT: ReadonlyMap<string, number> = new Map();

function notify(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): ReadonlyMap<string, number> {
  return state;
}

function getServerSnapshot(): ReadonlyMap<string, number> {
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

/** Epoch ms when the placeholder was created, or undefined if not present. */
export function getPlaceholderSince(key: string): number | undefined {
  return state.get(key);
}

export function addPlaceholder(key: string): void {
  // Always (re)stamp with the current time — the reset moment is what the dot
  // ordering compares against, so a repeat New Conversation refreshes it.
  const next = new Map(state);
  next.set(key, Date.now());
  state = next;
  persist(state);
  notify();
}

/** Returns true iff the key was present and got removed. */
export function removePlaceholder(key: string): boolean {
  if (!state.has(key)) return false;
  const next = new Map(state);
  next.delete(key);
  state = next;
  persist(state);
  notify();
  return true;
}

export function usePlaceholderWorkspaces(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
