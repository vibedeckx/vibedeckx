import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, sign } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import reverseConnectRoutes from "./reverse-connect-routes.js";
import { CONNECT_IDENTITY_HEADER } from "../connect-preflight.js";

describe("GET /api/reverse-connect/identity", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let dbPath: string;
  let inboundId: string;
  let inboundToken: string;
  const registerConnection = vi.fn();

  async function buildApp() {
    const instance = Fastify();
    instance.decorate("storage", storage);
    instance.decorate("reverseConnectManager", { registerConnection } as never);
    await instance.register(fastifyWebsocket);
    await instance.register(reverseConnectRoutes);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-rci-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);

    const inbound = await storage.remoteServers.create({ name: "worker-a" });
    inboundId = inbound.id;
    inboundToken = (await storage.remoteServers.generateToken(inbound.id))!;

    registerConnection.mockClear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (token?: string) =>
    app.inject({
      method: "GET",
      url: "/api/reverse-connect/identity",
      headers: token ? { [CONNECT_IDENTITY_HEADER]: token } : {},
    });

  it("401s without a token", async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/token required/i);
  });

  it("401s on an unknown token", async () => {
    const res = await get("no-such-token");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/invalid/i);
  });

  it("returns the record's id and name for a valid inbound token", async () => {
    const res = await get(inboundToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: inboundId, name: "worker-a" });
  });

  it("never leaks the token or api key in the response", async () => {
    const res = await get(inboundToken);
    expect(res.body).not.toContain(inboundToken);
    expect(res.json().connect_token).toBeUndefined();
    expect(res.json().api_key).toBeUndefined();
  });

  it("migrates a legacy local machine pin and accepts its signed reverse-connect claim", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(publicKeyPem).digest("hex");
    await storage.machineIdentity.pin(fingerprint, publicKeyPem, "legacy-placeholder");

    await app.close();
    await storage.close();
    const legacy = new Database(dbPath);
    legacy.prepare("UPDATE remote_servers SET user_id = '' WHERE id = ?").run(inboundId);
    legacy.prepare("UPDATE machine_identity SET user_id = '' WHERE machine_id = ?").run(fingerprint);
    legacy.close();

    // Two opens prove both the data backfill and schema migration are idempotent.
    storage = await createSqliteStorage(dbPath);
    await storage.close();
    storage = await createSqliteStorage(dbPath);
    app = await buildApp();

    expect((await storage.machineIdentity.get(fingerprint))?.user_id).toBe("local");
    expect(await storage.machineIdentity.claimOrVerify(fingerprint, publicKeyPem, "local"))
      .toMatchObject({ owned: true, ownerId: "local", created: false });
    expect(await storage.machineIdentity.claimOrVerify(fingerprint, publicKeyPem, "user-2"))
      .toMatchObject({ owned: false, ownerId: "local", created: false });

    let resolveChallenge!: (frame: { nonce: string }) => void;
    const challenge = new Promise<{ nonce: string }>((resolve) => { resolveChallenge = resolve; });
    const socket = await app.injectWS(
      `/api/reverse-connect?token=${encodeURIComponent(inboundToken)}`,
      {},
      { onInit: (ws) => ws.on("message", (data) => resolveChallenge(JSON.parse(data.toString()))) },
    );
    const { nonce } = await challenge;
    socket.send(JSON.stringify({
      type: "machine_auth",
      publicKey: publicKeyPem,
      signature: sign(null, Buffer.from(nonce, "base64"), privateKey).toString("base64"),
    }));
    await vi.waitFor(() => expect(registerConnection).toHaveBeenCalledWith(
      inboundId, expect.anything(), fingerprint,
    ));
    socket.close();

    const schema = new Database(dbPath, { readonly: true });
    const userColumn = schema.prepare("PRAGMA table_info(machine_identity)").all()
      .find((column) => (column as { name: string }).name === "user_id") as { dflt_value: string };
    schema.close();
    expect(userColumn.dflt_value).toBe("'local'");
  });
});
