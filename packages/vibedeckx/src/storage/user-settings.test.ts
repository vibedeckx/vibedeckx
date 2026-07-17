import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("user settings storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-usersettings-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("get/set round-trips and upserts, scoped per user", async () => {
    expect(await storage.userSettings.get("user-a", "terminal")).toBeUndefined();
    await storage.userSettings.set("user-a", "terminal", "v1");
    await storage.userSettings.set("user-a", "terminal", "v2"); // upsert
    expect(await storage.userSettings.get("user-a", "terminal")).toBe("v2");
    // Same key, different user → isolated.
    expect(await storage.userSettings.get("user-b", "terminal")).toBeUndefined();
    await storage.userSettings.set("user-b", "terminal", "b-value");
    expect(await storage.userSettings.get("user-a", "terminal")).toBe("v2");
    expect(await storage.userSettings.get("user-b", "terminal")).toBe("b-value");
  });

  it("update merges via mergeFn against current value (undefined when unset)", async () => {
    const first = await storage.userSettings.update("user-a", "merge-key", (current) => {
      expect(current).toBeUndefined();
      return "v1";
    });
    expect(first).toBe("v1");
    const second = await storage.userSettings.update("user-a", "merge-key", (current) => `${current}-v2`);
    expect(second).toBe("v1-v2");
    expect(await storage.userSettings.get("user-a", "merge-key")).toBe("v1-v2");
    // Another user's update sees their own (unset) value, not user-a's.
    await storage.userSettings.update("user-b", "merge-key", (current) => {
      expect(current).toBeUndefined();
      return "b1";
    });
    expect(await storage.userSettings.get("user-a", "merge-key")).toBe("v1-v2");
  });

  it("update: a throwing mergeFn aborts without writing", async () => {
    await storage.userSettings.set("user-a", "k", "orig");
    await expect(
      storage.userSettings.update("user-a", "k", () => {
        throw new Error("validation failed");
      }),
    ).rejects.toThrow("validation failed");
    expect(await storage.userSettings.get("user-a", "k")).toBe("orig");
  });

  it("update: two concurrent read-modify-writes both land (no lost update)", async () => {
    await storage.userSettings.set("user-a", "concurrent-key", JSON.stringify({ markers: [] as string[] }));
    const appendMarker = (marker: string) => (current: string | undefined) => {
      const parsed = JSON.parse(current!) as { markers: string[] };
      parsed.markers.push(marker);
      return JSON.stringify(parsed);
    };
    await Promise.all([
      storage.userSettings.update("user-a", "concurrent-key", appendMarker("A")),
      storage.userSettings.update("user-a", "concurrent-key", appendMarker("B")),
    ]);
    const final = JSON.parse((await storage.userSettings.get("user-a", "concurrent-key"))!) as { markers: string[] };
    expect(final.markers.sort()).toEqual(["A", "B"]);
  });

  it("migrates legacy global user-level keys to the 'local' user on open", async () => {
    // Simulate a pre-user-settings database: user-level values living in
    // global_settings (written via the old API), plus a server-level key
    // that must NOT migrate.
    await storage.settings.set("terminal", '{"fontSize":20}');
    await storage.settings.set("conversation", '{"chatFontSize":18}');
    await storage.settings.set("chat_provider", '{"apiKeys":{"deepseek":"sk-old"}}');
    await storage.settings.set("proxy", '{"type":"none"}');
    // Force re-migration: delete the already-migrated (empty) state by reopening.
    await storage.close();
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));

    expect(await storage.userSettings.get("local", "terminal")).toBe('{"fontSize":20}');
    expect(await storage.userSettings.get("local", "conversation")).toBe('{"chatFontSize":18}');
    expect(await storage.userSettings.get("local", "chat_provider")).toBe('{"apiKeys":{"deepseek":"sk-old"}}');
    // Migrated rows are removed from global_settings (no stale secrets).
    expect(await storage.settings.get("terminal")).toBeUndefined();
    expect(await storage.settings.get("conversation")).toBeUndefined();
    expect(await storage.settings.get("chat_provider")).toBeUndefined();
    // Server-level key stays global.
    expect(await storage.settings.get("proxy")).toBe('{"type":"none"}');

    // Migration must not clobber an existing user_settings row on re-open.
    await storage.userSettings.set("local", "terminal", '{"fontSize":13}');
    await storage.settings.set("terminal", '{"fontSize":99}');
    await storage.close();
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    expect(await storage.userSettings.get("local", "terminal")).toBe('{"fontSize":13}');
  });
});
