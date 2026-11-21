import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-provider.js";
import { clearMachineModelCache, listMachineModels } from "./machine-models.js";

function provider(listModels?: () => Promise<string[]>): AgentProvider {
  return { getAgentType: () => "fx", ...(listModels ? { listModels } : {}) } as unknown as AgentProvider;
}

describe("listMachineModels", () => {
  afterEach(() => { clearMachineModelCache(); vi.restoreAllMocks(); });

  it("uses the static suggestions for a provider without a listing", async () => {
    await expect(listMachineModels(provider())).resolves.toMatchObject({ models: ["spacexai/grok-4.7", "openai/gpt-5.4-mini"], source: "suggestions" });
  });

  it("returns the machine catalog and shares one CLI run across callers until the 24 h TTL", async () => {
    let t = 0;
    const list = vi.fn(async () => ["a/one", "b/two"]);
    const p = provider(list);
    const [x, y] = await Promise.all([listMachineModels(p, { now: () => t }), listMachineModels(p, { now: () => t })]);
    expect(x).toMatchObject({ models: ["a/one", "b/two"], source: "machine" });
    expect(y).toEqual(x);
    t = 23 * 60 * 60 * 1000;
    await listMachineModels(p, { now: () => t });
    expect(list).toHaveBeenCalledTimes(1);
    t = 25 * 60 * 60 * 1000;
    await listMachineModels(p, { now: () => t });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("falls back to suggestions on failure or an empty catalog, and retries a failure sooner", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    const list = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]).mockResolvedValueOnce(["c/three"]);
    const p = provider(list);
    await expect(listMachineModels(p, { now: () => t })).resolves.toMatchObject({ source: "suggestions" });
    t = 31 * 1000;
    await expect(listMachineModels(p, { now: () => t })).resolves.toMatchObject({ source: "suggestions" });
    // An empty catalog is retried on the failure TTL, not held for 5 minutes.
    t += 31 * 1000;
    await expect(listMachineModels(p, { now: () => t })).resolves.toMatchObject({ models: ["c/three"], source: "machine" });
  });

  it("refresh skips a fresh cache entry and replaces it", async () => {
    const list = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(["old/model"]).mockResolvedValueOnce(["new/model"]);
    const p = provider(list);
    await listMachineModels(p);
    await expect(listMachineModels(p)).resolves.toMatchObject({ models: ["old/model"], source: "machine" });
    await expect(listMachineModels(p, { refresh: true })).resolves.toMatchObject({ models: ["new/model"], source: "machine" });
    await expect(listMachineModels(p)).resolves.toMatchObject({ models: ["new/model"], source: "machine" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refresh joins a run already in flight instead of starting another", async () => {
    let finish!: (models: string[]) => void;
    const list = vi.fn(() => new Promise<string[]>((r) => { finish = r; }));
    const p = provider(list);
    const first = listMachineModels(p);
    const refreshed = listMachineModels(p, { refresh: true });
    finish(["a/one"]);
    const [a, b] = await Promise.all([first, refreshed]);
    expect(a).toMatchObject({ models: ["a/one"], source: "machine" });
    expect(b).toEqual(a);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("tells each caller how long the entry it got has left, on its own clock", async () => {
    let t = 1_000;
    const p = provider(vi.fn(async () => ["a/one"]));
    await expect(listMachineModels(p, { now: () => t })).resolves.toMatchObject({ expiresInMs: 24 * 60 * 60 * 1000 });
    t += 60 * 60 * 1000;
    await expect(listMachineModels(p, { now: () => t })).resolves.toMatchObject({ expiresInMs: 23 * 60 * 60 * 1000 });
  });

  it("a fallback answer expires on the failure TTL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = provider(vi.fn(async () => { throw new Error("offline"); }));
    await expect(listMachineModels(p, { now: () => 0 })).resolves.toMatchObject({ source: "suggestions", expiresInMs: 30 * 1000 });
    await expect(listMachineModels(provider(), { now: () => 0 })).resolves.toMatchObject({ source: "suggestions", expiresInMs: 30 * 1000 });
  });
});
