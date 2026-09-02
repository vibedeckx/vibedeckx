/**
 * Pending first-send submissions, persisted across hard refreshes
 * (docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md §10.1).
 *
 * A first send is a lifecycle operation with a stable key. Before the
 * request goes out, the submission — operation id, prepared session id (if
 * any), workspace, content — is written here; it is cleared only on a
 * terminal outcome. A refresh, a lost response or an explicit retry then
 * replays the SAME key, so the server returns the same session instead of
 * creating a second one. `sessionStorage` is deliberate: the identity is
 * scoped to this tab's conversation, not to the browser profile.
 *
 * One pending submission per workspace: a newer submission for the same
 * workspace replaces (and reports) the older one so it can be cancelled.
 */

import type { ContentPart } from "@/hooks/use-agent-session";

const STORAGE_KEY = "vibedeckx:pending-submissions";

export interface PendingSubmission {
  workspaceKey: string;
  projectId: string;
  branch: string | null;
  agentMode: string;
  operationId: string;
  /** Prepared session id once `prepare` (or `start`) has answered; null before. */
  sessionId: string | null;
  /** Content as it will be activated (pastes already materialized). Null while still preparing. */
  content: string | ContentPart[] | null;
  permissionMode?: "plan" | "edit";
  model?: string | null;
  createdAt: number;
}

function load(): Map<string, PendingSubmission> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, PendingSubmission>();
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as PendingSubmission).workspaceKey === "string"
        && typeof (item as PendingSubmission).operationId === "string") {
        out.set((item as PendingSubmission).workspaceKey, item as PendingSubmission);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function save(map: Map<string, PendingSubmission>): void {
  if (typeof window === "undefined") return;
  try {
    if (map.size === 0) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...map.values()]));
  } catch {
    // Quota / privacy mode: the submission still works, it just won't survive a refresh.
  }
}

export function readPendingSubmission(workspaceKey: string): PendingSubmission | null {
  return load().get(workspaceKey) ?? null;
}

/** Persist a submission; returns the one it replaced (same workspace, different operation), if any. */
export function writePendingSubmission(submission: PendingSubmission): PendingSubmission | null {
  const map = load();
  const previous = map.get(submission.workspaceKey) ?? null;
  map.set(submission.workspaceKey, submission);
  save(map);
  return previous && previous.operationId !== submission.operationId ? previous : null;
}

/** Clear only if the stored submission is still the given operation. */
export function clearPendingSubmission(workspaceKey: string, operationId: string): boolean {
  const map = load();
  const current = map.get(workspaceKey);
  if (!current || current.operationId !== operationId) return false;
  map.delete(workspaceKey);
  save(map);
  return true;
}

/** Stable content equality for "is this the same submission being retried?". */
export function sameSubmissionContent(a: string | ContentPart[] | null, b: string | ContentPart[] | null): boolean {
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return typeof a === "string" && typeof b === "string" && a.trim() === b.trim();
  return JSON.stringify(a) === JSON.stringify(b);
}
