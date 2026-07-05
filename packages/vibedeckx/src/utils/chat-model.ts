import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any;
import type { Storage } from "../storage/types.js";

/**
 * Provider registry — the single place where provider-specific knowledge lives.
 * Adding a new provider = add one entry here (and to `ProviderId`); the rest of
 * the app only ever deals with `{ provider, model }` choices.
 */
export type ProviderId = "deepseek" | "openrouter";

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** Fixed model list (for a dropdown UI), or null for free-form model ids. */
  models: readonly string[] | null;
  defaultModel: string;
  /** Env var consulted when no API key is stored for this provider. */
  envKey: string;
  create: (apiKey: string, model: string) => AnyLanguageModel;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-flash",
    envKey: "DEEPSEEK_API_KEY",
    create: (apiKey, model) => createDeepSeek({ apiKey })(model),
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    models: null,
    defaultModel: "deepseek/deepseek-chat-v3-0324",
    envKey: "OPENROUTER_API_KEY",
    create: (apiKey, model) => createOpenRouter({ apiKey })(model),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

const DEFAULT_PROVIDER: ProviderId = "deepseek";

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

/** A single model selection: which provider, and which model on that provider. */
export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

export interface ChatProviderConfig {
  /** One API key per provider, shared across all model uses (main, fast, …). */
  apiKeys: Record<ProviderId, string>;
  /** Model used by the main chat session. */
  main: ModelChoice;
  /** Model used by lightweight background features (translate, session titles). */
  fast: ModelChoice;
}

function defaultApiKeys(): Record<ProviderId, string> {
  const keys = {} as Record<ProviderId, string>;
  for (const id of PROVIDER_IDS) keys[id] = "";
  return keys;
}

function defaultChoice(): ModelChoice {
  return { provider: DEFAULT_PROVIDER, model: PROVIDERS[DEFAULT_PROVIDER].defaultModel };
}

function defaultConfig(): ChatProviderConfig {
  return { apiKeys: defaultApiKeys(), main: defaultChoice(), fast: defaultChoice() };
}

/** Coerce an arbitrary model value to a valid one for the given provider. */
export function normalizeModel(provider: ProviderId, model: unknown): string {
  const def = PROVIDERS[provider];
  if (typeof model === "string" && model.length > 0) {
    if (def.models && !def.models.includes(model)) return def.defaultModel;
    return model;
  }
  return def.defaultModel;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeChoice(raw: any, fallback: ModelChoice): ModelChoice {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const provider = isProviderId(raw.provider) ? raw.provider : fallback.provider;
  return { provider, model: normalizeModel(provider, raw.model) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeApiKeys(raw: any): Record<ProviderId, string> {
  const keys = defaultApiKeys();
  if (raw && typeof raw === "object") {
    for (const id of PROVIDER_IDS) {
      if (typeof raw[id] === "string") keys[id] = raw[id];
    }
  }
  return keys;
}

/**
 * Migrate the legacy flat config shape
 * `{ provider, deepseekApiKey, deepseekModel, openrouterApiKey, openrouterModel }`
 * into the current `{ apiKeys, main, fast }` shape. `fast` starts equal to
 * `main` so existing installs keep behaving exactly as before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLegacyConfig(parsed: any): ChatProviderConfig {
  const provider: ProviderId = isProviderId(parsed.provider) ? parsed.provider : DEFAULT_PROVIDER;
  const apiKeys = defaultApiKeys();
  if (typeof parsed.deepseekApiKey === "string") apiKeys.deepseek = parsed.deepseekApiKey;
  if (typeof parsed.openrouterApiKey === "string") apiKeys.openrouter = parsed.openrouterApiKey;

  const legacyModel = provider === "openrouter" ? parsed.openrouterModel : parsed.deepseekModel;
  const main: ModelChoice = { provider, model: normalizeModel(provider, legacyModel) };
  return { apiKeys, main, fast: { ...main } };
}

export async function getChatProviderConfig(storage: Storage): Promise<ChatProviderConfig> {
  const raw = await storage.settings.get("chat_provider");
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultConfig();

    // Current shape
    if ("main" in parsed || "fast" in parsed || "apiKeys" in parsed) {
      const apiKeys = normalizeApiKeys(parsed.apiKeys);
      const main = normalizeChoice(parsed.main, defaultChoice());
      const fast = normalizeChoice(parsed.fast, main);
      return { apiKeys, main, fast };
    }

    // Legacy shape
    return migrateLegacyConfig(parsed);
  } catch {
    return defaultConfig();
  }
}

function resolveModel(choice: ModelChoice, apiKeys: Record<ProviderId, string>): AnyLanguageModel {
  const def = PROVIDERS[choice.provider];
  const apiKey = apiKeys[choice.provider] || process.env[def.envKey] || "";
  return def.create(apiKey, choice.model || def.defaultModel);
}

/** Whether the given model choice has an API key available (stored or env). */
export function isModelConfigured(config: ChatProviderConfig, choice: ModelChoice): boolean {
  const def = PROVIDERS[choice.provider];
  return Boolean(config.apiKeys[choice.provider] || process.env[def.envKey]);
}

/** Resolve the primary chat model — used by the main chat session. */
export async function resolveChatModel(storage: Storage): Promise<AnyLanguageModel> {
  const config = await getChatProviderConfig(storage);
  return resolveModel(config.main, config.apiKeys);
}

/**
 * Resolve the "fast" chat model — used by lightweight background features
 * (translate, agent session titles).
 */
export async function resolveFastChatModel(storage: Storage): Promise<AnyLanguageModel> {
  const config = await getChatProviderConfig(storage);
  return resolveModel(config.fast, config.apiKeys);
}
