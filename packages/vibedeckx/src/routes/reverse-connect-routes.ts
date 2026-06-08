import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomBytes, createHash, verify as cryptoVerify } from "crypto";
import "../server-types.js";

// How long to wait for the remote to answer the machine-identity challenge
// before falling back to an unauthenticated (legacy) registration.
const MACHINE_HANDSHAKE_TIMEOUT_MS = 5000;

const routes: FastifyPluginAsync = async (fastify) => {
  // Must be registered after websocket plugin
  fastify.after(() => {
    // GET /api/reverse-connect?token=<token> — WebSocket upgrade for inbound remote nodes
    fastify.get<{ Querystring: { token?: string } }>(
      "/api/reverse-connect",
      { websocket: true },
      (socket, req) => {
        const token = (req.query as { token?: string }).token;
        if (!token) {
          socket.send(JSON.stringify({ error: "Token required" }));
          socket.close(4001, "Token required");
          return;
        }

        const server = fastify.storage.remoteServers.getByToken(token);
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
        const ownerId = fastify.storage.remoteServers.getOwnerId(serverId) ?? "";
        const nonce = randomBytes(32);
        let settled = false;

        const registerUnauthenticated = () => {
          if (settled) return;
          settled = true;
          socket.off("message", onChallengeReply);
          // Legacy / no-key remote: register without a machine identity. Recovery
          // falls back to exact server-ID matching with no aliasing (safe).
          fastify.reverseConnectManager.registerConnection(serverId, ws);
          fastify.storage.remoteServers.updateStatus(serverId, "online");
        };

        const timer = setTimeout(registerUnauthenticated, MACHINE_HANDSHAKE_TIMEOUT_MS);

        function onChallengeReply(data: import("ws").RawData) {
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

          const fingerprint = createHash("sha256").update(publicKey).digest("hex");
          const existing = fastify.storage.machineIdentity.get(fingerprint);

          // Cross-tenant guard: a machine already pinned to another owner cannot
          // be re-claimed under a different token's owner.
          if (existing && existing.user_id !== ownerId) {
            console.warn(`[ReverseConnect] Machine ${fingerprint.slice(0, 12)} owner mismatch — rejecting ${serverId}`);
            socket.close(4003, "Machine owner mismatch");
            return;
          }

          // Prove private-key possession over the fresh nonce.
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

          // First connect: pin fingerprint→(publicKey, owner). The token, which
          // determines the owner, bootstraps trust (TOFU).
          if (!existing) {
            fastify.storage.machineIdentity.pin(fingerprint, publicKey, ownerId);
            console.log(`[ReverseConnect] Pinned new machine identity ${fingerprint.slice(0, 12)} for ${serverId}`);
          }
          fastify.storage.machineIdentity.touch(fingerprint);

          fastify.reverseConnectManager.registerConnection(serverId, ws, fingerprint);
          fastify.storage.remoteServers.updateStatus(serverId, "online");
        }

        socket.on("message", onChallengeReply);
        socket.send(JSON.stringify({ type: "machine_challenge", nonce: nonce.toString("base64") }));
      }
    );
  });
};

export default fp(routes, { name: "reverse-connect-routes" });
