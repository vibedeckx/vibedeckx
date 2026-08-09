import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Storage, RemoteSessionMapping } from "./storage/types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemoteSessionInfo } from "./server-types.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("./utils/remote-proxy.js", () => ({ proxyToRemoteAuto }));

const { reconcileRemoteSessions } = await import("./remote-session-reconcile.js");

/**
 * Hub-side convergence after a worker's own retention sweep
 * (docs/plans/2026-08-08-session-retention.md §3.1).
 *
 * Everything here is about the two ways a snapshot diff goes wrong: treating
 * "I couldn't ask" as "it's gone", and treating a snapshot taken before a
 * concurrent write as authoritative over it.
 */

const TARGET = { projectId: "p1", remoteServerId: "worker-1", remotePath: "/srv/app" };

function mapping(local: string, remote: string, server = "worker-1"): RemoteSessionMapping {
  return {
    local_session_id: local, project_id: "p1", remote_server_id: server,
    remote_session_id: remote, branch: "dev", workspace_checkout_id: null,
    notification_sync_start: "from_now", notification_watch_until: 0,
  } as RemoteSessionMapping;
}

function makeDeps(mappings: RemoteSessionMapping[]) {
  const rows = new Map(mappings.map((m) => [m.local_session_id, m]));
  const deleted: string[] = [];
  const searchCacheDeleted: string[] = [];
  const remoteSessionMap = new Map<string, RemoteSessionInfo>(
    mappings.map((m) => [m.local_session_id, {
      remoteServerId: m.remote_server_id, remoteSessionId: m.remote_session_id, branch: m.branch,
    }]),
  );
  const patchCacheDeleted: string[] = [];

  const storage = {
    remoteSessionMappings: {
      getAll: async () => [...rows.values()],
      getByLocal: async (id: string) => rows.get(id),
      delete: async (id: string, expect?: { remoteServerId: string; remoteSessionId: string }) => {
        const row = rows.get(id);
        if (expect && (!row
          || row.remote_server_id !== expect.remoteServerId
          || row.remote_session_id !== expect.remoteSessionId)) {
          return false;
        }
        rows.delete(id);
        if (row) deleted.push(id);
        return Boolean(row);
      },
    },
    searchCache: {
      noteSessionDeleted: async (id: string) => { searchCacheDeleted.push(id); },
    },
  } as unknown as Storage;

  return {
    deps: {
      storage,
      reverseConnectManager: {} as ReverseConnectManager,
      remoteSessionMap,
      remotePatchCache: { delete: (id: string) => { patchCacheDeleted.push(id); } } as unknown as RemotePatchCache,
    },
    rows, deleted, searchCacheDeleted, remoteSessionMap, patchCacheDeleted,
  };
}

const inventory = (sessionIds: string[], complete = true) =>
  ({ ok: true, status: 200, data: { sessionIds, complete } });

beforeEach(() => proxyToRemoteAuto.mockReset());

describe("reconcileRemoteSessions", () => {
  it("forgets mappings whose remote session is gone, and only those", async () => {
    const h = makeDeps([mapping("remote-a", "ra"), mapping("remote-b", "rb")]);
    proxyToRemoteAuto.mockResolvedValue(inventory(["rb"]));

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary).toEqual({ targetsChecked: 1, targetsSkipped: 0, forgotten: 1 });
    expect(h.deleted).toEqual(["remote-a"]);
    // All four pieces of hub state go together — that is the whole point of
    // routing every path through one cleanup function.
    expect(h.remoteSessionMap.has("remote-a")).toBe(false);
    expect(h.remoteSessionMap.has("remote-b")).toBe(true);
    expect(h.patchCacheDeleted).toEqual(["remote-a"]);
    expect(h.searchCacheDeleted).toEqual(["remote-a"]);
  });

  it("cleans nothing when the worker is unreachable — absence is not deletion", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 0, data: null, errorCode: "network_error" });

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary).toEqual({ targetsChecked: 0, targetsSkipped: 1, forgotten: 0 });
    expect(h.deleted).toEqual([]);
  });

  it("cleans nothing when the worker is too old to serve the inventory route", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 404, data: { error: "Not Found" } });

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary.targetsSkipped).toBe(1);
    expect(h.deleted).toEqual([]);
  });

  it("cleans nothing when the listing contains a non-string id", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    // Filtering the bad element out would leave a SHORTER list, and on this
    // path a shorter list means "these were deleted" — so a malformed payload
    // would turn into mass cleanup of perfectly live mappings.
    proxyToRemoteAuto.mockResolvedValue({
      ok: true, status: 200, data: { sessionIds: ["ra", 123], complete: true },
    });

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary).toEqual({ targetsChecked: 0, targetsSkipped: 1, forgotten: 0 });
    expect(h.deleted).toEqual([]);
    expect(h.remoteSessionMap.has("remote-a")).toBe(true);
  });

  it("cleans nothing when the listing does not assert completeness", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    // A truncated page would make every unlisted session look deleted.
    proxyToRemoteAuto.mockResolvedValue(inventory([], false));

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary.targetsSkipped).toBe(1);
    expect(h.deleted).toEqual([]);
  });

  it("spares a mapping created while the inventory request was in flight", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockImplementation(async () => {
      // The user creates a session on the worker mid-request; the worker's
      // snapshot predates it. Capturing the mapping set FIRST is what keeps
      // this brand-new session out of the eligible set.
      h.rows.set("remote-new", mapping("remote-new", "rnew"));
      return inventory([]);
    });

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(h.deleted).toEqual(["remote-a"]);
    expect(h.rows.has("remote-new")).toBe(true);
    expect(summary.forgotten).toBe(1);
  });

  it("spares a local id that was re-mapped to a different remote session mid-flight", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockImplementation(async () => {
      // Reconnect/recreate rebinds the same local handle to a new remote id.
      // Cleaning by local id alone would take the fresh mapping down with it.
      h.rows.set("remote-a", mapping("remote-a", "ra-v2"));
      return inventory(["ra-v2"]);
    });

    const summary = await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(summary.forgotten).toBe(0);
    expect(h.deleted).toEqual([]);
    expect(h.rows.get("remote-a")!.remote_session_id).toBe("ra-v2");
  });

  it("leaves the in-memory route alone when a remap has registered it ahead of the row", async () => {
    // Remote session creation calls remoteSessionMap.set BEFORE persisting the
    // mapping (remote-agent-sessions.ts registers early so the agent's first
    // tool call is routable). So mid-remap the map already names the NEW
    // remote session while the row still names the old one — and dropping the
    // map entry by local id would sever a session the user just created.
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockImplementation(async () => {
      h.remoteSessionMap.set("remote-a", {
        remoteServerId: "worker-1", remoteSessionId: "ra-v2", branch: "dev",
      });
      return inventory([]);
    });

    await reconcileRemoteSessions(h.deps, [TARGET]);

    // The stale row goes (the remap's upsert re-creates it), the live route stays.
    expect(h.deleted).toEqual(["remote-a"]);
    expect(h.remoteSessionMap.get("remote-a")?.remoteSessionId).toBe("ra-v2");
  });

  it("scopes each target to its own project and server", async () => {
    const h = makeDeps([mapping("remote-a", "ra"), mapping("remote-other", "ro", "worker-2")]);
    proxyToRemoteAuto.mockResolvedValue(inventory([]));

    await reconcileRemoteSessions(h.deps, [TARGET]);

    expect(h.deleted).toEqual(["remote-a"]);
    expect(h.rows.has("remote-other")).toBe(true);
  });

  it("does not call the worker at all when it holds no mappings", async () => {
    const h = makeDeps([]);
    await reconcileRemoteSessions(h.deps, [TARGET]);
    expect(proxyToRemoteAuto).not.toHaveBeenCalled();
  });

  it("is idempotent — a second round finds nothing left to forget", async () => {
    const h = makeDeps([mapping("remote-a", "ra")]);
    proxyToRemoteAuto.mockResolvedValue(inventory([]));
    await reconcileRemoteSessions(h.deps, [TARGET]);
    const second = await reconcileRemoteSessions(h.deps, [TARGET]);
    expect(second.forgotten).toBe(0);
  });
});
