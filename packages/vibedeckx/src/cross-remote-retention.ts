import type { Storage } from "./storage/types.js";
import { MS_PER_DAY, parseRetentionDays } from "./session-retention-config.js";

/**
 * Age-based cleanup of `cross_remote_audit`, which grows by one row per
 * gateway call. Rides the session-retention tick (every 6h, hub and worker
 * alike) as maintenance, so it runs even when session retention itself is off.
 *
 * The audit is a security record, so it is always pruned but never switched
 * off: default 90 days, `VIBEDECKX_CROSS_REMOTE_AUDIT_RETENTION_DAYS` to change
 * it. Artifact lookup does not read the audit (it reads
 * `agent_session_remote_touches`, which lives as long as its session), so
 * pruning here never breaks a link in a conversation.
 */

export const CROSS_REMOTE_AUDIT_RETENTION_ENV = "VIBEDECKX_CROSS_REMOTE_AUDIT_RETENTION_DAYS";
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

const AUDIT_PRUNE_BATCH = 1000;

/**
 * The configured audit window. Anything unparseable falls back to the default
 * rather than meaning "keep forever" — unlike session retention, off is not an
 * option here.
 */
export function auditRetentionDays(raw: string | undefined = process.env[CROSS_REMOTE_AUDIT_RETENTION_ENV]): number {
  return parseRetentionDays(raw) ?? DEFAULT_AUDIT_RETENTION_DAYS;
}

/** Returns the number of audit rows removed. */
export async function pruneCrossRemoteAudit(
  storage: Pick<Storage, "crossRemoteAudit">,
  opts: { now?: number; auditDays?: number; batchSize?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - (opts.auditDays ?? auditRetentionDays()) * MS_PER_DAY);
  const batchSize = opts.batchSize ?? AUDIT_PRUNE_BATCH;

  let removed = 0;
  for (;;) {
    const deleted = await storage.crossRemoteAudit.pruneBefore(cutoff, batchSize);
    removed += deleted;
    if (deleted < batchSize) break;
    // better-sqlite3 is synchronous: a first run over a long-unpruned table
    // must not hold the event loop for the whole backlog.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (removed > 0) console.log(`[CrossRemoteRetention] pruned ${removed} audit row(s)`);
  return removed;
}
