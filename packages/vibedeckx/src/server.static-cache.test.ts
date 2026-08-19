import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { staticCacheControl } from "./server.js";

describe("staticCacheControl", () => {
  it("marks content-hashed Next assets immutable for a year", () => {
    expect(staticCacheControl("/ui/_next/static/chunks/0fa5a9fd7df38eed.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(staticCacheControl("C:\\ui\\_next\\static\\media\\font.woff2")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
  it("never lets the HTML entry point (which names the hashes) go stale", () => {
    expect(staticCacheControl("/ui/index.html")).toBe("no-cache");
    expect(staticCacheControl("/ui/404.html")).toBe("no-cache");
  });
  it("gives unhashed assets a short TTL", () => {
    expect(staticCacheControl("/ui/sounds/sound1.mp3")).toBe("public, max-age=86400");
    expect(staticCacheControl("/ui/favicon.ico")).toBe("public, max-age=86400");
  });
});

/**
 * End-to-end through @fastify/static: the plugin's own `send` Cache-Control
 * must be disabled (cacheControl:false) or it would overwrite ours — so assert
 * on real responses, including the SPA fallback that goes through sendFile().
 */
describe("bundled UI cache headers", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-static-"));
    const ui = path.join(dir, "ui");
    mkdirSync(path.join(ui, "_next", "static", "chunks"), { recursive: true });
    mkdirSync(path.join(ui, "sounds"), { recursive: true });
    writeFileSync(path.join(ui, "index.html"), "<html><body>ui</body></html>");
    writeFileSync(path.join(ui, "_next", "static", "chunks", "abc123.js"), "console.log(1)");
    writeFileSync(path.join(ui, "sounds", "ding.mp3"), "x");

    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const server = await createServer({ storage, uiRoot: ui });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hashed chunk → immutable", async () => {
    const res = await fetch(`${baseUrl}/_next/static/chunks/abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("index.html (direct and SPA fallback) → no-cache", async () => {
    const direct = await fetch(`${baseUrl}/index.html`);
    expect(direct.headers.get("cache-control")).toBe("no-cache");
    const spa = await fetch(`${baseUrl}/p/some-project/workspace`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("ui");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
  });

  it("unhashed asset → short TTL", async () => {
    const res = await fetch(`${baseUrl}/sounds/ding.mp3`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});
