// Remembers the last app location (path + query: project, tab, branch,
// ?session=) so a fresh load of the bare root — after signing out and back in,
// or reopening the site from its home URL — returns the user to where they
// were instead of the first project in the list. A deep link always wins: only
// a load of exactly "/" is redirected.
//
// Scoped per signed-in user (auth-wrapper calls setLastLocationUser) so an
// account switch on a shared browser never lands in the previous user's
// project. Every localStorage access is wrapped: a disabled/full store just
// means "no restore".

const KEY_PREFIX = "vibedeckx.lastLocation.";

let scopeKey = "solo";
// What restoreLastLocation wrote (path + the user it was for), while that
// restore is still unsettled.
let pending: { path: string; scope: string } | null = null;

export function setLastLocationUser(userId: string | null): void {
  scopeKey = userId ?? "solo";
}

function storageKey(): string {
  return `${KEY_PREFIX}${scopeKey}`;
}

// Only app-shaped, same-origin paths are ever written back into history.
function isRestorablePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && value !== "/";
}

export function saveLastLocation(pathAndSearch: string): void {
  if (typeof window === "undefined" || !isRestorablePath(pathAndSearch)) return;
  try {
    window.localStorage.setItem(storageKey(), pathAndSearch);
  } catch {
    // ignore
  }
}

export function clearLastLocation(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    // ignore
  }
}

/**
 * If the page was loaded at the bare root, rewrite the URL to the remembered
 * location. Must run before the URL is first parsed.
 */
export function restoreLastLocation(): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  // StrictMode re-runs the initializer on the URL we just wrote, for the same
  // user: keep that restore. Any other call starts clean, so a restore left
  // unsettled by an earlier mount (e.g. the previous user's, before a
  // session-expiry re-sign-in) never applies to it.
  if (pending && pending.scope === scopeKey && pending.path === pathname + search) return;
  pending = null;
  if (pathname !== "/" || search) return;
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(storageKey());
  } catch {
    return;
  }
  if (!saved || !isRestorablePath(saved)) return;
  window.history.replaceState(null, "", saved + hash);
  pending = { path: window.location.pathname + window.location.search, scope: scopeKey };
}

/**
 * Settle a pending restore once the app has resolved the restored URL's
 * project. Returns true when the URL on screen is still the one
 * restoreLastLocation wrote and its project is gone — the saved location is
 * then forgotten. Either way the restore is over: any navigation, before or
 * after this point (back/forward to a missing project), is the user's own and
 * never treated as restored.
 */
export function settleRestoredLocation(projectFound: boolean): boolean {
  const wasRestored = pending !== null
    && typeof window !== "undefined"
    && window.location.pathname + window.location.search === pending.path;
  pending = null;
  if (!wasRestored || projectFound) return false;
  clearLastLocation();
  return true;
}
