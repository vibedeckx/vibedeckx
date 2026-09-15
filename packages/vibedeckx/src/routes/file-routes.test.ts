import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Stand in for Clerk: every request is user "u1". Solo mode (authEnabled=false)
// never reaches this — requireAuth short-circuits to undefined there.
vi.mock("../server.js", () => ({ requireAuth: () => "u1" }));

import fileRoutes from "./file-routes.js";

// Fixture: a "project" directory with one tracked file, and a sibling file
// OUTSIDE it — the agent's `/tmp/screenshot.png` stand-in.
let root: string;
let projectDir: string;
let outsideFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vdx-file-routes-"));
  projectDir = path.join(root, "project");
  await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "src", "index.ts"), "export const x = 1;\n");
  outsideFile = path.join(root, "artifact.txt");
  await fs.writeFile(outsideFile, "hello from outside\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeApp(opts: { authEnabled: boolean }): FastifyInstance {
  const app = Fastify();
  app.decorate("authEnabled", opts.authEnabled);
  app.decorate("storage", {
    projects: { getById: async () => ({ id: "p1", path: projectDir }) },
    projectRemotes: { getByProject: async () => [] },
  });
  app.register(fileRoutes);
  return app;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe("worker-side /api/path/file-content", () => {
  it("still serves repo-relative files and confines them to the checkout", async () => {
    app = makeApp({ authEnabled: false });
    const ok = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=src/index.ts`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ binary: false, content: "export const x = 1;\n" });

    const traversal = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=../artifact.txt`,
    });
    expect(traversal.statusCode).toBe(403);
  });

  it("serves an absolute path outside the checkout (the agent's temp artifact)", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ binary: false, content: "hello from outside\n" });
  });

  it("downloads an absolute path outside the checkout", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/path/file-download?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="artifact.txt"');
    expect(res.body).toBe("hello from outside\n");
  });

  it("404s a missing or non-file absolute path instead of leaking a stack", async () => {
    app = makeApp({ authEnabled: false });
    const missing = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(path.join(root, "nope.png"))}`,
    });
    expect(missing.statusCode).toBe(404);
    const dir = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(root)}`,
    });
    expect(dir.statusCode).toBe(404);
  });
});

describe("list-files", () => {
  it("reports the checkout root alongside the file list", async () => {
    app = makeApp({ authEnabled: false });
    const worker = await app.inject({
      method: "GET",
      url: `/api/path/list-files?path=${encodeURIComponent(projectDir)}`,
    });
    expect(worker.statusCode).toBe(200);
    expect(worker.json()).toMatchObject({ files: ["src/index.ts"], root: projectDir });
    const hub = await app.inject({ method: "GET", url: "/api/projects/p1/list-files" });
    expect(hub.json()).toMatchObject({ root: projectDir });
  });
});

describe("hub-side /api/projects/:id/file-content (local checkout)", () => {
  it("follows absolute paths in solo mode — the operator's own machine", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "hello from outside\n" });
  });

  it("keeps local checkouts confined on a multi-tenant (auth) hub", async () => {
    app = makeApp({ authEnabled: true });
    const outside = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=${encodeURIComponent(outsideFile)}`,
    });
    expect(outside.statusCode).toBe(403);
    const inside = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=src/index.ts`,
    });
    expect(inside.statusCode).toBe(200);
  });
});
