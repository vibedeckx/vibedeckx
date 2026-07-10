import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import { buildMcpConfigArg, mintCrossRemoteMcpConfig, crossRemoteMcpEnabled } from "./cross-remote-mcp-config.js";
import { verifyCrossRemoteToken, getCrossRemoteSecret } from "./utils/cross-remote-token.js";

describe("cross-remote MCP config", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xrcfg-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VIBEDECKX_PUBLIC_URL;
  });

  it("is disabled when VIBEDECKX_PUBLIC_URL is unset", async () => {
    expect(crossRemoteMcpEnabled()).toBe(false);
    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null },
    );
    expect(config).toBeUndefined();
  });

  it("is disabled without an authenticated userId", async () => {
    // requireAuth yields undefined in solo/no-auth mode. A token with an empty userId
    // would resolve any tenant's remote, so mint nothing.
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-1");

    expect(await mintCrossRemoteMcpConfig({ storage }, { userId: undefined, sessionId: "sess-1", sourceRemoteServerId: null })).toBeUndefined();
    expect(await mintCrossRemoteMcpConfig({ storage }, { userId: "", sessionId: "sess-1", sourceRemoteServerId: null })).toBeUndefined();
  });

  it("returns undefined when the user has no opted-in remote other than the source", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const a = await storage.remoteServers.create({ name: "a", url: "http://a:5173" }, "user-1");
    await storage.remoteServers.update(a.id, { cross_remote_access: "exec" }, "user-1");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: a.id },
    );
    expect(config).toBeUndefined();
  });

  it("mints a verifiable token when a target exists", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com/";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    await storage.remoteServers.update(b.id, { cross_remote_access: "read" }, "user-1");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: "srv-a" },
    );
    expect(config?.url).toBe("https://app.example.com/api/cross-remote-mcp");

    const secret = await getCrossRemoteSecret(storage);
    expect(verifyCrossRemoteToken(secret, config!.token, Date.now())).toEqual({
      userId: "user-1",
      sessionId: "sess-1",
      sourceRemoteServerId: "srv-a",
    });
  });

  it("ignores another user's opted-in remotes", async () => {
    process.env.VIBEDECKX_PUBLIC_URL = "https://app.example.com";
    const b = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-2");
    await storage.remoteServers.update(b.id, { cross_remote_access: "exec" }, "user-2");

    const config = await mintCrossRemoteMcpConfig(
      { storage },
      { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null },
    );
    expect(config).toBeUndefined();
  });

  it("builds an --mcp-config blob with the bearer header", () => {
    const arg = buildMcpConfigArg({ url: "https://app.example.com/api/cross-remote-mcp", token: "tok" });
    expect(JSON.parse(arg)).toEqual({
      mcpServers: {
        "cross-remote": {
          type: "http",
          url: "https://app.example.com/api/cross-remote-mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
  });
});
