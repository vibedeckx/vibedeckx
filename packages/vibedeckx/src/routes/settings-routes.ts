import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import "../server-types.js";

const DEFAULT_PROXY_CONFIG: ProxyConfig = { type: "none", host: "", port: 0 };

const routes: FastifyPluginAsync = async (fastify) => {
  // Get proxy settings
  fastify.get("/api/settings/proxy", async (_req, reply) => {
    const saved = fastify.storage.settings.get("proxy");
    if (!saved) {
      return reply.code(200).send(DEFAULT_PROXY_CONFIG);
    }
    try {
      const config = JSON.parse(saved) as ProxyConfig;
      return reply.code(200).send(config);
    } catch {
      return reply.code(200).send(DEFAULT_PROXY_CONFIG);
    }
  });

  // Update proxy settings
  fastify.put<{
    Body: ProxyConfig;
  }>("/api/settings/proxy", async (req, reply) => {
    const { type, host, port } = req.body;

    if (!type || !["none", "http", "socks5"].includes(type)) {
      return reply.code(400).send({ error: "type must be 'none', 'http', or 'socks5'" });
    }

    if (type !== "none") {
      if (!host || typeof host !== "string" || host.trim() === "") {
        return reply.code(400).send({ error: "host is required when proxy is enabled" });
      }
      if (!port || typeof port !== "number" || port < 1 || port > 65535) {
        return reply.code(400).send({ error: "port must be a number between 1 and 65535" });
      }
    }

    const config: ProxyConfig = {
      type,
      host: type === "none" ? "" : host.trim(),
      port: type === "none" ? 0 : port,
    };

    fastify.storage.settings.set("proxy", JSON.stringify(config));
    fastify.proxyManager.updateConfig(config);

    console.log(`[Settings] Proxy updated: ${config.type}${config.type !== "none" ? ` ${config.host}:${config.port}` : ""}`);

    return reply.code(200).send(config);
  });

  // Test proxy connection
  fastify.post<{
    Body: ProxyConfig;
  }>("/api/settings/proxy/test", async (req, reply) => {
    const { type, host, port } = req.body;

    if (!type || !["none", "http", "socks5"].includes(type)) {
      return reply.code(400).send({ error: "type must be 'none', 'http', or 'socks5'" });
    }

    if (type === "none") {
      return reply.code(200).send({ success: true, message: "Direct connection (no proxy)" });
    }

    if (!host || !port) {
      return reply.code(400).send({ error: "host and port are required" });
    }

    try {
      // Create a temporary proxy manager to test the connection
      const { ProxyManager: PM } = await import("../utils/proxy-manager.js");
      const testPm = new PM();
      testPm.updateConfig({ type, host, port });

      const dispatcher = testPm.getFetchDispatcher();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
          signal: controller.signal,
        };
        if (dispatcher) {
          fetchOptions.dispatcher = dispatcher;
        }
        const response = await fetch("https://httpbin.org/get", fetchOptions as RequestInit);
        clearTimeout(timer);

        if (response.ok) {
          return reply.code(200).send({ success: true, message: `Proxy connection successful (status ${response.status})` });
        } else {
          return reply.code(200).send({ success: false, message: `Proxy returned status ${response.status}` });
        }
      } catch (fetchError) {
        clearTimeout(timer);
        const msg = fetchError instanceof Error ? fetchError.message : "Connection failed";
        return reply.code(200).send({ success: false, message: `Proxy connection failed: ${msg}` });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return reply.code(200).send({ success: false, message: `Failed to create proxy: ${msg}` });
    }
  });
};

export default fp(routes, { name: "settings-routes" });
