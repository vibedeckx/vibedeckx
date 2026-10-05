import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Mutable Clerk identity: each test sets currentUserId to impersonate a user.
const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

const downlink = vi.hoisted(() => ({ push: vi.fn(async () => [] as unknown[]) }));
vi.mock("../agent-process-downlink.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-process-downlink.js")>()),
  pushAgentProcessSettingsToWorkers: downlink.push,
}));

import settingsRoutes from "./settings-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

describe("settings routes: per-user scoping", () => {
  let dir: string;
  let storage: Storage;
  let app: FastifyInstance;

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-settings-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(settingsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("terminal settings are isolated per user; unset user gets defaults", async () => {
    auth.currentUserId = "user-1";
    const put = await app.inject({ method: "PUT", url: "/api/settings/terminal", payload: { fontSize: 20 } });
    expect(put.statusCode).toBe(200);

    const getA = await app.inject({ method: "GET", url: "/api/settings/terminal" });
    expect(getA.json().fontSize).toBe(20);

    auth.currentUserId = "user-2";
    const getB = await app.inject({ method: "GET", url: "/api/settings/terminal" });
    expect(getB.json().fontSize).toBe(13); // default, not user-1's value
  });

  it("conversation settings are isolated per user", async () => {
    auth.currentUserId = "user-1";
    await app.inject({ method: "PUT", url: "/api/settings/conversation", payload: { chatFontSize: 18 } });

    auth.currentUserId = "user-2";
    const getB = await app.inject({ method: "GET", url: "/api/settings/conversation" });
    expect(getB.json().chatFontSize).toBe(15); // default
  });

  it("tasksFontSize persists, keeps other fields, and rejects out-of-range values", async () => {
    await app.inject({ method: "PUT", url: "/api/settings/conversation", payload: { chatFontSize: 18 } });
    const put = await app.inject({ method: "PUT", url: "/api/settings/conversation", payload: { tasksFontSize: 16 } });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/settings/conversation" });
    expect(get.json()).toMatchObject({ tasksFontSize: 16, chatFontSize: 18 });

    const bad = await app.inject({ method: "PUT", url: "/api/settings/conversation", payload: { tasksFontSize: 40 } });
    expect(bad.statusCode).toBe(400);
  });

  it("chat-provider API keys never leak across users", async () => {
    auth.currentUserId = "user-1";
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/chat-provider",
      payload: { apiKeys: { deepseek: "sk-user1-secret" } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().apiKeys.deepseek).toBe("****cret");

    auth.currentUserId = "user-2";
    const getB = await app.inject({ method: "GET", url: "/api/settings/chat-provider" });
    expect(getB.json().apiKeys.deepseek).toBe(""); // not even a mask of user-1's key

    // And user-1 still sees their own.
    auth.currentUserId = "user-1";
    const getA = await app.inject({ method: "GET", url: "/api/settings/chat-provider" });
    expect(getA.json().apiKeys.deepseek).toBe("****cret");
  });

  it("no-auth solo mode persists under the 'local' user", async () => {
    // Rebuild the app with auth disabled — requireAuth returns undefined.
    await app.close();
    app = Fastify();
    app.decorate("authEnabled", false);
    app.decorate("storage", storage);
    await app.register(settingsRoutes);
    await app.ready();

    const put = await app.inject({ method: "PUT", url: "/api/settings/terminal", payload: { fontSize: 22 } });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings/terminal" });
    expect(get.json().fontSize).toBe(22);
    expect(await storage.userSettings.get("local", "terminal")).toBeDefined();
  });
});

describe("settings routes: agent-process limit downlink", () => {
  let dir: string;
  let storage: Storage;

  async function makeApp(isReverseConnectWorker: boolean): Promise<FastifyInstance> {
    const app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("isReverseConnectWorker", isReverseConnectWorker);
    app.decorate("storage", storage);
    await app.register(settingsRoutes);
    await app.ready();
    return app;
  }

  const put = (app: FastifyInstance, n: number) =>
    app.inject({ method: "PUT", url: "/api/settings/agent-processes", payload: { maxResidentAgentProcesses: n } });
  const get = (app: FastifyInstance) => app.inject({ method: "GET", url: "/api/settings/agent-processes" });

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    downlink.push.mockReset();
    downlink.push.mockResolvedValue([{ remoteServerId: "r1", name: "worker3", status: "applied" }]);
    dir = mkdtempSync(path.join(tmpdir(), "vdx-settings-downlink-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a hub saves the limit per user and pushes it to that user's workers only", async () => {
    const app = await makeApp(false);
    const res = await put(app, 5);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      maxResidentAgentProcesses: 5,
      workers: [{ remoteServerId: "r1", name: "worker3", status: "applied" }],
    });
    expect(downlink.push).toHaveBeenCalledWith(expect.anything(), "user-1", { maxResidentAgentProcesses: 5 });
    expect(await storage.userSettings.get("user-1", "agentProcesses")).toBe(JSON.stringify({ maxResidentAgentProcesses: 5 }));
    expect(await storage.settings.get("agentProcesses")).toBeUndefined();

    expect((await get(app)).json()).toEqual({ maxResidentAgentProcesses: 5 });
    auth.currentUserId = "user-2";
    expect((await get(app)).json()).toEqual({ maxResidentAgentProcesses: 3 });
    await app.close();
  });

  it("a hub user without their own value sees the legacy machine-wide one", async () => {
    await storage.settings.set("agentProcesses", JSON.stringify({ maxResidentAgentProcesses: 7 }));
    const app = await makeApp(false);
    expect((await get(app)).json()).toEqual({ maxResidentAgentProcesses: 7 });
    await put(app, 4);
    expect((await get(app)).json()).toEqual({ maxResidentAgentProcesses: 4 });
    await app.close();
  });

  it("a reverse-connect worker stores the pushed limit machine-wide without pushing onward", async () => {
    const app = await makeApp(true);
    const res = await put(app, 5);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ maxResidentAgentProcesses: 5 });
    expect(downlink.push).not.toHaveBeenCalled();
    expect(await storage.settings.get("agentProcesses")).toBe(JSON.stringify({ maxResidentAgentProcesses: 5 }));
    expect((await get(app)).json()).toEqual({ maxResidentAgentProcesses: 5 });
    await app.close();
  });
});
