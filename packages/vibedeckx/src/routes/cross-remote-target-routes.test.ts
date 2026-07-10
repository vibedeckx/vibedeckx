import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import crossRemoteTargetRoutes from "./cross-remote-target-routes.js";

describe("cross-remote target routes", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-target-"));
    writeFileSync(path.join(dir, "hello.txt"), "hello world");
    mkdirSync(path.join(dir, "sub"));
    app = Fastify();
    await app.register(crossRemoteTargetRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

  it("exec runs a command", async () => {
    const res = await post("/api/path/cross-remote/exec", { command: "echo hi", cwd: dir });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout.trim()).toBe("hi");
    expect(res.json().exitCode).toBe(0);
  });

  it("exec rejects a missing command", async () => {
    const res = await post("/api/path/cross-remote/exec", { cwd: dir });
    expect(res.statusCode).toBe(400);
  });

  it("exec clamps an oversized timeout", async () => {
    const res = await post("/api/path/cross-remote/exec", { command: "echo hi", timeoutSec: 99999 });
    expect(res.statusCode).toBe(200);
  });

  it("read-file returns contents", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "hello.txt") });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("hello world");
    expect(res.json().truncated).toBe(false);
  });

  it("read-file honours offset and limit", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "hello.txt"), offset: 6, limit: 5 });
    expect(res.json().content).toBe("world");
  });

  it("read-file 404s on a missing file", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: path.join(dir, "nope.txt") });
    expect(res.statusCode).toBe(404);
  });

  it("read-file rejects a relative path", async () => {
    const res = await post("/api/path/cross-remote/read-file", { path: "relative/x.txt" });
    expect(res.statusCode).toBe(400);
  });

  it("list-dir lists entries with types", async () => {
    const res = await post("/api/path/cross-remote/list-dir", { path: dir });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{ name: string; type: string }>;
    expect(entries).toContainEqual({ name: "hello.txt", type: "file" });
    expect(entries).toContainEqual({ name: "sub", type: "dir" });
  });

  it("stat reports a file", async () => {
    const res = await post("/api/path/cross-remote/stat", { path: path.join(dir, "hello.txt") });
    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe("file");
    expect(res.json().size).toBe(11);
  });

  it("process-list returns output", async () => {
    const res = await post("/api/path/cross-remote/process-list", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout.length).toBeGreaterThan(0);
  });
});
