import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { LlmUsageEntry, Storage } from "./types.js";

const entry = (over: Partial<LlmUsageEntry> = {}): LlmUsageEntry => ({
  user_id: "u1",
  feature: "chat-session",
  provider: "gateway",
  model: "m",
  resolved_provider: "alibaba",
  key_source: "platform",
  input_tokens: 100,
  cached_input_tokens: 60,
  output_tokens: 10,
  reasoning_tokens: 0,
  cost_nanousd: 1000,
  cost_source: "actual",
  generation_id: null,
  ...over,
});

describe("llmUsage storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-llm-usage-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function insertAt(iso: string, over: Partial<LlmUsageEntry> = {}) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    await storage.llmUsage.insert(entry(over));
    vi.useRealTimers();
  }

  it("sums one user's known cost since a time, optionally by key source", async () => {
    await insertAt("2026-11-02T23:00:00.000Z", { cost_nanousd: 5 });
    await insertAt("2026-11-03T01:00:00.000Z", { cost_nanousd: 7 });
    await insertAt("2026-11-03T02:00:00.000Z", { cost_nanousd: 11, key_source: "byok" });
    await insertAt("2026-11-03T03:00:00.000Z", { cost_nanousd: null, cost_source: null });
    await insertAt("2026-11-03T04:00:00.000Z", { cost_nanousd: 13, user_id: "u2" });

    const since = new Date("2026-11-03T00:00:00.000Z");
    expect(await storage.llmUsage.costSince("u1", since)).toBe(18);
    expect(await storage.llmUsage.costSince("u1", since, "platform")).toBe(7);
    expect(await storage.llmUsage.costSince("nobody", since)).toBe(0);
    // Only the null-cost u1 row (100 in + 10 out) is unpriced.
    expect(await storage.llmUsage.unpricedTokensSince("u1", since)).toBe(110);
    expect(await storage.llmUsage.unpricedTokensSince("u1", since, "byok")).toBe(0);
  });

  it("summarizes over [from, to) by the requested keys", async () => {
    await insertAt("2026-11-02T10:00:00.000Z", { cost_nanousd: 1 });
    await insertAt("2026-11-02T11:00:00.000Z", { cost_nanousd: 2, feature: "translate" });
    await insertAt("2026-11-03T10:00:00.000Z", { cost_nanousd: null, cost_source: null });
    await insertAt("2026-11-04T00:00:00.000Z", { cost_nanousd: 100 }); // excluded: at `to`

    const from = new Date("2026-11-01T00:00:00.000Z");
    const to = new Date("2026-11-04T00:00:00.000Z");

    const [total] = await storage.llmUsage.summarize(from, to, []);
    expect(total).toEqual({
      calls: 3,
      input_tokens: 300,
      cached_input_tokens: 180,
      output_tokens: 30,
      reasoning_tokens: 0,
      cost_nanousd: 3,
      unknown_cost_calls: 1,
    });

    const byDay = await storage.llmUsage.summarize(from, to, ["day"]);
    expect(byDay.map((r) => [r.day, r.calls, r.cost_nanousd])).toEqual([
      ["2026-11-02", 2, 3],
      ["2026-11-03", 1, 0],
    ]);

    const byDayFeature = await storage.llmUsage.summarize(from, to, ["day", "feature"]);
    expect(byDayFeature.map((r) => [r.day, r.feature, r.calls])).toEqual([
      ["2026-11-02", "chat-session", 1],
      ["2026-11-02", "translate", 1],
      ["2026-11-03", "chat-session", 1],
    ]);
  });
});
