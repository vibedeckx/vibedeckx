import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import { getChatProviderConfig, type ChatProviderConfig } from "../utils/chat-model.js";
import "../server-types.js";

const DEFAULT_PROXY_CONFIG: ProxyConfig = { type: "none", host: "", port: 0 };

export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
}

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 1000,
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
};

const SCROLLBACK_MIN = 500;
const SCROLLBACK_MAX = 100000;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

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

  // ---- Chat Provider Settings ----

  function maskApiKey(key: string): string {
    if (!key || key.length <= 4) return key ? "****" : "";
    return "****" + key.slice(-4);
  }

  fastify.get("/api/settings/chat-provider", async (_req, reply) => {
    const config = getChatProviderConfig(fastify.storage);
    return reply.code(200).send({
      provider: config.provider,
      deepseekApiKey: maskApiKey(config.deepseekApiKey),
      openrouterApiKey: maskApiKey(config.openrouterApiKey),
      openrouterModel: config.openrouterModel,
    });
  });

  fastify.put<{
    Body: Partial<ChatProviderConfig>;
  }>("/api/settings/chat-provider", async (req, reply) => {
    const { provider, deepseekApiKey, openrouterApiKey, openrouterModel } = req.body;

    if (provider && provider !== "deepseek" && provider !== "openrouter") {
      return reply.code(400).send({ error: "provider must be 'deepseek' or 'openrouter'" });
    }

    // Merge with existing config so omitted fields are preserved
    const existing = getChatProviderConfig(fastify.storage);
    const updated: ChatProviderConfig = {
      provider: provider ?? existing.provider,
      deepseekApiKey: deepseekApiKey !== undefined ? deepseekApiKey : existing.deepseekApiKey,
      openrouterApiKey: openrouterApiKey !== undefined ? openrouterApiKey : existing.openrouterApiKey,
      openrouterModel: openrouterModel !== undefined ? openrouterModel : existing.openrouterModel,
    };

    fastify.storage.settings.set("chat_provider", JSON.stringify(updated));
    console.log(`[Settings] Chat provider updated: ${updated.provider}`);

    return reply.code(200).send({
      provider: updated.provider,
      deepseekApiKey: maskApiKey(updated.deepseekApiKey),
      openrouterApiKey: maskApiKey(updated.openrouterApiKey),
      openrouterModel: updated.openrouterModel,
    });
  });

  // ---- Terminal Settings ----

  fastify.get("/api/settings/terminal", async (_req, reply) => {
    const saved = fastify.storage.settings.get("terminal");
    if (!saved) {
      return reply.code(200).send(DEFAULT_TERMINAL_SETTINGS);
    }
    try {
      const parsed = JSON.parse(saved) as Partial<TerminalSettings>;
      return reply.code(200).send({
        scrollback: typeof parsed.scrollback === "number" ? parsed.scrollback : DEFAULT_TERMINAL_SETTINGS.scrollback,
        fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_TERMINAL_SETTINGS.fontSize,
        fontFamily: typeof parsed.fontFamily === "string" && parsed.fontFamily.trim()
          ? parsed.fontFamily
          : DEFAULT_TERMINAL_SETTINGS.fontFamily,
      });
    } catch {
      return reply.code(200).send(DEFAULT_TERMINAL_SETTINGS);
    }
  });

  fastify.put<{
    Body: Partial<TerminalSettings>;
  }>("/api/settings/terminal", async (req, reply) => {
    const { scrollback, fontSize, fontFamily } = req.body;

    if (scrollback !== undefined) {
      if (typeof scrollback !== "number" || !Number.isFinite(scrollback) || scrollback < SCROLLBACK_MIN || scrollback > SCROLLBACK_MAX) {
        return reply.code(400).send({ error: `scrollback must be a number between ${SCROLLBACK_MIN} and ${SCROLLBACK_MAX}` });
      }
    }
    if (fontSize !== undefined) {
      if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize < FONT_SIZE_MIN || fontSize > FONT_SIZE_MAX) {
        return reply.code(400).send({ error: `fontSize must be a number between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}` });
      }
    }
    if (fontFamily !== undefined) {
      if (typeof fontFamily !== "string" || fontFamily.trim() === "") {
        return reply.code(400).send({ error: "fontFamily must be a non-empty string" });
      }
    }

    const saved = fastify.storage.settings.get("terminal");
    const existing: TerminalSettings = (() => {
      if (!saved) return DEFAULT_TERMINAL_SETTINGS;
      try {
        const parsed = JSON.parse(saved) as Partial<TerminalSettings>;
        return {
          scrollback: typeof parsed.scrollback === "number" ? parsed.scrollback : DEFAULT_TERMINAL_SETTINGS.scrollback,
          fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_TERMINAL_SETTINGS.fontSize,
          fontFamily: typeof parsed.fontFamily === "string" && parsed.fontFamily.trim()
            ? parsed.fontFamily
            : DEFAULT_TERMINAL_SETTINGS.fontFamily,
        };
      } catch {
        return DEFAULT_TERMINAL_SETTINGS;
      }
    })();

    const updated: TerminalSettings = {
      scrollback: Math.round(scrollback ?? existing.scrollback),
      fontSize: fontSize ?? existing.fontSize,
      fontFamily: (fontFamily ?? existing.fontFamily).trim(),
    };

    fastify.storage.settings.set("terminal", JSON.stringify(updated));
    console.log(`[Settings] Terminal updated: scrollback=${updated.scrollback}, fontSize=${updated.fontSize}, fontFamily="${updated.fontFamily}"`);

    return reply.code(200).send(updated);
  });
};

export default fp(routes, { name: "settings-routes" });
