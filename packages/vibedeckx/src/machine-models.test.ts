import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-provider.js";
import { clearMachineModelCache, listMachineModels } from "./machine-models.js";

function provider(listModels?: () => Promise<string[]>): AgentProvider {
  return { getAgentType: () => "fx", ...(listModels ? { listModels } : {}) } as unknown as AgentProvider;
}

describe("listMachineModels", () => {
  afterEach(() => { clearMachineModelCache(); vi.restoreAllMocks(); });

  it("uses the static suggestions for a provider without a listing", async () => {
    await expect(listMachineModels(provider())).resolves.toEqual({ models: ["spacexai/grok-4.7", "openai/gpt-5.4-mini"], source: "suggestions" });
  });

  it("returns the machine catalog and shares one CLI run across callers until the TTL", async () => {
    let t = 0;
    const list = vi.fn(async () => ["a/one", "b/two"]);
    const p = provider(list);
    const [x, y] = await Promise.all([listMachineModels(p, () => t), listMachineModels(p, () => t)]);
    expect(x).toEqual({ models: ["a/one", "b/two"], source: "machine" });
    expect(y).toBe(x);
    t = 4 * 60 * 1000;
    await listMachineModels(p, () => t);
    expect(list).toHaveBeenCalledTimes(1);
    t = 6 * 60 * 1000;
    await listMachineModels(p, () => t);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("falls back to suggestions on failure or an empty catalog, and retries a failure sooner", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    const list = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]).mockResolvedValueOnce(["c/three"]);
    const p = provider(list);
    await expect(listMachineModels(p, () => t)).resolves.toMatchObject({ source: "suggestions" });
    t = 31 * 1000;
    await expect(listMachineModels(p, () => t)).resolves.toMatchObject({ source: "suggestions" });
    // An empty catalog is retried on the failure TTL, not held for 5 minutes.
    t += 31 * 1000;
    await expect(listMachineModels(p, () => t)).resolves.toEqual({ models: ["c/three"], source: "machine" });
  });
});
