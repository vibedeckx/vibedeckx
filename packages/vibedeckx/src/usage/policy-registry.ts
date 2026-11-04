import { composePolicies, dailyCostCapPolicy, rateLimitPolicy } from "./policies.js";
import type { UsagePolicy } from "./types.js";

/** Calls per user per minute when VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE is unset. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Build the default policy from the environment. Both guards apply to
 * platform-key calls only:
 *
 *  - VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE — calls per user per minute
 *    (default 120; 0 disables).
 *  - VIBEDECKX_LLM_DAILY_COST_LIMIT_USD — known spend per user per UTC day
 *    (unset or 0 = no cap). Calls of unknown cost count at a conservative
 *    fallback rate (see UNPRICED_USD_PER_MILLION_TOKENS).
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): UsagePolicy {
  const policies: UsagePolicy[] = [];

  const perMinute = parseLimit(env.VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE);
  if (perMinute > 0) policies.push(rateLimitPolicy({ perMinute }));

  const dailyUsd = parseLimit(env.VIBEDECKX_LLM_DAILY_COST_LIMIT_USD, 0);
  if (dailyUsd > 0) policies.push(dailyCostCapPolicy({ usd: dailyUsd }));

  return composePolicies(policies);
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[Usage] ignoring invalid limit "${raw}", using ${fallback}`);
    return fallback;
  }
  return n;
}

let current: UsagePolicy | undefined;

/** The policy every metered model call is checked against. */
export function getUsagePolicy(): UsagePolicy {
  current ??= policyFromEnv();
  return current;
}

/** Replace the active policy (deployment plugins, tests). `undefined` resets to the env default. */
export function setUsagePolicy(policy: UsagePolicy | undefined): void {
  current = policy;
}
