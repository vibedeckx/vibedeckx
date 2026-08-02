/**
 * A warning sink that emits at most one line per key per window, folding what it
 * swallowed into the next line's count.
 *
 * For events a stuck client can repeat indefinitely — a rejected connect
 * handshake, say — where silence hides an outage but one line per attempt
 * drowns the log.
 *
 * Keys typically come from untrusted input (source addresses), so the number of
 * distinct keys is not the caller's to bound: `maxKeys` is a hard cap, enforced
 * by expiring stale entries and then evicting the least-recently-warned one.
 */
export function createRateLimitedWarn(windowMs: number, maxKeys: number) {
  const seen = new Map<string, { last: number; suppressed: number }>();

  return function warnRateLimited(key: string, message: string): void {
    const now = Date.now();
    const entry = seen.get(key);

    if (entry && now - entry.last < windowMs) {
      entry.suppressed++;
      return;
    }

    // Only a genuinely new key can grow the map, so only then do we make room.
    if (!entry && seen.size >= maxKeys) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of seen) {
        if (now - v.last > windowMs) {
          seen.delete(k);
          continue;
        }
        if (v.last < oldestAt) {
          oldestAt = v.last;
          oldestKey = k;
        }
      }
      // Everything still inside its window: expiry freed nothing, so evict.
      if (seen.size >= maxKeys && oldestKey !== null) seen.delete(oldestKey);
    }

    const suppressed = entry?.suppressed ?? 0;
    seen.set(key, { last: now, suppressed: 0 });
    console.warn(
      message +
        (suppressed > 0 ? ` (+${suppressed} more in the last ${Math.round(windowMs / 1000)}s)` : "")
    );
  };
}
