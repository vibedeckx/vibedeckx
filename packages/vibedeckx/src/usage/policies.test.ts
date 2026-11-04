import { describe, expect, it, vi } from "vitest";
import { composePolicies, dailyCostCapPolicy, rateLimitPolicy, unlimitedPolicy } from "./policies.js";
import { DEFAULT_RATE_LIMIT_PER_MINUTE, policyFromEnv } from "./policy-registry.js";
import type { UsageCheckContext, UsagePolicy } from "./types.js";

const ctx = (over: Partial<UsageCheckContext> = {}): UsageCheckContext => ({
  userId: "u1",
  feature: "chat-session",
  provider: "gateway",
  model: "m",
  keySource: "platform",
  ledger: { costSince: async () => 0, unpricedTokensSince: async () => 0 },
  now: new Date("2026-11-03T10:00:00.000Z"),
  ...over,
});

const at = (ms: number) => new Date(Date.parse("2026-11-03T10:00:00.000Z") + ms);

describe("rateLimitPolicy", () => {
  it("allows up to the limit within a minute, then denies with a retry hint", () => {
    const policy = rateLimitPolicy({ perMinute: 2 });
    expect(policy.check(ctx({ now: at(0) }))).toEqual({ allow: true });
    expect(policy.check(ctx({ now: at(10_000) }))).toEqual({ allow: true });
    const denied = policy.check(ctx({ now: at(20_000) }));
    expect(denied).toMatchObject({ allow: false, reason: "rate_limit", retryAfterMs: 40_000 });
  });

  it("slides: calls older than a minute stop counting", () => {
    const policy = rateLimitPolicy({ perMinute: 1 });
    expect(policy.check(ctx({ now: at(0) })).allow).toBe(true);
    expect(policy.check(ctx({ now: at(59_999) })).allow).toBe(false);
    expect(policy.check(ctx({ now: at(60_001) })).allow).toBe(true);
  });

  it("counts each user separately and ignores BYOK calls", () => {
    const policy = rateLimitPolicy({ perMinute: 1 });
    expect(policy.check(ctx()).allow).toBe(true);
    expect(policy.check(ctx({ userId: "u2" })).allow).toBe(true);
    expect(policy.check(ctx({ keySource: "byok" })).allow).toBe(true);
    expect(policy.check(ctx()).allow).toBe(false);
  });
});

describe("dailyCostCapPolicy", () => {
  it("denies once today's platform spend reaches the cap, until UTC midnight", async () => {
    const costSince = vi.fn(async () => 2_000_000_000);
    const decision = await dailyCostCapPolicy({ usd: 2 }).check(ctx({ ledger: { costSince, unpricedTokensSince: async () => 0 } }));
    expect(decision).toMatchObject({ allow: false, reason: "daily_cost_limit", retryAfterMs: 14 * 60 * 60 * 1000 });
    expect(costSince).toHaveBeenCalledWith("u1", new Date("2026-11-03T00:00:00.000Z"), "platform");
  });

  it("allows under the cap and never reads the ledger for BYOK", async () => {
    const costSince = vi.fn(async () => 1_999_999_999);
    const policy = dailyCostCapPolicy({ usd: 2 });
    const unpricedTokensSince = vi.fn(async () => 0);
    expect(await policy.check(ctx({ ledger: { costSince, unpricedTokensSince } }))).toEqual({ allow: true });
    costSince.mockClear();
    expect(await policy.check(ctx({ keySource: "byok", ledger: { costSince, unpricedTokensSince } }))).toEqual({ allow: true });
    expect(costSince).not.toHaveBeenCalled();
  });

  it("charges calls of unknown cost at the conservative fallback rate", async () => {
    const policy = dailyCostCapPolicy({ usd: 2 });
    // 400k unpriced tokens at $5/1M = $2 — at the cap on its own.
    const ledger = { costSince: async () => 0, unpricedTokensSince: async () => 400_000 };
    expect(await policy.check(ctx({ ledger }))).toMatchObject({ allow: false, reason: "daily_cost_limit" });
    const under = { costSince: async () => 0, unpricedTokensSince: async () => 399_999 };
    expect(await policy.check(ctx({ ledger: under }))).toEqual({ allow: true });
  });
});

describe("composePolicies", () => {
  const deny = (name: string): UsagePolicy => ({
    name,
    check: () => ({ allow: false, reason: name, message: name }),
  });

  it("returns the first denial and skips the rest", async () => {
    const later = { name: "later", check: vi.fn(() => ({ allow: true as const })) };
    const decision = await composePolicies([unlimitedPolicy, deny("first"), later]).check(ctx());
    expect(decision).toMatchObject({ allow: false, reason: "first" });
    expect(later.check).not.toHaveBeenCalled();
  });

  it("fans onUsage out to every member", async () => {
    const a = { name: "a", check: () => ({ allow: true as const }), onUsage: vi.fn() };
    const b = { name: "b", check: () => ({ allow: true as const }), onUsage: vi.fn() };
    const entry = {} as never;
    await composePolicies([a, b]).onUsage?.(entry);
    expect(a.onUsage).toHaveBeenCalledWith(entry);
    expect(b.onUsage).toHaveBeenCalledWith(entry);
  });
});

describe("policyFromEnv", () => {
  it("defaults to the rate limit only", () => {
    expect(policyFromEnv({}).name).toBe("rate-limit");
    expect(DEFAULT_RATE_LIMIT_PER_MINUTE).toBe(120);
  });

  it("adds the daily cap when configured, and 0 turns a guard off", () => {
    expect(policyFromEnv({ VIBEDECKX_LLM_DAILY_COST_LIMIT_USD: "2" }).name).toBe("rate-limit+daily-cost-cap");
    expect(policyFromEnv({ VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE: "0" }).name).toBe("unlimited");
    expect(policyFromEnv({
      VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE: "0",
      VIBEDECKX_LLM_DAILY_COST_LIMIT_USD: "5",
    }).name).toBe("daily-cost-cap");
  });

  it("falls back to the default on an invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(policyFromEnv({ VIBEDECKX_LLM_RATE_LIMIT_PER_MINUTE: "lots" }).name).toBe("rate-limit");
    warn.mockRestore();
  });
});
