import { describe, expect, it, vi } from "vitest";
import { settleRemoteSessionDelete } from "./remote-session-cleanup.js";
import { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { Storage } from "./storage/types.js";

const LOCAL_ID = "remote-srv-p1-r1";

function makeDeps() {
  const mappingDelete = vi.fn(async () => true);
  const noteSessionDeleted = vi.fn(async () => {});
  const emit = vi.fn();
  const remoteSessionMap = new Map<string, RemoteSessionInfo>([
    [LOCAL_ID, { remoteServerId: "srv", remoteSessionId: "r1", branch: "dev" }],
  ]);
  const deps = {
    storage: {
      remoteSessionMappings: { delete: mappingDelete },
      searchCache: { noteSessionDeleted },
    } as unknown as Storage,
    remoteSessionMap,
    remotePatchCache: new RemotePatchCache(),
    eventBus: { emit } as never,
  };
  return { deps, mappingDelete, noteSessionDeleted, emit, remoteSessionMap };
}

const settle = (deps: ReturnType<typeof makeDeps>["deps"], result: { ok: boolean; status: number }) =>
  settleRemoteSessionDelete(deps, LOCAL_ID, { projectId: "p1", branch: "dev" }, result);

describe("settleRemoteSessionDelete", () => {
  it("forgets the handle and drops the sidebar row when the worker deleted it", async () => {
    const { deps, mappingDelete, noteSessionDeleted, emit, remoteSessionMap } = makeDeps();
    expect(await settle(deps, { ok: true, status: 200 })).toBe(true);
    expect(mappingDelete).toHaveBeenCalledWith(LOCAL_ID, undefined);
    expect(noteSessionDeleted).toHaveBeenCalledWith(LOCAL_ID);
    expect(remoteSessionMap.has(LOCAL_ID)).toBe(false);
    // Full remote- id: the one the sidebar keys its rows by.
    expect(emit).toHaveBeenCalledWith({
      type: "session:process", projectId: "p1", branch: "dev", sessionId: LOCAL_ID, alive: false,
    });
  });

  it("treats a worker 404 as already deleted (retry after a lost response)", async () => {
    const { deps, mappingDelete, emit, remoteSessionMap } = makeDeps();
    expect(await settle(deps, { ok: false, status: 404 })).toBe(true);
    expect(mappingDelete).toHaveBeenCalled();
    expect(remoteSessionMap.has(LOCAL_ID)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network error / timeout", 502],
    ["worker 5xx", 500],
    ["worker refused", 409],
  ])("keeps the mapping on %s so the user can retry", async (_label, status) => {
    const { deps, mappingDelete, noteSessionDeleted, emit, remoteSessionMap } = makeDeps();
    expect(await settle(deps, { ok: false, status })).toBe(false);
    expect(mappingDelete).not.toHaveBeenCalled();
    expect(noteSessionDeleted).not.toHaveBeenCalled();
    expect(remoteSessionMap.has(LOCAL_ID)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the mapping when the request never reached the worker (status 0)", async () => {
    const { deps, mappingDelete, emit } = makeDeps();
    expect(await settle(deps, { ok: false, status: 0 })).toBe(false);
    expect(mappingDelete).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
