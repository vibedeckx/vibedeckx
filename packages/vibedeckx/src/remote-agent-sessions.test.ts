import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("./utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (r: { status: number }, fallback = 502) => (r.status === 0 ? fallback : r.status),
}));

// vi.mock is hoisted above imports, so this static import receives the mocked module.
import { createRemoteAgentSession, type RemoteAgentSessionDeps } from "./remote-agent-sessions.js";

describe("createRemoteAgentSession", () => {
  let dir: string;
  let storage: Storage;
  let remoteSessionMap: Map<string, RemoteSessionInfo>;
  let upsert: ReturnType<typeof vi.fn>;
  let emitBranchActivityIfChanged: ReturnType<typeof vi.fn>;

  const agentMode = "srv-source";
  const projectId = "proj-1";

  const makeDeps = (): RemoteAgentSessionDeps => ({
    remoteSessionMap,
    remoteSessionMappings: { upsert } as unknown as Storage["remoteSessionMappings"],
    remotePatchCache: new RemotePatchCache(),
    agentSessionManager: { emitBranchActivityIfChanged } as never,
    reverseConnectManager: null,
    storage,
  });

  const params = () => ({
    projectId,
    agentMode,
    remoteConfig: { server_url: "http://b:5173", server_api_key: "key", remote_path: "/remote/path" },
    branch: "main" as string | null,
    permissionMode: "edit" as const,
    agentType: "claude-code",
    force: false,
    userId: "user-1" as string | undefined,
  });

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-ras-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    remoteSessionMap = new Map();
    upsert = vi.fn().mockResolvedValue(undefined);
    emitBranchActivityIfChanged = vi.fn();

    // Enable cross-remote MCP minting: a public URL plus an opted-in remote that
    // is not the source (agentMode). Then the happy path forwards a crossRemoteMcp.
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const target = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    await storage.remoteServers.update(target.id, { cross_remote_access: "exec" }, "user-1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  it("happy path: pre-registers, forwards sessionId + crossRemoteMcp, upserts, keeps the map entry", async () => {
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[5] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    const deps = makeDeps();

    const res = await createRemoteAgentSession(deps, params());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const localSessionId = res.localSessionId;
    const remoteSessionId = localSessionId.replace(`remote-${agentMode}-${projectId}-`, "");

    // Forwarded body carries the server-generated sessionId and a crossRemoteMcp config.
    expect(proxyToRemoteAuto).toHaveBeenCalledTimes(1);
    const call = proxyToRemoteAuto.mock.calls[0];
    expect(call[4]).toBe("/api/path/agent-sessions/new");
    const body = call[5] as { sessionId: string; crossRemoteMcp?: { url: string; token: string } };
    expect(body.sessionId).toBe(remoteSessionId);
    expect(body.crossRemoteMcp?.url).toContain("/api/cross-remote-mcp");
    expect(body.crossRemoteMcp?.token).toBeTruthy();

    // Persisted mapping written with the pre-computed id.
    expect(upsert).toHaveBeenCalledWith(localSessionId, projectId, agentMode, remoteSessionId, "main");

    // Map entry survives a successful create.
    expect(remoteSessionMap.has(localSessionId)).toBe(true);
    expect(remoteSessionMap.get(localSessionId)?.remoteSessionId).toBe(remoteSessionId);
  });

  it("pre-registration ordering: the map entry exists at the moment proxyToRemoteAuto is invoked", async () => {
    let hadEntryAtCallTime = false;
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[5] as { sessionId: string };
      const localSessionId = `remote-${agentMode}-${projectId}-${body.sessionId}`;
      // The race the design exists to prevent: the entry must be present *now*,
      // not merely after proxyToRemoteAuto resolves.
      hadEntryAtCallTime = remoteSessionMap.has(localSessionId);
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });

    await createRemoteAgentSession(makeDeps(), params());
    expect(hadEntryAtCallTime).toBe(true);
  });

  it("failure cleanup — !ok: deletes the map entry and returns { ok: false, status }", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: false, status: 503, data: { error: "boom" } });

    const res = await createRemoteAgentSession(makeDeps(), params());
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("failure cleanup — thrown: a rejecting proxyToRemoteAuto deletes the entry and propagates", async () => {
    proxyToRemoteAuto.mockRejectedValue(new Error("reverse-connect channel closed"));

    await expect(createRemoteAgentSession(makeDeps(), params())).rejects.toThrow(
      "reverse-connect channel closed",
    );
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("failure cleanup — upsert throws: deletes the entry and propagates", async () => {
    proxyToRemoteAuto.mockImplementation(async (..._args: unknown[]) => {
      const body = _args[5] as { sessionId: string };
      return { ok: true, status: 200, data: { session: { id: body.sessionId }, messages: [] } };
    });
    upsert.mockRejectedValue(new Error("db write failed"));

    await expect(createRemoteAgentSession(makeDeps(), params())).rejects.toThrow("db write failed");
    expect(remoteSessionMap.size).toBe(0);
  });

  it("id-echo mismatch: deletes the entry, does NOT upsert, returns status 409", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: true,
      status: 200,
      data: { session: { id: "a-completely-different-id" }, messages: [] },
    });

    const res = await createRemoteAgentSession(makeDeps(), params());
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(remoteSessionMap.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
