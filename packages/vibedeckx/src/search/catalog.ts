import type { Storage, SearchCatalogSnapshot } from "../storage/types.js";
import { pruneWorktrees, getWorktreeBranches } from "../utils/worktree-paths.js";
import { shouldShowBranchSessionInList } from "../resident-agent-processes.js";

export interface CatalogDeps {
  storage: Storage;
  getProcessAlive?: (sessionId: string) => boolean;
}

// SQLite stores updated_at as 'YYYY-MM-DD HH:MM:SS.SSS' (UTC).
const parseDbTimestamp = (ts: string | null | undefined): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
};

/**
 * One project's full workspace/session summary — the unit of search-cache
 * refresh. Serves both the worker HTTP endpoint (remote targets) and the
 * in-process local-target refresh. Deliberately NOT branch-scoped: the
 * existing session-list endpoints filter by branch by design and therefore
 * cannot enumerate a project for cache reconciliation.
 */
export async function buildSearchCatalog(
  deps: CatalogDeps,
  projectId: string,
  projectPath: string,
): Promise<SearchCatalogSnapshot & { snapshotAt: number }> {
  pruneWorktrees(projectPath);
  const workspaces = getWorktreeBranches(projectPath); // [{ branch: null }, { branch: "dev" }, ...]
  const sessions = await deps.storage.agentSessions.getByProjectId(projectId);
  const counts = new Map(
    (await deps.storage.agentSessions.countEntries()).map((r) => [r.session_id, r.cnt]),
  );
  return {
    snapshotAt: Date.now(),
    workspaces,
    sessions: sessions
      .map((s) => ({ s, entryCount: counts.get(s.id) ?? 0 }))
      .filter(({ s, entryCount }) => shouldShowBranchSessionInList({
        entryCount,
        processAlive: deps.getProcessAlive?.(s.id) ?? false,
      }))
      .map(({ s, entryCount }) => ({
        id: s.id,
        branch: s.branch === "" ? null : s.branch,
        title: s.title ?? null,
        lastActiveAt: s.last_user_message_at ?? parseDbTimestamp(s.updated_at),
        favoritedAt: s.favorited_at ?? null,
        entryCount,
      })),
  };
}
