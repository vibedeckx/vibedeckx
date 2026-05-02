/**
 * Map a `requireAuth` return value into a non-empty userId string suitable
 * for Langfuse trace metadata. `undefined` (no-auth mode and remote-proxy
 * api-key path both return undefined) collapses to `"local"`. `null` —
 * which `requireAuth` returns when it has already sent a 401 reply —
 * never reaches code that needs to call this helper, but we still handle
 * it defensively as `"local"`.
 */
export function resolveUserId(authResult: string | undefined | null): string {
  return typeof authResult === "string" ? authResult : "local";
}
