import type { LlmUsageEntry } from "../storage/types.js";
import type { UsageCheckContext, UsageDecision, UsagePolicy } from "./types.js";

const ALLOW: UsageDecision = { allow: true };

/** Lets every call through — the default when no guard is configured. */
export const unlimitedPolicy: UsagePolicy = {
  name: "unlimited",
  check: () => ALLOW,
};

/**
 * Run policies in order; the first denial wins. `onUsage` fans out to every
 * member, so stateful guards see every recorded call.
 */
export function composePolicies(policies: UsagePolicy[]): UsagePolicy {
  if (policies.length === 0) return unlimitedPolicy;
  if (policies.length === 1) return policies[0];
  return {
    name: policies.map((p) => p.name).join("+"),
    async check(ctx) {
      for (const policy of policies) {
        const decision = await policy.check(ctx);
        if (!decision.allow) return decision;
      }
      return ALLOW;
    },
    async onUsage(entry: LlmUsageEntry) {
      for (const policy of policies) await policy.onUsage?.(entry);
    },
  };
}

// The built-in guards protect the operator's money, so they only look at
// calls on the platform key. A user's own key (BYOK) is theirs to spend.
const isPlatformCall = (ctx: UsageCheckContext) => ctx.keySource === "platform";

const WINDOW_MS = 60_000;
// Above this many tracked users, drop the ones idle for a whole window.
const SWEEP_THRESHOLD = 1000;

/**
 * At most `perMinute` model calls per user in any sliding 60-second window.
 * Mainly a runaway-loop guard: an agent stuck retrying burns money fast.
 * Counts admitted calls (not completions), in memory — per hub process.
 */
export function rateLimitPolicy(options: { perMinute: number }): UsagePolicy {
  const calls = new Map<string, number[]>();

  const sweep = (now: number) => {
    for (const [userId, stamps] of calls) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= now - WINDOW_MS) calls.delete(userId);
    }
  };

  return {
    name: "rate-limit",
    check(ctx) {
      if (!isPlatformCall(ctx)) return ALLOW;
      const now = ctx.now.getTime();
      if (calls.size > SWEEP_THRESHOLD) sweep(now);
      const stamps = (calls.get(ctx.userId) ?? []).filter((t) => t > now - WINDOW_MS);
      if (stamps.length >= options.perMinute) {
        calls.set(ctx.userId, stamps);
        const retryAfterMs = stamps[0] + WINDOW_MS - now;
        return {
          allow: false,
          reason: "rate_limit",
          message: `Too many AI requests in a short time. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
          retryAfterMs,
        };
      }
      stamps.push(now);
      calls.set(ctx.userId, stamps);
      return ALLOW;
    },
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * USD per 1M tokens charged against the daily cap for calls whose cost is
 * unknown (no provider-reported cost, no entry in the price table). Set well
 * above typical prices so an unpriced model reaches the cap early rather than
 * never; the ledger itself still records those costs as unknown.
 */
export const UNPRICED_USD_PER_MILLION_TOKENS = 5;

/**
 * Deny once a user's platform-key spend for the current UTC day reaches
 * `usd`: known cost plus unpriced tokens at UNPRICED_USD_PER_MILLION_TOKENS.
 * Reads the ledger, so the check lags by at most the calls in flight — a call
 * that starts under the cap is allowed to finish.
 */
export function dailyCostCapPolicy(options: { usd: number }): UsagePolicy {
  const capNano = Math.round(options.usd * 1_000_000_000);
  return {
    name: "daily-cost-cap",
    async check(ctx) {
      if (!isPlatformCall(ctx)) return ALLOW;
      const dayStart = startOfUtcDay(ctx.now);
      const [known, unpricedTokens] = await Promise.all([
        ctx.ledger.costSince(ctx.userId, dayStart, "platform"),
        ctx.ledger.unpricedTokensSince(ctx.userId, dayStart, "platform"),
      ]);
      // tokens × (USD / 1M tokens) × 1e9 nano/USD
      const spent = known + unpricedTokens * UNPRICED_USD_PER_MILLION_TOKENS * 1000;
      if (spent < capNano) return ALLOW;
      const nextDay = dayStart.getTime() + 24 * 60 * 60 * 1000;
      return {
        allow: false,
        reason: "daily_cost_limit",
        message: "Today's AI usage limit has been reached. It resets at 00:00 UTC.",
        retryAfterMs: nextDay - ctx.now.getTime(),
      };
    },
  };
}
