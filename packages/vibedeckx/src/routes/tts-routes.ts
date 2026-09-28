import { createHash } from "crypto";
import { Readable } from "stream";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import {
  TTS_SETTING_KEY,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
  clampRate,
  getTtsConfig,
  isTtsConfigured,
  maskSecret,
  normalizeVoice,
  parseTtsConfig,
  resolveCredentials,
  type TtsConfig,
} from "../tts/config.js";
import { TTS_PROVIDERS, TTS_PROVIDER_IDS, isTtsProviderId, type TtsProviderId } from "../tts/providers.js";
import { TtsProviderError, type TtsCredentials, type TtsVoice } from "../tts/types.js";
import "../server-types.js";

/**
 * Text-to-speech for reading agent replies aloud. Synthesis runs on the hub
 * (browser → hub → provider): the reply text is already in the browser, so
 * the worker and the tunnel contract are not involved.
 * Design: docs/agent-message-tts-design.md.
 */

class TtsValidationError extends Error {}

/** In-flight synthesize requests per user — the player needs at most 2 (current + prefetch). */
export const TTS_MAX_CONCURRENT_PER_USER = 2;
const VOICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VOICE_CACHE_MAX = 50;
/** Upper bound on one synthesize call, body included — a chunk is ≤ ~2 min of audio. */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

function requireTtsUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const auth = requireAuth(req, reply);
  if (auth === null) return null;
  return resolveUserId(auth);
}

function serializeConfig(config: TtsConfig) {
  const credentials: Partial<Record<TtsProviderId, TtsCredentials>> = {};
  for (const id of TTS_PROVIDER_IDS) {
    const stored = config.credentials[id] ?? {};
    const out: TtsCredentials = {};
    for (const field of TTS_PROVIDERS[id].credentialFields) {
      const value = stored[field.key] ?? "";
      out[field.key] = field.secret ? maskSecret(value) : value;
    }
    credentials[id] = out;
  }
  return {
    provider: config.provider,
    voice: config.voice,
    rate: config.rate,
    configured: isTtsConfigured(config),
    credentials,
    rateRange: { min: TTS_RATE_MIN, max: TTS_RATE_MAX },
    providers: TTS_PROVIDER_IDS.map((id) => {
      const def = TTS_PROVIDERS[id];
      return {
        id,
        label: def.label,
        defaultVoice: def.defaultVoice,
        maxCharsPerRequest: def.maxCharsPerRequest,
        configured: isTtsConfigured(config, id),
        credentialFields: def.credentialFields.map((field) => ({
          key: field.key,
          label: field.label,
          secret: field.secret,
          placeholder: field.placeholder,
          // Lets the UI say "using the server default" without revealing the value.
          fromEnv: Boolean(field.envKey && process.env[field.envKey]?.trim()),
        })),
      };
    }),
  };
}

function errorReply(reply: FastifyReply, err: TtsProviderError) {
  switch (err.kind) {
    // Not 401: the client would read that as its own session having expired.
    case "auth":
      return reply.code(502).send({ code: "tts_auth_failed", error: err.message });
    case "quota":
      return reply.code(429).send({ code: "tts_quota", error: err.message });
    case "bad_request":
      return reply.code(400).send({ code: "tts_bad_request", error: err.message });
    default:
      return reply.code(502).send({ code: "tts_upstream", error: err.message });
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  const inFlight = new Map<string, number>();
  const voiceCache = new Map<string, { at: number; voices: TtsVoice[] }>();

  const dispatcher = () => fastify.proxyManager?.getFetchDispatcher();

  fastify.get("/api/settings/tts", async (req, reply) => {
    const userId = requireTtsUser(req, reply);
    if (userId === null) return;
    return reply.code(200).send(serializeConfig(await getTtsConfig(fastify.storage, userId)));
  });

  fastify.put<{
    Body: {
      provider?: unknown;
      credentials?: unknown;
      voice?: unknown;
      rate?: unknown;
    };
  }>("/api/settings/tts", async (req, reply) => {
    const userId = requireTtsUser(req, reply);
    if (userId === null) return;
    const body = req.body ?? {};

    let updated!: TtsConfig;
    try {
      await fastify.storage.userSettings.update(userId, TTS_SETTING_KEY, (current) => {
        const existing = parseTtsConfig(current);

        let provider = existing.provider;
        if (body.provider !== undefined) {
          if (!isTtsProviderId(body.provider)) {
            throw new TtsValidationError(`provider must be one of: ${TTS_PROVIDER_IDS.join(", ")}`);
          }
          provider = body.provider;
        }

        const credentials = { ...existing.credentials };
        if (body.credentials !== undefined) {
          if (!body.credentials || typeof body.credentials !== "object") {
            throw new TtsValidationError("credentials must be an object");
          }
          for (const id of TTS_PROVIDER_IDS) {
            const incoming = (body.credentials as Record<string, unknown>)[id];
            if (incoming === undefined) continue;
            if (!incoming || typeof incoming !== "object") {
              throw new TtsValidationError(`credentials.${id} must be an object`);
            }
            const merged: TtsCredentials = { ...(existing.credentials[id] ?? {}) };
            for (const field of TTS_PROVIDERS[id].credentialFields) {
              const value = (incoming as Record<string, unknown>)[field.key];
              if (value === undefined) continue;
              if (typeof value !== "string") {
                throw new TtsValidationError(`credentials.${id}.${field.key} must be a string`);
              }
              // Echoing back the mask we served means "unchanged".
              if (field.secret && value !== "" && value === maskSecret(merged[field.key] ?? "")) continue;
              merged[field.key] = value.trim();
            }
            credentials[id] = merged;
          }
        }

        let voice: string;
        if (body.voice !== undefined) {
          if (typeof body.voice !== "string" || !TTS_PROVIDERS[provider].isValidVoice(body.voice)) {
            throw new TtsValidationError(`voice is not a valid ${TTS_PROVIDERS[provider].label} voice`);
          }
          voice = body.voice;
        } else {
          // Switching providers resets a voice that belongs to the old one.
          voice = normalizeVoice(provider, provider === existing.provider ? existing.voice : undefined);
        }

        let rate = existing.rate;
        if (body.rate !== undefined) {
          if (
            typeof body.rate !== "number" ||
            !Number.isFinite(body.rate) ||
            body.rate < TTS_RATE_MIN ||
            body.rate > TTS_RATE_MAX
          ) {
            throw new TtsValidationError(`rate must be a number between ${TTS_RATE_MIN} and ${TTS_RATE_MAX}`);
          }
          rate = clampRate(body.rate);
        }

        updated = { provider, credentials, voice, rate };
        return JSON.stringify(updated);
      });
    } catch (err) {
      if (err instanceof TtsValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    console.log(`[Settings] TTS updated: provider=${updated.provider}, voice=${updated.voice}, rate=${updated.rate}`);
    return reply.code(200).send(serializeConfig(updated));
  });

  fastify.get<{ Querystring: { provider?: string } }>("/api/tts/voices", async (req, reply) => {
    const userId = requireTtsUser(req, reply);
    if (userId === null) return;
    const config = await getTtsConfig(fastify.storage, userId);
    const requested = req.query.provider;
    if (requested !== undefined && !isTtsProviderId(requested)) {
      return reply.code(400).send({ error: `provider must be one of: ${TTS_PROVIDER_IDS.join(", ")}` });
    }
    const provider: TtsProviderId = requested ?? config.provider;
    if (!isTtsConfigured(config, provider)) {
      return reply.code(409).send({ code: "tts_not_configured", error: "Text-to-speech is not configured" });
    }

    const creds = resolveCredentials(config, provider);
    // Keyed by the credentials, not just the provider: a wrong key must not be
    // "validated" by a list someone else's key fetched.
    const cacheKey = createHash("sha256").update(provider).update("\0").update(JSON.stringify(creds)).digest("hex");
    const cached = voiceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < VOICE_CACHE_TTL_MS) {
      return reply.code(200).send({ provider, voices: cached.voices });
    }

    try {
      const voices = await TTS_PROVIDERS[provider].listVoices(creds, {
        signal: AbortSignal.timeout(15_000),
        dispatcher: dispatcher(),
      });
      if (voiceCache.size >= VOICE_CACHE_MAX) voiceCache.delete(voiceCache.keys().next().value!);
      voiceCache.set(cacheKey, { at: Date.now(), voices });
      return reply.code(200).send({ provider, voices });
    } catch (err) {
      if (err instanceof TtsProviderError) return errorReply(reply, err);
      if ((err as Error)?.name === "TimeoutError") {
        return reply.code(504).send({ code: "tts_upstream", error: "Voice list request timed out" });
      }
      throw err;
    }
  });

  fastify.post<{ Body: { text?: unknown; voice?: unknown; rate?: unknown } }>(
    "/api/tts/synthesize",
    async (req, reply) => {
      const userId = requireTtsUser(req, reply);
      if (userId === null) return;
      const config = await getTtsConfig(fastify.storage, userId);
      const def = TTS_PROVIDERS[config.provider];
      const body = req.body ?? {};

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return reply.code(400).send({ error: "text is required" });
      if (text.length > def.maxCharsPerRequest) {
        return reply.code(400).send({ error: `text must be at most ${def.maxCharsPerRequest} characters` });
      }
      // Overrides let the settings page preview an unsaved voice / rate.
      if (body.voice !== undefined && (typeof body.voice !== "string" || !def.isValidVoice(body.voice))) {
        return reply.code(400).send({ error: "invalid voice" });
      }
      if (body.rate !== undefined && (typeof body.rate !== "number" || !Number.isFinite(body.rate))) {
        return reply.code(400).send({ error: "invalid rate" });
      }
      if (!isTtsConfigured(config)) {
        return reply.code(409).send({ code: "tts_not_configured", error: "Text-to-speech is not configured" });
      }

      const active = inFlight.get(userId) ?? 0;
      if (active >= TTS_MAX_CONCURRENT_PER_USER) {
        return reply.code(429).send({ code: "tts_busy", error: "Too many concurrent speech requests" });
      }
      inFlight.set(userId, active + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (inFlight.get(userId) ?? 1) - 1;
        if (n <= 0) inFlight.delete(userId);
        else inFlight.set(userId, n);
      };

      // Stopping playback on the client closes this response; abort the
      // upstream call so a stopped reply stops costing provider quota.
      const controller = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
        release();
      });

      const startedAt = Date.now();
      let result;
      try {
        result = await def.synthesize(resolveCredentials(config), {
          text,
          voice: typeof body.voice === "string" ? body.voice : config.voice,
          rate: body.rate !== undefined ? clampRate(body.rate) : config.rate,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS)]),
          dispatcher: dispatcher(),
        });
      } catch (err) {
        release();
        if (err instanceof TtsProviderError) {
          console.warn(`[tts] ${config.provider} synthesize failed (${err.kind}): ${err.message}`);
          return errorReply(reply, err);
        }
        // Client went away; nobody reads this, but the handler must still settle.
        if (controller.signal.aborted) return reply.code(499).send();
        if ((err as Error)?.name === "TimeoutError") {
          return reply.code(504).send({ code: "tts_upstream", error: "Speech synthesis timed out" });
        }
        throw err;
      }

      // Never log the text itself — replies can carry code or secrets.
      console.log(`[tts] ${config.provider} chars=${text.length} ttfb=${Date.now() - startedAt}ms`);
      const audio = Readable.fromWeb(result.audio as import("stream/web").ReadableStream<Uint8Array>);
      audio.once("close", release);
      audio.once("error", (err) => {
        if (!controller.signal.aborted) console.warn(`[tts] audio stream error: ${err.message}`);
      });
      return reply
        .code(200)
        .header("Content-Type", result.contentType)
        .header("Cache-Control", "no-store")
        .send(audio);
    },
  );
};

export default fp(routes, { name: "tts-routes" });
