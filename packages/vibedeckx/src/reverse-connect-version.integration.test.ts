import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { createServer } from "./server.js";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";

/**
 * Worker version reporting through the reverse-connect handshake
 * (docs/server-worker-compat-design.md §2 Phase 1). Covers both carriers:
 * machine_auth (the reliable one) and a status frame stashed before the
 * legacy no-machine-auth registration.
 */
describe("reverse-connect worker version reporting", () => {
  let baseUrl: string;
  let storage: Storage;
  let close: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-wv-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url.replace(/^http/, "ws");
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function newWorkerRecord(name: string): Promise<{ id: string; token: string }> {
    const record = await storage.remoteServers.create({ name });
    const token = (await storage.remoteServers.generateToken(record.id))!;
    return { id: record.id, token };
  }

  async function pollUntil<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("pollUntil timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("persists version and capabilities carried on machine_auth", async () => {
    const { id, token } = await newWorkerRecord("versioned-worker");
    expect((await storage.remoteServers.getById(id))!.worker_version).toBeUndefined();

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const ws = new WebSocket(`${baseUrl}/api/reverse-connect?token=${encodeURIComponent(token)}`);
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type?: string; nonce?: string };
      if (frame.type !== "machine_challenge") return;
      ws.send(JSON.stringify({
        type: "machine_auth",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        signature: cryptoSign(null, Buffer.from(frame.nonce!, "base64"), privateKey).toString("base64"),
        version: "9.9.9",
        capabilities: ["http:GET /api/agent-sessions/:param"],
      }));
    });

    try {
      const row = await pollUntil(async () => {
        const server = await storage.remoteServers.getById(id);
        return server?.worker_version !== undefined ? server : undefined;
      }, 5000);
      expect(row.worker_version).toBe("9.9.9");
      expect(row.worker_capabilities).toEqual(["http:GET /api/agent-sessions/:param"]);
      expect(row.worker_version_reported_at).toBeTruthy();
      expect(row.status).toBe("online");
    } finally {
      ws.close();
    }
  }, 15_000);

  it("falls back to a stashed status-frame version when machine auth never completes", async () => {
    const { id, token } = await newWorkerRecord("legacy-worker");

    const ws = new WebSocket(`${baseUrl}/api/reverse-connect?token=${encodeURIComponent(token)}`);
    // Send after the challenge arrives — proves the hub's handshake listener
    // is attached, mirroring a worker that reports status but can't sign.
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type?: string };
      if (frame.type !== "machine_challenge") return;
      ws.send(JSON.stringify({ type: "status", ready: true, version: "8.8.8", capabilities: [] }));
    });

    try {
      // Registration happens after the 5s MACHINE_HANDSHAKE_TIMEOUT_MS.
      const row = await pollUntil(async () => {
        const server = await storage.remoteServers.getById(id);
        return server?.worker_version !== undefined ? server : undefined;
      }, 10_000);
      expect(row.worker_version).toBe("8.8.8");
      expect(row.worker_capabilities).toEqual([]);
      expect(row.status).toBe("online");
    } finally {
      ws.close();
    }
  }, 20_000);
});
