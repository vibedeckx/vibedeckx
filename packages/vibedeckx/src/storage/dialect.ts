import { sql, type RawBuilder } from "kysely";

/**
 * Dialect-specific value/SQL adapters injected into the repositories.
 * The repositories never know which backend they run on; everything
 * dialect-flavored lives here. A future postgres.ts provides its own.
 */
export interface DialectHelpers {
  /** Boolean → storage representation (sqlite: 0/1; pg: native). */
  toDbBool(b: boolean): number | boolean;
  /** Millisecond-precision "now" for agent_sessions timestamps (lex-sortable). */
  nowMs(): RawBuilder<string>;
  /**
   * Recency tiebreaker for same-timestamp rows.
   * DIALECT: sqlite rowid; the pg backend will need a monotonic column —
   * grep for rowIdDesc when building it.
   */
  rowIdDesc(): RawBuilder<unknown>;
}

/** Storage → JS boolean, valid for both 0/1 and native booleans. */
export const fromDbBool = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;

export const sqliteHelpers: DialectHelpers = {
  toDbBool: (b) => (b ? 1 : 0),
  nowMs: () => sql<string>`strftime('%Y-%m-%d %H:%M:%f', 'now')`,
  rowIdDesc: () => sql`rowid desc`,
};
