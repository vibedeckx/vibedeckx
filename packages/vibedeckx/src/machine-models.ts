import type { AgentType } from "./agent-types.js";
import type { AgentProvider } from "./agent-provider.js";
import { MODEL_SUGGESTIONS } from "./protocol/model-suggestions.js";

/**
 * The model list the composer's picker offers for one agent type on THIS
 * machine — the one that would spawn the session.
 *
 * `source: "machine"` is the CLI's own catalog for this machine's login (fx:
 * `fx models`, which follows the active provider). `source: "suggestions"` is
 * the static MODEL_SUGGESTIONS fallback: the provider has no listing, the CLI
 * is missing, or it failed. Neither is a whitelist — the picker still accepts
 * free text.
 */
export interface MachineModelList {
  models: string[];
  source: "machine" | "suggestions";
}

/** A login/provider switch shows up within this long; `fx models` costs a network round-trip. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** A failure is retried sooner, so a transient network error does not pin the fallback. */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  expiresAt: number;
  value: Promise<MachineModelList>;
}

const cache = new Map<AgentType, CacheEntry>();

export function suggestedModelList(type: AgentType): MachineModelList {
  return { models: [...(MODEL_SUGGESTIONS[type] ?? [])], source: "suggestions" };
}

/**
 * Cached per agent type; concurrent callers share one in-flight CLI run.
 * Never rejects.
 */
export function listMachineModels(provider: AgentProvider, now: () => number = Date.now): Promise<MachineModelList> {
  const type = provider.getAgentType();
  if (!provider.listModels) return Promise.resolve(suggestedModelList(type));

  const hit = cache.get(type);
  if (hit && hit.expiresAt > now()) return hit.value;

  const entry: CacheEntry = { expiresAt: Number.POSITIVE_INFINITY, value: Promise.resolve(suggestedModelList(type)) };
  entry.value = provider.listModels().then(
    (models): MachineModelList => {
      // An empty catalog is not useful to offer and most likely a transient
      // state of the login; answer the suggestions and retry as soon as a failure.
      entry.expiresAt = now() + (models.length ? CACHE_TTL_MS : FAILURE_TTL_MS);
      return models.length ? { models, source: "machine" } : suggestedModelList(type);
    },
    (err: unknown) => {
      entry.expiresAt = now() + FAILURE_TTL_MS;
      console.warn(`[models] ${type} model listing failed; using suggestions:`, err instanceof Error ? err.message : err);
      return suggestedModelList(type);
    },
  );
  cache.set(type, entry);
  return entry.value;
}

/** Test hook. */
export function clearMachineModelCache(): void {
  cache.clear();
}
