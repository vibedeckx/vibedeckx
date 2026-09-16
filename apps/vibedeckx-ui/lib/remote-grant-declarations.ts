import type { SessionRemoteGrant } from "@/lib/api";

/**
 * The composer's cross-remote declaration: which machines the NEXT turn of a
 * conversation may reach (docs/cross-remote-session-grants-design.md §0.1).
 *
 * Purely client state, persisted the same way the composer's draft text is.
 * It is deliberately not a view of the server's grant table — that table is
 * what the LAST turn ran under, and the two diverge the moment the user
 * changes their mind without sending. What each turn actually ran under is
 * visible in the transcript, on the `<vremotes>` chip of its own message.
 *
 * Absent and empty mean the same thing — "the next turn gets nothing" — so
 * only non-empty declarations are stored and there is nothing to garbage
 * collect beyond what the user themselves cleared.
 */
const STORAGE_KEY = "vibedeckx:remote-grant-declarations";

type Store = Record<string, SessionRemoteGrant[]>;

/** Before a conversation exists the declaration belongs to the workspace it is being composed in. */
export const declarationKey = (sessionId: string | null, workspaceKey: string): string =>
  sessionId ? `s:${sessionId}` : `w:${workspaceKey}`;

function load(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Store : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(store).length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota / private mode: the declaration still governs this page's sends,
    // it just will not survive a reload.
  }
}

export function readDeclaration(key: string): SessionRemoteGrant[] {
  const value = load()[key];
  return Array.isArray(value) ? value : [];
}

export function writeDeclaration(key: string, granted: SessionRemoteGrant[]): void {
  const store = load();
  if (granted.length === 0) delete store[key];
  else store[key] = granted;
  save(store);
}

/**
 * Hand a pre-session declaration to the conversation it just created.
 *
 * Without this the chips would clear the moment the first message lands, and
 * the SECOND message would assert an empty list — silently revoking what the
 * first one had just granted.
 */
export function adoptDeclaration(workspaceKey: string, sessionId: string): void {
  const from = declarationKey(null, workspaceKey);
  const to = declarationKey(sessionId, workspaceKey);
  const store = load();
  const pending = store[from];
  if (!pending || store[to]) return;
  store[to] = pending;
  delete store[from];
  save(store);
}
