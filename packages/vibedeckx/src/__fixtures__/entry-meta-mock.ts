/**
 * Test-harness shim for the two entry queries lazy hydration added
 * (`getEntryMetaAll`, `getEntriesBefore`).
 *
 * The manager's unit tests each build a partial `Storage` around their own
 * `getEntries` stub. Both new queries are pure functions of the same rows, so
 * deriving them here keeps a dozen harnesses from hand-maintaining aggregates
 * that could silently drift from what `getEntries` returns.
 */

type EntryRow = { entry_index: number; data: string };

export function derivedEntryMeta(
  sessionIds: string | string[],
  getEntries: (sessionId: string) => Promise<EntryRow[]>,
) {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  return {
    getEntryMetaAll: async () => {
      const meta: Array<{ session_id: string; cnt: number; max_index: number }> = [];
      for (const session_id of ids) {
        const rows = await getEntries(session_id);
        if (rows.length === 0) continue;
        meta.push({
          session_id,
          cnt: rows.length,
          max_index: rows.reduce((max, row) => Math.max(max, row.entry_index), -1),
        });
      }
      return meta;
    },
    getEntriesBefore: async (sessionId: string, before: number | null, limit: number) =>
      (await getEntries(sessionId))
        .filter((row) => before === null || row.entry_index < before)
        .sort((a, b) => b.entry_index - a.entry_index)
        .slice(0, limit),
  };
}
