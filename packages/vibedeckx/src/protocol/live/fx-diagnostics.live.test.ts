import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AgentSessionManager } from "../../agent-session-manager.js";
import { createSqliteStorage } from "../../storage/sqlite.js";
import type { Storage } from "../../storage/types.js";
import type { AgentMessage } from "../../agent-types.js";
import { getProvider } from "../../providers/index.js";

const provider = getProvider("fx");
const binary = provider.detectBinary();
// Opt-in real CLI coverage; never changes or copies the user's credentials.
describe.skipIf(!binary)("fx model and authentication product lifecycle", () => {
  let dir: string, storage: Storage, manager: AgentSessionManager;
  const entries = async (id: string): Promise<AgentMessage[]> => (await storage.agentSessions.getEntries(id)).map(e => JSON.parse(e.data));
  const waitFor = async (fn: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 60000;
    while (!await fn()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for fx");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fx-diagnostics-live-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    manager.suppressTitleGeneration = true;
  });
  afterEach(async () => {
    for (const row of await storage.agentSessions.getAll()) await manager.stopSessionAndWait(row.id);
    await manager.shutdown(); await storage.close(); vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  it("shows an actionable login error and stops a real unauthenticated ACP process", async () => {
    const build = provider.buildSpawnConfig.bind(provider);
    vi.spyOn(provider, "buildSpawnConfig").mockImplementation((...args) => {
      const config = build(...args);
      // Empty values override inherited secrets without mutating the parent environment.
      const env = Object.fromEntries(Object.keys(process.env)
        .filter(key => /TOKEN|API_KEY|SECRET|^FX_|^XDG_/i.test(key)).map(key => [key, ""]));
      return { ...config, env: { ...env, ...config.env, HOME: dir,
        XDG_CONFIG_HOME: join(dir, ".config"), XDG_DATA_HOME: join(dir, ".local/share"), XDG_CACHE_HOME: join(dir, ".cache") } };
    });
    const id = await manager.createNewSession("p", null, dir, false, "edit", "fx");
    await waitFor(async () => (await entries(id)).some(e => e.type === "error" && e.message.includes("fx is not logged in")));
    await waitFor(() => manager.getSession(id)?.process === null);
    expect(manager.getSession(id)?.status).not.toBe("running");
    expect((await entries(id)).some(e => e.type === "error" && e.message.includes("fx login vercel"))).toBe(true);
  });
  it("uses the configured default, then respawns with a selected model and preserves model errors", async () => {
    const spawn = vi.spyOn(provider, "buildSpawnConfig");
    const id = await manager.createNewSession("p", null, dir, false, "edit", "fx");
    expect(spawn.mock.results[0].value.args).not.toContain("--model");
    await manager.sendUserMessage(id, "Reply with exactly FX_DEFAULT_OK. Do not use tools.", dir);
    await waitFor(async () => (await entries(id)).filter(e => e.type === "turn_end").length === 1);
    expect((await entries(id)).filter(e => e.type === "error")).toEqual([]);
    expect(await manager.setModel(id, "openai/gpt-5.4-mini")).toBe("ok");
    await manager.sendUserMessage(id, "Reply with exactly FX_MODEL_OK. Do not use tools.", dir);
    await waitFor(async () => (await entries(id)).filter(e => e.type === "turn_end").length === 2);
    expect(spawn.mock.results.at(-1)?.value.args).toContain("openai/gpt-5.4-mini");
    expect((await entries(id)).filter(e => e.type === "error")).toEqual([]);
    expect(await manager.setModel(id, "vibedeckx/invalid-model-task10")).toBe("ok");
    await manager.sendUserMessage(id, "Reply OK", dir);
    await waitFor(async () => (await entries(id)).some(e => e.type === "error"));
    await waitFor(() => manager.getSession(id)?.status !== "running");
    const errors = (await entries(id)).filter(e => e.type === "error");
    expect(errors.some(e => e.type === "error" && e.message.includes("fx is not logged in"))).toBe(false);
    // fx 0.0.17 emits the HTTP/model error as assistant text, then stopReason=error.
    expect((await entries(id)).some(e => e.type === "assistant" && e.content.includes("vibedeckx/invalid-model-task10") && e.content.includes("not found"))).toBe(true);
  });
});
