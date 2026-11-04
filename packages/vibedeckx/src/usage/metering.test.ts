import { describe, expect, it } from "vitest";
import { buildUsageEntry, usdToNano } from "./metering.js";
import type { LlmCallMeta } from "./types.js";

const meta = (over: Partial<LlmCallMeta> = {}): LlmCallMeta => ({
  userId: "u1",
  feature: "chat-session",
  provider: "gateway",
  model: "deepseek/deepseek-v4-flash-0731",
  keySource: "platform",
  ...over,
});

const usage = {
  inputTokens: { total: 19323, noCache: 891, cacheRead: 18432, cacheWrite: 0 },
  outputTokens: { total: 161, text: 150, reasoning: 11 },
};

describe("usdToNano", () => {
  it("converts decimal strings digit-wise", () => {
    expect(usdToNano("0.001415568")).toBe(1_415_568);
    expect(usdToNano("2")).toBe(2_000_000_000);
    expect(usdToNano("0.0000000015")).toBe(2); // rounds the 10th digit
  });

  it("accepts numbers and rejects junk", () => {
    expect(usdToNano(0.25)).toBe(250_000_000);
    expect(usdToNano("1e-6")).toBe(1000);
    expect(usdToNano("n/a")).toBeNull();
    expect(usdToNano(undefined)).toBeNull();
    expect(usdToNano(-1)).toBeNull();
  });
});

describe("buildUsageEntry", () => {
  it("takes the AI Gateway's billed cost and routing as actual", () => {
    const entry = buildUsageEntry(meta(), usage, {
      gateway: {
        cost: "0.001415568",
        routing: { resolvedProvider: "alibaba" },
        generationId: "gen_1",
      },
    });
    expect(entry).toMatchObject({
      user_id: "u1",
      feature: "chat-session",
      input_tokens: 19323,
      cached_input_tokens: 18432,
      output_tokens: 161,
      reasoning_tokens: 11,
      cost_nanousd: 1_415_568,
      cost_source: "actual",
      resolved_provider: "alibaba",
      generation_id: "gen_1",
      key_source: "platform",
    });
  });

  it("takes OpenRouter's reported usage cost", () => {
    const entry = buildUsageEntry(meta({ provider: "openrouter" }), usage, {
      openrouter: { usage: { cost: 0.0004 }, provider: "DeepInfra" },
    });
    expect(entry).toMatchObject({ cost_nanousd: 400_000, cost_source: "actual", resolved_provider: "DeepInfra" });
  });

  it("estimates from the price table when the provider reports no cost", () => {
    const entry = buildUsageEntry(meta({ provider: "deepseek", model: "deepseek-v4-flash" }), usage, undefined);
    // 891 miss × 0.14 + 18432 hit × 0.0028 + 161 out × 0.28, per 1M tokens
    expect(entry.cost_source).toBe("estimated");
    expect(entry.cost_nanousd).toBe(Math.round((891 * 0.14 + 18432 * 0.0028 + 161 * 0.28) * 1000));
  });

  it("leaves cost unknown for an unpriced model without a provider report", () => {
    const entry = buildUsageEntry(meta({ provider: "deepseek", model: "deepseek-v4-pro" }), usage, undefined);
    expect(entry.cost_nanousd).toBeNull();
    expect(entry.cost_source).toBeNull();
  });

  it("tolerates missing usage", () => {
    const entry = buildUsageEntry(meta(), undefined, undefined);
    expect(entry).toMatchObject({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  });
});
