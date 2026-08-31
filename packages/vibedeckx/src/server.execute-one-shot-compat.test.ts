import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * `POST /api/execute-one-shot` is a worker-side compatibility shim: Sync Up/Down
 * was removed, so no code in this repo calls it any more. It stays because hubs
 * hand users `npx vibedeckx@latest connect` (remote-server-routes.ts), which
 * points a hub predating that removal at a newer worker — deleting the route
 * would 404 their Sync buttons.
 *
 * Nothing else guards it: it has no caller to keep it honest, and it is
 * deliberately absent from reverse-connect-capabilities.ts (that registry
 * tracks routes *this* hub calls, and its test rejects entries without a live
 * call site). This test is the only thing standing between the shim and a
 * future "remove dead code" pass, so it pins both halves — the handler and the
 * REMOTE_PROVIDER_EXACT allowlist entry that exposes it in connect mode.
 */
describe("execute-one-shot compat shim (old hub → new worker)", () => {
  let dir: string;
  let workerUrl: string;
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-one-shot-"));
    const workerStorage = await createSqliteStorage(path.join(dir, "worker.sqlite"));
    const serverStorage = await createSqliteStorage(path.join(dir, "server.sqlite"));

    // acceptRemote: true is what `vibedeckx connect` sets — the worker half.
    const worker = await createServer({ storage: workerStorage, uiRoot: null, acceptRemote: true });
    const server = await createServer({ storage: serverStorage, uiRoot: null });
    workerUrl = (await worker.startLocal(0)).url;
    serverUrl = (await server.startLocal(0)).url;

    close = async () => {
      await worker.close();
      await server.close();
      await workerStorage.close();
      await serverStorage.close();
    };
  }, 30_000);

  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (base: string) =>
    fetch(`${base}/api/execute-one-shot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo shim-ok", cwd: dir }),
    });

  it("runs the command for an old hub when acceptRemote is on", async () => {
    const res = await post(workerUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout.trim()).toBe("shim-ok");
  });

  it("stays invisible on a normal server (no acceptRemote)", async () => {
    const res = await post(serverUrl);
    expect(res.status).toBe(404);
  });
});
