import type { Storage } from "./storage/types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";

export interface RemoteSessionCleanupDeps {
  storage: Storage;
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remotePatchCache: RemotePatchCache;
}

/**
 * Identity of the remote session a caller believes it is forgetting. Supply it
 * whenever the decision to forget was made from an earlier observation.
 */
export interface RemoteSessionExpectation {
  remoteServerId: string;
  remoteSessionId: string;
}

/**
 * Forget everything the hub remembers about one remote session — routing map,
 * persisted mapping row (with its notification cursor), patch cache and search
 * cache — in one idempotent call.
 *
 * There are three paths that must forget a remote session
 * (docs/plans/2026-08-08-session-retention.md §3.1): the user deleting it, the
 * reconciliation pass noticing the worker no longer has it, and the belt that
 * fires when someone opens a handle the worker reports as gone. Each of them
 * clearing "most of" the four would leave a different flavour of ghost, so
 * they share this one function instead.
 *
 * With `expect`, the persisted delete becomes a compare-and-delete on that
 * identity and runs FIRST: it is the linearization point, and the caches are
 * only touched once it has committed. Reconciliation needs this because a
 * local session id can be re-mapped to a new remote session at any moment, and
 * the in-memory map is registered BEFORE the row is persisted (see
 * remote-agent-sessions.ts) — so a map entry can already name the new remote
 * session while the row still names the old one. Deleting the map entry
 * blindly would sever a session the user just created. The guard below covers
 * that: the entry is only dropped while it still names the expected session.
 *
 * Without `expect` ("forget this handle whatever it points at" — the user
 * pressing delete, or the dead-handle belt) everything is unconditional, and
 * the return value is always true.
 *
 * Returns false only when `expect` no longer matched and nothing was touched.
 */
export async function forgetRemoteSession(
  deps: RemoteSessionCleanupDeps,
  localSessionId: string,
  opts?: { expect?: RemoteSessionExpectation },
): Promise<boolean> {
  const expect = opts?.expect;
  const deleted = await deps.storage.remoteSessionMappings.delete(localSessionId, expect);
  if (expect && !deleted) return false;

  const live = deps.remoteSessionMap.get(localSessionId);
  if (!expect
    || (live
      && live.remoteServerId === expect.remoteServerId
      && live.remoteSessionId === expect.remoteSessionId)) {
    deps.remoteSessionMap.delete(localSessionId);
  }
  deps.remotePatchCache.delete(localSessionId);
  await deps.storage.searchCache.noteSessionDeleted(localSessionId)
    .catch((err) => console.error("[RemoteSessionCleanup] search-cache write-through failed:", err));
  return true;
}
