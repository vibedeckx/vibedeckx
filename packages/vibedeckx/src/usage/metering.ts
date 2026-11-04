import type { LlmCostSource, LlmUsageEntry } from "../storage/types.js";
import type { LlmCallMeta } from "./types.js";

/** Provider-level usage as a model call reports it (LanguageModelV3Usage). */
export interface RawCallUsage {
  inputTokens: { total?: number; cacheRead?: number };
  outputTokens: { total?: number; reasoning?: number };
}

type ProviderMetadata = Record<string, Record<string, unknown> | undefined> | undefined;

/** USD per 1M tokens. */
interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

// Fallback prices for providers that report no per-call cost. Keyed
// `${provider}:${model}`. Only consulted when the provider gives no actual
// cost (AI Gateway and OpenRouter do), and the result is tagged 'estimated'.
// Check these against the provider's pricing page when adding or changing one.
const PRICES: Record<string, ModelPrice> = {
  "deepseek:deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
};

const NANO_PER_USD = 1_000_000_000;

/**
 * Convert a USD amount to integer nano-USD. Decimal strings (AI Gateway
 * reports cost as e.g. "0.001415568") are converted digit-wise so no float
 * rounding creeps in; anything else goes through Number.
 */
export function usdToNano(value: unknown): number | null {
  if (typeof value === "string") {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (match) {
      const whole = Number(match[1]) * NANO_PER_USD;
      const fraction = (match[2] ?? "").padEnd(10, "0");
      const nanos = Number(fraction.slice(0, 9)) + (Number(fraction[9]) >= 5 ? 1 : 0);
      return whole + nanos;
    }
  }
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * NANO_PER_USD) : null;
}

interface ProviderReport {
  costNano: number | null;
  resolvedProvider: string | null;
  generationId: string | null;
}

/** What the provider itself said about the call: billed cost and routing. */
function readProviderReport(metadata: ProviderMetadata): ProviderReport {
  const gateway = metadata?.gateway;
  if (gateway) {
    const routing = gateway.routing as { resolvedProvider?: unknown } | undefined;
    return {
      costNano: usdToNano(gateway.cost),
      resolvedProvider: typeof routing?.resolvedProvider === "string" ? routing.resolvedProvider : null,
      generationId: typeof gateway.generationId === "string" ? gateway.generationId : null,
    };
  }
  const openrouter = metadata?.openrouter;
  if (openrouter) {
    const usage = openrouter.usage as { cost?: unknown } | undefined;
    const provider = openrouter.provider;
    return {
      costNano: usage?.cost === undefined ? null : usdToNano(usage.cost),
      resolvedProvider: typeof provider === "string" ? provider : null,
      generationId: null,
    };
  }
  return { costNano: null, resolvedProvider: null, generationId: null };
}

function estimateCostNano(meta: LlmCallMeta, input: number, cached: number, output: number): number | null {
  const price = PRICES[`${meta.provider}:${meta.model}`];
  if (!price) return null;
  // tokens × (USD / 1M tokens) × 1e9 nano/USD = tokens × price × 1000
  const nano = (Math.max(0, input - cached) * price.input + cached * price.cachedInput + output * price.output) * 1000;
  return Math.round(nano);
}

/** Build the ledger row for one finished call. */
export function buildUsageEntry(
  meta: LlmCallMeta,
  usage: RawCallUsage | undefined,
  providerMetadata: ProviderMetadata,
): LlmUsageEntry {
  const input = usage?.inputTokens?.total ?? 0;
  const cached = usage?.inputTokens?.cacheRead ?? 0;
  const output = usage?.outputTokens?.total ?? 0;
  const reasoning = usage?.outputTokens?.reasoning ?? 0;

  const report = readProviderReport(providerMetadata);
  let costNano = report.costNano;
  let costSource: LlmCostSource | null = costNano === null ? null : "actual";
  if (costNano === null) {
    costNano = estimateCostNano(meta, input, cached, output);
    if (costNano !== null) costSource = "estimated";
  }

  return {
    user_id: meta.userId,
    feature: meta.feature,
    provider: meta.provider,
    model: meta.model,
    resolved_provider: report.resolvedProvider,
    key_source: meta.keySource,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cost_nanousd: costNano,
    cost_source: costSource,
    generation_id: report.generationId,
  };
}
