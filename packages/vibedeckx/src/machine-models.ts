import type { AgentType } from "./agent-types.js";
import type { AgentProvider } from "./agent-provider.js";
import { MODEL_SUGGESTIONS } from "./protocol/model-suggestions.js";

/**
 * The model list the composer's picker offers for one agent type on THIS
 * machine — the one that would spawn the session.
 *
 * `source: "machine"` is the CLI's own catalog for this machine's login (see
 * AgentProvider.listModels: fx, Claude Code and Codex each have one). `source: "suggestions"` is
 * the static MODEL_SUGGESTIONS fallback: the provider has no listing, the CLI
 * is missing, or it failed. Neither is a whitelist — the picker still accepts
 * free text.
 */
export interface MachineModelList {
  models: string[];
  source: "machine" | "suggestions";
  /**
   * How long until this machine's cache entry expires — relative, not a
   * timestamp, so the browser can add it to its own clock and no two machines'
   * clocks are ever compared. Asking again before then gets the same answer;
   * after it, the next ask re-runs the CLI.
   */
  expiresInMs: number;
}

/**
 * The catalog only changes on a CLI upgrade, a login/provider switch or a new
 * model release, and the picker has a refresh button for those. This is only
 * the safety net for a long-lived worker whose CLI updated itself.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A failure is retried sooner, so a transient network error does not pin the fallback. */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  expiresAt: number;
  inFlight: boolean;
  /** `expiresInMs` is filled in per caller by `answer()`. */
  value: Promise<Omit<MachineModelList, "expiresInMs">>;
}

const cache = new Map<AgentType, CacheEntry>();

/** The static fallback, worth re-asking for after FAILURE_TTL_MS. */
export function suggestedModelList(type: AgentType): MachineModelList {
  return { models: [...(MODEL_SUGGESTIONS[type] ?? [])], source: "suggestions", expiresInMs: FAILURE_TTL_MS };
}

export interface ListMachineModelsOptions {
  /** Skip the cache and run the CLI now (the picker's refresh button). */
  refresh?: boolean;
  now?: () => number;
}

/**
 * Held in this process's memory per agent type — the hub's for local
 * projects, each worker's for its own machine — so a restart clears it.
 * Concurrent callers share one in-flight CLI run. Never rejects.
 */
export function listMachineModels(provider: AgentProvider, options: ListMachineModelsOptions = {}): Promise<MachineModelList> {
  const now = options.now ?? Date.now;
  const type = provider.getAgentType();
  if (!provider.listModels) return Promise.resolve(suggestedModelList(type));

  // The entry's promise is shared by every caller; the time left on it is
  // each caller's own, read when its answer is handed out.
  const answer = (entry: CacheEntry) =>
    entry.value.then((list) => ({ ...list, expiresInMs: Math.max(0, entry.expiresAt - now()) }));

  const hit = cache.get(type);
  if (hit) {
    // A refresh joins a run still in flight rather than starting a second
    // one: that run's answer is as fresh as a new one would be.
    if (hit.inFlight) return answer(hit);
    if (!options.refresh && hit.expiresAt > now()) return answer(hit);
  }

  const entry: CacheEntry = { expiresAt: 0, inFlight: true, value: Promise.resolve(suggestedModelList(type)) };
  entry.value = provider.listModels().finally(() => { entry.inFlight = false; }).then(
    (models): Omit<MachineModelList, "expiresInMs"> => {
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
  return answer(entry);
}

/** Test hook. */
export function clearMachineModelCache(): void {
  cache.clear();
}
