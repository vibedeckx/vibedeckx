import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import { dailyCostCapPolicy } from "./policies.js";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Storage, LlmUsageEntry } from "../storage/types.js";
import { usageMiddleware } from "./middleware.js";
import { setUsagePolicy } from "./policy-registry.js";
import { UsageLimitError, type LlmCallMeta } from "./types.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 100, noCache: 40, cacheRead: 60, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const gatewayMeta = { gateway: { cost: "0.000002", routing: { resolvedProvider: "alibaba" } } };

const meta: LlmCallMeta = {
  userId: "u1",
  feature: "chat-session",
  provider: "gateway",
  model: "m",
  keySource: "platform",
};

function fakeStorage() {
  const rows: LlmUsageEntry[] = [];
  const storage = {
    llmUsage: {
      insert: vi.fn(async (entry: LlmUsageEntry) => { rows.push(entry); }),
      costSince: vi.fn(async () => 0),
      unpricedTokensSince: vi.fn(async () => 0),
      summarize: vi.fn(),
    },
  } as unknown as Storage;
  return { storage, rows };
}

const streamingModel = () => new MockLanguageModelV3({
  doStream: async () => ({
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          providerMetadata: gatewayMeta,
        });
        controller.close();
      },
    }),
  }),
});

const generatingModel = () => new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: "text", text: "hi" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    providerMetadata: gatewayMeta,
    warnings: [],
  }),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setUsagePolicy(undefined));

describe("usageMiddleware", () => {
  it("records one ledger row per generate call", async () => {
    const { storage, rows } = fakeStorage();
    const model = wrapLanguageModel({ model: generatingModel(), middleware: usageMiddleware(meta, storage) });
    await generateText({ model, prompt: "x" });
    await flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input_tokens: 100, cached_input_tokens: 60, cost_nanousd: 2000, cost_source: "actual" });
  });

  it("records a stream's usage from its finish part", async () => {
    const { storage, rows } = fakeStorage();
    const model = wrapLanguageModel({ model: streamingModel(), middleware: usageMiddleware(meta, storage) });
    const result = streamText({ model, prompt: "x" });
    expect(await result.text).toBe("hi");
    await flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolved_provider: "alibaba", output_tokens: 10 });
  });

  it("denies before calling the provider and surfaces the policy's message", async () => {
    const { storage, rows } = fakeStorage();
    setUsagePolicy({ name: "deny", check: () => ({ allow: false, reason: "daily_cost_limit", message: "Limit reached." }) });
    const inner = generatingModel();
    const model = wrapLanguageModel({ model: inner, middleware: usageMiddleware(meta, storage) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await generateText({ model, prompt: "x" }).catch((e: unknown) => e);
    warn.mockRestore();
    expect(error).toBeInstanceOf(UsageLimitError);
    expect((error as UsageLimitError).message).toBe("Limit reached.");
    expect(inner.doGenerateCalls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("lets the call through when the policy itself fails", async () => {
    const { storage, rows } = fakeStorage();
    setUsagePolicy({ name: "broken", check: () => { throw new Error("boom"); } });
    const model = wrapLanguageModel({ model: generatingModel(), middleware: usageMiddleware(meta, storage) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { text } = await generateText({ model, prompt: "x" });
    await flush();
    warn.mockRestore();
    expect(text).toBe("hi");
    expect(rows).toHaveLength(1);
  });

  it("does not fail the call when recording fails, and tells the policy about recorded usage", async () => {
    const { storage } = fakeStorage();
    const onUsage = vi.fn();
    setUsagePolicy({ name: "watch", check: () => ({ allow: true }), onUsage });
    const model = wrapLanguageModel({ model: generatingModel(), middleware: usageMiddleware(meta, storage) });
    await generateText({ model, prompt: "x" });
    await flush();
    expect(onUsage).toHaveBeenCalledTimes(1);

    vi.mocked(storage.llmUsage.insert).mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { text } = await generateText({ model, prompt: "x" });
    await flush();
    warn.mockRestore();
    expect(text).toBe("hi");
  });

  it("meters an unpriced model into the ledger and the daily cap then denies (real storage)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-usage-cap-"));
    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    try {
      setUsagePolicy(dailyCostCapPolicy({ usd: 2 }));
      // Direct DeepSeek reports no cost and deepseek-v4-pro has no price entry.
      const unpriced: LlmCallMeta = { ...meta, provider: "deepseek", model: "deepseek-v4-pro" };
      const big = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "hi" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 },
          },
          warnings: [],
        }),
      });
      const model = wrapLanguageModel({ model: big, middleware: usageMiddleware(unpriced, storage) });

      await generateText({ model, prompt: "x" });
      await flush();
      const [row] = await storage.llmUsage.summarize(new Date(0), new Date(Date.now() + 1000), []);
      expect(row).toMatchObject({ calls: 1, unknown_cost_calls: 1 });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = await generateText({ model, prompt: "x" }).catch((e: unknown) => e);
      warn.mockRestore();
      expect(error).toBeInstanceOf(UsageLimitError);
      expect((error as UsageLimitError).reason).toBe("daily_cost_limit");
      expect(big.doGenerateCalls).toHaveLength(1);
    } finally {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
