import { describe, expect, it } from "vitest";
import { runClaudeSession, runCodexAppServer } from "./runner.js";

const FAKE = new URL("./fake-cli.mjs", import.meta.url).pathname;

function fakeSpawn(mode: string) {
  return { command: process.execPath, args: [FAKE, mode] };
}

describe("runner (offline, fake CLI)", () => {
  it("collects a claude session: text, tool_use, result", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("claude-basic"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const types = r.messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types[types.length - 1]).toBe("result");
    expect(r.contractFailures).toEqual([]);
  });

  it("multi-turn: sends the second turn after the first result", async () => {
    const r = await runClaudeSession({ turns: ["one", "two"], spawnOverride: fakeSpawn("claude-multiturn"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const results = r.messages.filter((m) => (m as { type: string }).type === "result");
    expect(results.length).toBe(2);
  });

  it("flags a contract violation when a consumed field changes type", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("claude-drift"), timeoutMs: 10_000 });
    expect(r.contractFailures.length).toBeGreaterThan(0);
    expect(r.contractFailures[0].contractId).toContain("CC-OUT");
  });

  it("classifies auth failure from stderr before any protocol line", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("auth-fail"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("auth_error");
  });

  it("times out when the CLI hangs", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("hang"), timeoutMs: 1_500 });
    expect(r.outcome).toBe("timeout");
  });

  it("drives a codex handshake and turn to completion", async () => {
    const r = await runCodexAppServer({ turns: ["hello"], spawnOverride: fakeSpawn("codex-basic"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    expect(r.threadId).toBe("t-fake");
    const methods = r.incoming.filter((i) => i.kind === "notification").map((i) => (i as { method: string }).method);
    expect(methods).toContain("item/completed");
    expect(methods).toContain("turn/completed");
    expect(r.contractFailures).toEqual([]);
  });

  it("codex multi-turn: second turn's completion is not pre-matched by the first's", async () => {
    // Pins the turn-loop count fix: with a naive "any turn/completed"
    // predicate, waitFor's pre-scan over already-received lines would match
    // turn 1's completion instantly on turn 2's wait and kill the process
    // before turn 2 ever ran (only ONE turn/completed would show up here).
    const r = await runCodexAppServer({ turns: ["one", "two"], spawnOverride: fakeSpawn("codex-basic"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const completions = r.incoming.filter((i) => i.kind === "notification" && i.method === "turn/completed");
    expect(completions.length).toBe(2);
  });

  it("codex drain() does not drop byte-identical duplicate protocol lines", async () => {
    // Pins the drain() cursor fix: the old content-keyed `seen: Set<string>`
    // dropped byte-identical duplicate lines from `incoming` entirely.
    const r = await runCodexAppServer({ turns: ["hello"], spawnOverride: fakeSpawn("codex-duplicate-line"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const itemCompletions = r.incoming.filter((i) => i.kind === "notification" && i.method === "item/completed");
    expect(itemCompletions.length).toBe(2);
  });
});
