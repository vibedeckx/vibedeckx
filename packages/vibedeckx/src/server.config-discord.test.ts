import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * server.ts reads env at module load, and the /api/config handler reads
 * process.env.VIBEDECKX_DISCORD_URL per request. We build a fresh server with
 * the var set, assert the field is surfaced, then clear it and assert it drops.
 */
describe("/api/config discordInviteUrl", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-discord-"));
    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    delete process.env.VIBEDECKX_DISCORD_URL;
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the URL when VIBEDECKX_DISCORD_URL is set", async () => {
    process.env.VIBEDECKX_DISCORD_URL = "https://discord.gg/testinvite";
    const res = await fetch(`${baseUrl}/api/config`);
    const body = (await res.json()) as { discordInviteUrl?: string };
    expect(body.discordInviteUrl).toBe("https://discord.gg/testinvite");
  });

  it("omits the URL when VIBEDECKX_DISCORD_URL is unset", async () => {
    delete process.env.VIBEDECKX_DISCORD_URL;
    const res = await fetch(`${baseUrl}/api/config`);
    const body = (await res.json()) as { discordInviteUrl?: string };
    expect(body.discordInviteUrl).toBeUndefined();
  });
});
