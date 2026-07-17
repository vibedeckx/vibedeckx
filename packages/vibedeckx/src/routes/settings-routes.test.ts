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
