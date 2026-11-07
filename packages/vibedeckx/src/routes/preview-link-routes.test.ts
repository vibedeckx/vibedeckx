import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { PreviewAuth } from "../preview/preview-auth.js";
import previewLinkRoutes, { PREVIEW_PROXY_CAPABILITY } from "./preview-link-routes.js";

/** docs/preview-links-design.md §Auth (mint half) */
describe("preview-link routes", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let boxId: string;
  let oldBoxId: string;

  const build = async (opts: { enabled: boolean; noLocalProjects?: boolean }) => {
    app = Fastify({ logger: false });
    app.decorate("authEnabled", false);
    app.decorate("noLocalProjects", opts.noLocalProjects ?? false);
    app.decorate("storage", storage);
    app.decorate("previewLinks", opts.enabled
      ? { config: { hostname: "preview.localhost", port: 5173, scheme: "http" as const }, auth: new PreviewAuth(async () => "s") }
      : null);
    await app.register(previewLinkRoutes);
    await app.ready();
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-preview-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "One", path: dir });
    await storage.projects.create({ id: "p2", name: "Two", path: dir }, "someone-else");
    const box = await storage.remoteServers.create({ name: "box" });
    boxId = box.id;
    await storage.remoteServers.updateWorkerVersion(boxId, "0.3.57", [PREVIEW_PROXY_CAPABILITY]);
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: boxId, remote_path: "/srv/one" });
    const oldBox = await storage.remoteServers.create({ name: "old-box" });
    oldBoxId = oldBox.id;
    await storage.remoteServers.updateWorkerVersion(oldBoxId, "0.3.50", ["http:GET /api/path/agent-sessions"]);
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: oldBoxId, remote_path: "/srv/one" });
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the feature off without a preview host, and refuses to mint", async () => {
    await build({ enabled: false });
    const list = await app.inject({ method: "GET", url: "/api/projects/p1/preview-links" });
    expect(list.json()).toEqual({ enabled: false, links: [] });
    const mint = await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: "local", port: 3000 } });
    expect(mint.statusCode).toBe(409);
    expect(mint.json().errorCode).toBe("preview-disabled");
  });

  it("mints a link with a one-time sign-in URL on the slug's own origin", async () => {
    await build({ enabled: true });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: boxId, port: 3000 } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.link).toMatchObject({ targetId: boxId, targetName: "box", port: 3000 });
    expect(body.link.url).toBe(`http://${body.link.slug}.preview.localhost:5173`);
    expect(body.authUrl).toMatch(new RegExp(`^http://${body.link.slug}\\.preview\\.localhost:5173/__vdx/auth\\?t=[A-Za-z0-9_-]+$`));

    // Same machine+port → same slug, fresh ticket.
    const again = await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: boxId, port: 3000 } });
    expect(again.json().link.slug).toBe(body.link.slug);
    expect(again.json().authUrl).not.toBe(body.authUrl);

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/preview-links" });
    expect(list.json().links.map((l: { slug: string }) => l.slug)).toEqual([body.link.slug]);

    const open = await app.inject({ method: "POST", url: `/api/preview-links/${body.link.slug}/open` });
    expect(open.statusCode).toBe(200);
    expect(open.json().authUrl).toContain("/__vdx/auth?t=");

    const del = await app.inject({ method: "DELETE", url: `/api/projects/p1/preview-links/${body.link.slug}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: `/api/preview-links/${body.link.slug}/open` })).statusCode).toBe(404);
  });

  it("refuses a worker that lacks the preview capability instead of degrading", async () => {
    await build({ enabled: true });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: oldBoxId, port: 3000 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe("worker-upgrade-required");
  });

  it("validates target and port, and keeps other tenants' projects invisible", async () => {
    await build({ enabled: true });
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: boxId, port: 70000 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: "not-linked", port: 3000 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/p2/preview-links" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/projects/p2/preview-links", payload: { targetId: "local", port: 3000 } })).statusCode).toBe(404);
  });

  it("allows the hub's own machine only where local projects exist", async () => {
    await build({ enabled: true, noLocalProjects: true });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/preview-links", payload: { targetId: "local", port: 3000 } });
    expect(res.statusCode).toBe(400);
  });
});
