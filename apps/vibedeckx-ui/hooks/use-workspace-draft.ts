import { useCallback, useState } from "react";

const KEY_PREFIX = "vibedeckx:agent-draft:";

function storageKey(projectId: string | null, branch: string | null): string | null {
  if (!projectId || !branch) return null;
  return `${KEY_PREFIX}${projectId}:${branch}`;
}

function readDraft(key: string | null): string {
  if (!key || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string | null, value: string): void {
  if (!key || typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // ignore quota / privacy-mode errors
  }
}

/**
 * Per-workspace persistent draft bound to (projectId, branch).
 * Reloads the draft when the workspace key changes, so switching workspaces
 * swaps drafts without leaking text between them.
 */
export function useWorkspaceDraft(
  projectId: string | null,
  branch: string | null
): [string, (value: string) => void] {
  const currentKey = storageKey(projectId, branch);

  const [draft, setDraftState] = useState<string>(() => readDraft(currentKey));
  const [loadedKey, setLoadedKey] = useState<string | null>(currentKey);

  // Sync state with the active workspace during render — React re-renders
  // immediately with the new state, so there is no flicker of stale draft.
  if (loadedKey !== currentKey) {
    setLoadedKey(currentKey);
    setDraftState(readDraft(currentKey));
  }

  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      writeDraft(currentKey, value);
    },
    [currentKey]
  );

  return [draft, setDraft];
}
