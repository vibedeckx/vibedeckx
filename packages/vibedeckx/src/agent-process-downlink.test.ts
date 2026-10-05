import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const proxy = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./utils/remote-proxy.js", () => ({ proxyToRemoteAuto: proxy.call }));

import { pushAgentProcessSettingsToWorkers } from "./agent-process-downlink.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";

/**
 * The resident limit is per user on a hub: a user's save reaches only their own
 * workers, and each project is held to its owner's limit. A worker belongs to
 * one user and enforces only the machine-wide value the hub pushed to it.
 */

let dir: string;
let storage: Storage;

beforeEach(async () => {
  proxy.call.mockReset();
  proxy.call.mockResolvedValue({ ok: true, status: 200 });
  dir = mkdtempSync(path.join(tmpdir(), "vdx-agent-process-downlink-"));
  storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
});

afterEach(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const limit = (n: number) => JSON.stringify({ maxResidentAgentProcesses: n });

/** `getMaxResidentAgentProcesses` is private; reach it the way ensureResidentCapacity does. */
function maxFor(manager: AgentSessionManager, projectId: string): Promise<number> {
  return (manager as unknown as { getMaxResidentAgentProcesses(id: string): Promise<number> })
    .getMaxResidentAgentProcesses(projectId);
}

describe("pushAgentProcessSettingsToWorkers", () => {
  it("sends a user's limit to that user's remote servers only", async () => {
    const a1 = await storage.remoteServers.create({ name: "a-worker-1" }, "user-a");
    const a2 = await storage.remoteServers.create({ name: "a-worker-2" }, "user-a");
    await storage.remoteServers.create({ name: "b-worker" }, "user-b");

    const results = await pushAgentProcessSettingsToWorkers(
      { storage, reverseConnectManager: {} as ReverseConnectManager },
      "user-a",
      { maxResidentAgentProcesses: 5 },
    );

    const targets = proxy.call.mock.calls.map((call) => call[0]).sort();
    expect(targets).toEqual([a1.id, a2.id].sort());
    for (const call of proxy.call.mock.calls) {
      expect(call.slice(1, 4)).toEqual(["PUT", "/api/settings/agent-processes", { maxResidentAgentProcesses: 5 }]);
    }
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });

  it("reports no tunnel as offline, and a live-tunnel failure as an error to retry", async () => {
    await storage.remoteServers.create({ name: "down" }, "user-a");
    await storage.remoteServers.create({ name: "slow" }, "user-a");
    await storage.remoteServers.create({ name: "broken" }, "user-a");
    proxy.call.mockImplementation(async (id: string) => {
      const server = await storage.remoteServers.getById(id);
      if (server?.name === "down") return { ok: false, status: 0, errorCode: "network_error" };
      if (server?.name === "slow") return { ok: false, status: 0, errorCode: "timeout" };
      return { ok: false, status: 500, errorCode: "server_error" };
    });

    const results = await pushAgentProcessSettingsToWorkers(
      { storage, reverseConnectManager: {} as ReverseConnectManager },
      "user-a",
      { maxResidentAgentProcesses: 5 },
    );

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.down).toMatchObject({ status: "offline" });
    expect(byName.slow).toMatchObject({ status: "error", detail: "timed out" });
    expect(byName.broken).toMatchObject({ status: "error", detail: "worker responded 500" });
  });
});

describe("AgentSessionManager resident limit source", () => {
  it("on a hub, holds each project to its owner's limit", async () => {
    await storage.projects.create({ id: "pa", name: "a", path: "/tmp/pa" }, "user-a");
    await storage.projects.create({ id: "pb", name: "b", path: "/tmp/pb" }, "user-b");
    await storage.userSettings.set("user-a", "agentProcesses", limit(5));
    await storage.userSettings.set("user-b", "agentProcesses", limit(2));
    const manager = new AgentSessionManager(storage);

    expect(await maxFor(manager, "pa")).toBe(5);
    expect(await maxFor(manager, "pb")).toBe(2);
  });

  it("on a hub, an owner with no value falls back to the legacy machine-wide one, then the default", async () => {
    await storage.projects.create({ id: "pa", name: "a", path: "/tmp/pa" }, "user-a");
    const manager = new AgentSessionManager(storage);

    expect(await maxFor(manager, "pa")).toBe(3);
    await storage.settings.set("agentProcesses", limit(7));
    expect(await maxFor(manager, "pa")).toBe(7);
  });

  it("on a worker, ignores user_settings and enforces the pushed machine-wide value", async () => {
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p1" });
    await storage.userSettings.set("local", "agentProcesses", limit(9));
    await storage.settings.set("agentProcesses", limit(5));
    const manager = new AgentSessionManager(storage);
    manager.residentLimitIsMachineWide = true;

    expect(await maxFor(manager, "p1")).toBe(5);
  });
});
