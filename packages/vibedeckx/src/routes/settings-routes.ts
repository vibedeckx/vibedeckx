import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProxyConfig } from "../utils/proxy-manager.js";
import {
  getChatProviderConfig,
  normalizeModel,
  isProviderId,
  PROVIDER_IDS,
  PROVIDERS,
  type ChatProviderConfig,
  type ModelChoice,
  type ProviderId,
} from "../utils/chat-model.js";
import { requireAuth } from "../server.js";
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

export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
  filesTreeFontSize: number;
  filesContentFontSize: number;
}

const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 15,
  chatFontSize: 15,
  filesTreeFontSize: 14,
  filesContentFontSize: 14,
};

const CONV_FONT_SIZE_MIN = 12;
const CONV_FONT_SIZE_MAX = 22;

function validateConvFontSize(value: unknown, field: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${field} must be a finite number`;
  }
  if (!Number.isInteger(value)) {
    return `${field} must be an integer`;
  }
  if (value < CONV_FONT_SIZE_MIN || value > CONV_FONT_SIZE_MAX) {
    return `${field} must be between ${CONV_FONT_SIZE_MIN} and ${CONV_FONT_SIZE_MAX}`;
  }
  return null;
}

function readStoredConversationSettings(saved: string | undefined): ConversationSettings {
  if (!saved) return DEFAULT_CONVERSATION_SETTINGS;
  try {
    const parsed = JSON.parse(saved) as Partial<ConversationSettings>;
    const agentValid =
      typeof parsed.agentFontSize === "number" &&
      validateConvFontSize(parsed.agentFontSize, "agentFontSize") === null;
    const chatValid =
      typeof parsed.chatFontSize === "number" &&
      validateConvFontSize(parsed.chatFontSize, "chatFontSize") === null;
    const filesTreeValid =
      typeof parsed.filesTreeFontSize === "number" &&
      validateConvFontSize(parsed.filesTreeFontSize, "filesTreeFontSize") === null;
    const filesContentValid =
      typeof parsed.filesContentFontSize === "number" &&
      validateConvFontSize(parsed.filesContentFontSize, "filesContentFontSize") === null;
    return {
      agentFontSize: agentValid
        ? (parsed.agentFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.agentFontSize,
      chatFontSize: chatValid
        ? (parsed.chatFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.chatFontSize,
      filesTreeFontSize: filesTreeValid
        ? (parsed.filesTreeFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.filesTreeFontSize,
      filesContentFontSize: filesContentValid
        ? (parsed.filesContentFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.filesContentFontSize,
    };
  } catch {
    return DEFAULT_CONVERSATION_SETTINGS;
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Get proxy settings
  fastify.get("/api/settings/proxy", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
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
    if (requireAuth(req, reply) === null) return;
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
    if (requireAuth(req, reply) === null) return;
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

  function maskApiKeys(keys: Record<ProviderId, string>): Record<ProviderId, string> {
    const masked = {} as Record<ProviderId, string>;
    for (const id of PROVIDER_IDS) masked[id] = maskApiKey(keys[id]);
    return masked;
  }

  function serializeConfig(config: ChatProviderConfig) {
    return {
      apiKeys: maskApiKeys(config.apiKeys),
      main: config.main,
      fast: config.fast,
    };
  }

  /** Validate + normalize a model choice from the request body, or return an error string. */
  function parseChoice(
    raw: Partial<ModelChoice> | undefined,
    existing: ModelChoice,
    field: string,
  ): ModelChoice | { error: string } {
    if (raw === undefined) return existing;
    const provider = raw.provider !== undefined ? raw.provider : existing.provider;
    if (!isProviderId(provider)) {
      return { error: `${field}.provider must be one of: ${PROVIDER_IDS.join(", ")}` };
    }
    const rawModel = raw.model !== undefined ? raw.model : existing.model;
    const def = PROVIDERS[provider];
    if (def.models && typeof rawModel === "string" && rawModel.length > 0 && !def.models.includes(rawModel)) {
      return { error: `${field}.model for ${provider} must be one of: ${def.models.join(", ")}` };
    }
    return { provider, model: normalizeModel(provider, rawModel) };
  }

  fastify.get("/api/settings/chat-provider", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
    const config = getChatProviderConfig(fastify.storage);
    return reply.code(200).send(serializeConfig(config));
  });

  fastify.put<{
    Body: Partial<ChatProviderConfig>;
  }>("/api/settings/chat-provider", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
    const { apiKeys, main, fast } = req.body;

    const existing = getChatProviderConfig(fastify.storage);

    // Merge API keys per provider; only providers present in the body are updated.
    const mergedKeys = { ...existing.apiKeys };
    if (apiKeys !== undefined) {
      if (typeof apiKeys !== "object" || apiKeys === null) {
        return reply.code(400).send({ error: "apiKeys must be an object" });
      }
      for (const id of PROVIDER_IDS) {
        const value = (apiKeys as Record<string, unknown>)[id];
        if (value !== undefined) {
          if (typeof value !== "string") {
            return reply.code(400).send({ error: `apiKeys.${id} must be a string` });
          }
          mergedKeys[id] = value;
        }
      }
    }

    const mainResult = parseChoice(main, existing.main, "main");
    if ("error" in mainResult) return reply.code(400).send({ error: mainResult.error });
    const fastResult = parseChoice(fast, existing.fast, "fast");
    if ("error" in fastResult) return reply.code(400).send({ error: fastResult.error });

    const updated: ChatProviderConfig = {
      apiKeys: mergedKeys,
      main: mainResult,
      fast: fastResult,
    };

    fastify.storage.settings.set("chat_provider", JSON.stringify(updated));
    console.log(
      `[Settings] Chat provider updated: main=${updated.main.provider}/${updated.main.model}, fast=${updated.fast.provider}/${updated.fast.model}`,
    );

    return reply.code(200).send(serializeConfig(updated));
  });

  // ---- Terminal Settings ----

  fastify.get("/api/settings/terminal", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
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
    if (requireAuth(req, reply) === null) return;
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

  // ---- Conversation Settings ----

  fastify.get("/api/settings/conversation", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
    const saved = fastify.storage.settings.get("conversation");
    return reply.code(200).send(readStoredConversationSettings(saved));
  });

  fastify.put<{
    Body: Partial<ConversationSettings>;
  }>("/api/settings/conversation", async (req, reply) => {
    if (requireAuth(req, reply) === null) return;
    const { agentFontSize, chatFontSize, filesTreeFontSize, filesContentFontSize } = req.body;

    if (agentFontSize !== undefined) {
      const err = validateConvFontSize(agentFontSize, "agentFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
    if (chatFontSize !== undefined) {
      const err = validateConvFontSize(chatFontSize, "chatFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
    if (filesTreeFontSize !== undefined) {
      const err = validateConvFontSize(filesTreeFontSize, "filesTreeFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
    if (filesContentFontSize !== undefined) {
      const err = validateConvFontSize(filesContentFontSize, "filesContentFontSize");
      if (err) return reply.code(400).send({ error: err });
    }

    const existing = readStoredConversationSettings(fastify.storage.settings.get("conversation"));
    const updated: ConversationSettings = {
      agentFontSize: agentFontSize ?? existing.agentFontSize,
      chatFontSize: chatFontSize ?? existing.chatFontSize,
      filesTreeFontSize: filesTreeFontSize ?? existing.filesTreeFontSize,
      filesContentFontSize: filesContentFontSize ?? existing.filesContentFontSize,
    };

    fastify.storage.settings.set("conversation", JSON.stringify(updated));
    console.log(
      `[Settings] Conversation updated: agentFontSize=${updated.agentFontSize}, chatFontSize=${updated.chatFontSize}, filesTreeFontSize=${updated.filesTreeFontSize}, filesContentFontSize=${updated.filesContentFontSize}`,
    );

    return reply.code(200).send(updated);
  });
};

export default fp(routes, { name: "settings-routes" });
