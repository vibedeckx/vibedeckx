import type { Storage } from "./storage/types.js";

/**
 * Session-retention configuration
 * (docs/plans/2026-08-08-session-retention.md §3).
 *
 * One global value per server, deliberately not per-worker: no known scenario
 * wants one machine at 30 days and another at 365, and a second config source
 * would only add a precedence rule to get wrong.
 *
 * Empty / absent = OFF, and OFF is the default. Both CLIs we wrap keep their
 * transcripts forever, so a product that silently started deleting history on
 * upgrade would be a nasty surprise; the operator turns it on.
 */
export const SESSION_RETENTION_SETTING_KEY = "session_retention_days";

/** Prefilled in the UI when the operator first enables retention. */
export const SESSION_RETENTION_SUGGESTED_DAYS = 90;

/**
 * Accepted range. The lower bound keeps "0 days" from meaning "delete
 * everything now" and the upper bound is simply past any plausible intent —
 * anything outside is treated as OFF rather than clamped, because a
 * misconfigured value must never turn into a whole-database delete.
 */
export const SESSION_RETENTION_DAYS_MIN = 1;
export const SESSION_RETENTION_DAYS_MAX = 3650;

export const MS_PER_DAY = 86_400_000;

/**
 * Parse a stored/submitted retention value into "days" or null (= disabled).
 * Everything that is not a whole number inside the accepted range — empty,
 * `"0"`, negatives, `"abc"`, `NaN`, `Infinity`, `12.5` — disables retention.
 * There is no partial credit and no clamping on purpose (§1.2).
 */
export function parseRetentionDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < SESSION_RETENTION_DAYS_MIN || value > SESSION_RETENTION_DAYS_MAX) return null;
  return value;
}

/** Read the effective retention window, or null when retention is off. */
export async function readRetentionDays(storage: Storage): Promise<number | null> {
  return parseRetentionDays(await storage.settings.get(SESSION_RETENTION_SETTING_KEY));
}

/** Epoch-ms boundary: sessions whose `activity_at` is strictly older expire. */
export function retentionCutoff(days: number, now: number): number {
  return now - days * MS_PER_DAY;
}
