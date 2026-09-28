import type { Storage } from "../storage/types.js";
import {
  DEFAULT_TTS_PROVIDER,
  TTS_PROVIDER_IDS,
  TTS_PROVIDERS,
  isTtsProviderId,
  type TtsProviderId,
} from "./providers.js";
import type { TtsCredentials } from "./types.js";

export const TTS_SETTING_KEY = "tts";
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;

/** Per-user TTS config, stored as JSON in `user_settings` under "tts". */
export interface TtsConfig {
  provider: TtsProviderId;
  /** Kept per provider so switching providers never drops the other's key. */
  credentials: Partial<Record<TtsProviderId, TtsCredentials>>;
  /** A voice of `provider`; normalized to its default when invalid. */
  voice: string;
  rate: number;
}

export function clampRate(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(value * 100) / 100));
}

export function normalizeVoice(provider: TtsProviderId, voice: unknown): string {
  const def = TTS_PROVIDERS[provider];
  return typeof voice === "string" && def.isValidVoice(voice) ? voice : def.defaultVoice;
}

function normalizeCredentials(raw: unknown): Partial<Record<TtsProviderId, TtsCredentials>> {
  const out: Partial<Record<TtsProviderId, TtsCredentials>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of TTS_PROVIDER_IDS) {
    const entry = (raw as Record<string, unknown>)[id];
    if (!entry || typeof entry !== "object") continue;
    const creds: TtsCredentials = {};
    for (const field of TTS_PROVIDERS[id].credentialFields) {
      const value = (entry as Record<string, unknown>)[field.key];
      if (typeof value === "string") creds[field.key] = value;
    }
    out[id] = creds;
  }
  return out;
}

export function defaultTtsConfig(): TtsConfig {
  return {
    provider: DEFAULT_TTS_PROVIDER,
    credentials: {},
    voice: TTS_PROVIDERS[DEFAULT_TTS_PROVIDER].defaultVoice,
    rate: 1,
  };
}

/** Pure parse/normalize step — usable inside an atomic `userSettings.update` merge. */
export function parseTtsConfig(raw: string | undefined): TtsConfig {
  if (!raw) return defaultTtsConfig();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return defaultTtsConfig();
    const provider = isTtsProviderId(parsed.provider) ? parsed.provider : DEFAULT_TTS_PROVIDER;
    return {
      provider,
      credentials: normalizeCredentials(parsed.credentials),
      voice: normalizeVoice(provider, parsed.voice),
      rate: clampRate(parsed.rate),
    };
  } catch {
    return defaultTtsConfig();
  }
}

export async function getTtsConfig(storage: Storage, userId: string): Promise<TtsConfig> {
  return parseTtsConfig(await storage.userSettings.get(userId, TTS_SETTING_KEY));
}

/** Stored values, falling back to each field's env var. */
export function resolveCredentials(config: TtsConfig, provider: TtsProviderId = config.provider): TtsCredentials {
  const stored = config.credentials[provider] ?? {};
  const creds: TtsCredentials = {};
  for (const field of TTS_PROVIDERS[provider].credentialFields) {
    const value = stored[field.key]?.trim() || (field.envKey ? process.env[field.envKey]?.trim() : "") || "";
    creds[field.key] = value;
  }
  return creds;
}

export function isTtsConfigured(config: TtsConfig, provider: TtsProviderId = config.provider): boolean {
  const creds = resolveCredentials(config, provider);
  return TTS_PROVIDERS[provider].credentialFields.every((field) => creds[field.key].length > 0);
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}
