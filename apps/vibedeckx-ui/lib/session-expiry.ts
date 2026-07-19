// Clerk enforces a hard maximum session lifetime counted from sign-in (a
// dashboard setting, 7 days by default), so an actively-working user is signed
// out the moment the session's expireAt passes. When `isSignedIn` flips false
// the session object is already gone; the last expireAt observed while signed
// in is what lets us tell lifetime expiry apart from an intentional sign-out.

// Clerk's server decides expiry by its own clock; the slack absorbs client
// clock drift so a refresh 401 seconds before our local expireAt still
// classifies as expiry.
const CLOCK_SLACK_MS = 60_000;

export function isSessionExpirySignOut(
  lastKnownExpireAtMs: number | null,
  nowMs: number
): boolean {
  if (lastKnownExpireAtMs === null) return false;
  return nowMs >= lastKnownExpireAtMs - CLOCK_SLACK_MS;
}
