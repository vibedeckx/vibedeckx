import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomBytes, createHash, verify as cryptoVerify } from "crypto";
import "../server-types.js";

// How long to wait for the remote to answer the machine-identity challenge
// before falling back to an unauthenticated (legacy) registration.
const MACHINE_HANDSHAKE_TIMEOUT_MS = 5000;

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/reverse-connect/identity — pre-connect preflight. Resolves which
  // remote record a connect token belongs to so a worker can detect "wrong
  // token for this machine" BEFORE opening the WS: connecting first would
  // kick the legitimate worker (last-writer-wins in registerConnection) and
  // the recovery hook that fires on `online` can plant a server alias.
  // Authenticates itself via the connect-token header — server.ts exempts
  // this exact path from the API-key and Clerk middlewares, mirroring the
  // token-authenticated WS upgrade below. Workers discover the endpoint via
  // the `reverseConnectIdentity` capability flag on public /api/config.
  fastify.get("/api/reverse-connect/identity", async (req, reply) => {
    const token = req.headers["x-vibedeckx-connect-token"];
    if (typeof token !== "string" || token.length === 0) {
      return reply.code(401).send({ error: "Connect token required" });
    }
    const server = await fastify.storage.remoteServers.getByToken(token);
    if (!server) {
      return reply.code(401).send({ error: "Invalid token" });
    }
    if (server.connection_mode !== "inbound") {
      return reply.code(403).send({ error: "Server is not configured for inbound connections" });
    }
    return { serverId: server.id, name: server.name };
  });

  // Must be registered after websocket plugin
  fastify.after(() => {
    // GET /api/reverse-connect?token=<token> — WebSocket upgrade for inbound remote nodes
    fastify.get<{ Querystring: { token?: string } }>(
      "/api/reverse-connect",
      { websocket: true },
      async (socket, req) => {
        const token = (req.query as { token?: string }).token;
        if (!token) {
          socket.send(JSON.stringify({ error: "Token required" }));
          socket.close(4001, "Token required");
          return;
        }

        const server = await fastify.storage.remoteServers.getByToken(token);
        if (!server) {
          socket.send(JSON.stringify({ error: "Invalid token" }));
          socket.close(4001, "Invalid token");
          return;
        }

        if (server.connection_mode !== "inbound") {
          socket.send(JSON.stringify({ error: "Server is not configured for inbound connections" }));
          socket.close(4001, "Not inbound");
          return;
        }

        console.log(`[ReverseConnect] Inbound connection from remote server: ${server.name} (${server.id})`);

        const ws = socket as unknown as import("ws").default;
        const serverId = server.id;
        const ownerId = (await fastify.storage.remoteServers.getOwnerId(serverId)) ?? "";
        const nonce = randomBytes(32);
        let settled = false;

        const registerUnauthenticated = async () => {
          if (settled) return;
          settled = true;
          socket.off("message", onChallengeReply);
          // Legacy / no-key remote: register without a machine identity. Recovery
          // falls back to exact server-ID matching with no aliasing (safe).
          fastify.reverseConnectManager.registerConnection(serverId, ws);
          await fastify.storage.remoteServers.updateStatus(serverId, "online");
        };

        const timer = setTimeout(() => {
          registerUnauthenticated().catch((err) => {
            console.error(`[ReverseConnect] Failed to register unauthenticated connection for ${serverId}:`, err);
          });
        }, MACHINE_HANDSHAKE_TIMEOUT_MS);

        async function onChallengeReply(data: import("ws").RawData) {
          // Top-level guard: this async handler is registered on a raw ws
          // "message" event (the emitter ignores the returned promise), so a
          // rejection from any awaited storage call below would otherwise
          // become an unhandled rejection and can kill the process.
          try {
            let frame: { type?: string; publicKey?: string; signature?: string };
            try {
              frame = JSON.parse(data.toString());
            } catch {
              return;
            }
            if (frame?.type !== "machine_auth" || settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off("message", onChallengeReply);

            const publicKey = frame.publicKey;
            const signature = frame.signature;
            if (!publicKey || !signature) {
              socket.close(4003, "Malformed machine auth");
              return;
            }

            // Prove private-key possession over the fresh nonce *before* touching
            // any machine-identity state — signature validity doesn't depend on
            // ownership, and we don't want to pin/verify against an unproven key.
            let valid = false;
            try {
              valid = cryptoVerify(null, nonce, publicKey, Buffer.from(signature, "base64"));
            } catch {
              valid = false;
            }
            if (!valid) {
              socket.close(4003, "Bad machine signature");
              return;
            }

            const fingerprint = createHash("sha256").update(publicKey).digest("hex");
            // Atomic pin-if-absent (TOFU) + ownership verification, in one
            // storage call. Previously this was a get() (cross-tenant guard) then
            // a conditional pin() across two awaited storage calls — two
            // concurrent first-connects for the same fingerprint under two
            // different owners' tokens could both observe "unpinned" before
            // either pin() landed, letting both slip past the ownership guard.
            const { owned, created } = await fastify.storage.machineIdentity.claimOrVerify(fingerprint, publicKey, ownerId);
            if (!owned) {
              console.warn(`[ReverseConnect] Machine ${fingerprint.slice(0, 12)} owner mismatch — rejecting ${serverId}`);
              socket.close(4003, "Machine owner mismatch");
              return;
            }
            if (created) {
              console.log(`[ReverseConnect] Pinned new machine identity ${fingerprint.slice(0, 12)} for ${serverId}`);
            }

            console.log(`[ReverseConnect] Machine auth verified ${fingerprint.slice(0, 12)} for ${serverId}`);
            fastify.reverseConnectManager.registerConnection(serverId, ws, fingerprint);
            await fastify.storage.remoteServers.updateStatus(serverId, "online");
          } catch (err) {
            console.error(`[ReverseConnect] Machine challenge handling failed for ${serverId}:`, err);
            try { socket.close(4003, "Machine auth error"); } catch { /* already closed */ }
          }
        }

        socket.on("message", onChallengeReply);
        socket.send(JSON.stringify({ type: "machine_challenge", nonce: nonce.toString("base64") }));
      }
    );
  });
};

export default fp(routes, { name: "reverse-connect-routes" });
