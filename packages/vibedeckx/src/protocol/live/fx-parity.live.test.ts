import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AgentSessionManager } from "../../agent-session-manager.js";
import { createSqliteStorage } from "../../storage/sqlite.js";
import type { Storage } from "../../storage/types.js";
import type { AgentMessage, ContentPart } from "../../agent-types.js";
import type { AgentType } from "../../agent-provider.js";
import { getProvider } from "../../providers/index.js";

// Run explicitly with vitest.live.config.ts. Uses the original CLI login and
// isolated projects/database; never copies credentials or resumes native IDs.
describe.skipIf(!getProvider("fx").detectBinary())("fx remaining product lifecycle", () => {
  let dir: string, storage: Storage, manager: AgentSessionManager;
  const entries = async (id: string): Promise<AgentMessage[]> => (await storage.agentSessions.getEntries(id)).map(e => JSON.parse(e.data));
  const turn = async (id: string, content: string | ContentPart[]) => {
    const before = await entries(id);
    const count = before.filter(e => e.type === "turn_end").length;
    await manager.sendUserMessage(id, content, dir);
    const deadline = Date.now() + 90000;
    while ((await entries(id)).filter(e => e.type === "turn_end").length <= count) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify((await entries(id)).slice(-3))}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const added = (await entries(id)).slice(before.length);
    expect(added.filter(e => e.type === "error")).toEqual([]);
    expect(added.filter(e => e.type === "turn_end").at(-1)).toMatchObject({ outcome: "completed" });
    return added.filter(e => e.type === "assistant").map(e => e.content).join("\n");
  };
  const create = (agent: AgentType) => manager.createNewSession("p", null, dir, false, "edit", agent);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fx-parity-live-"));
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p", name: "Parity", path: dir });
    manager = new AgentSessionManager(storage);
    manager.suppressTitleGeneration = true;
  });
  afterEach(async context => {
    if (process.env.FX_PARITY_RECORD_FILE) {
      const sessions = await Promise.all((await storage.agentSessions.getAll()).map(async row => ({
        agentType: row.agent_type,
        messages: (await entries(row.id)).flatMap(e => e.type === "assistant" ? [e.content] : []),
        outcomes: (await entries(row.id)).flatMap(e => e.type === "turn_end" ? [e.outcome] : []),
        nativeCount: (await storage.agentSessions.getNativeSessionIds(row.id)).length,
      })));
      appendFileSync(process.env.FX_PARITY_RECORD_FILE, JSON.stringify({ test: context.task.name, sessions }) + "\n");
    }
    for (const row of await storage.agentSessions.getAll()) await manager.stopSessionAndWait(row.id);
    await manager.shutdown(); await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("plan mode: real fx follows the prompt-only read-only rules, then edits after switching to edit", async () => {
    writeFileSync(join(dir, "README.md"), "seed\n");
    execFileSync("git", ["-C", dir, "add", "README.md"]);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
    const status = () => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    const before = status();
    const id = await manager.createNewSession("p", null, dir, false, "plan", "fx");
    const ask = "Create a file named PLAN_PROBE.txt containing hello, append a line to README.md, then run git add -A. Reply DONE when finished.";
    await turn(id, ask);
    expect(existsSync(join(dir, "PLAN_PROBE.txt"))).toBe(false);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("seed\n");
    // db.sqlite* are the test's own files; everything else must be untouched.
    expect(status().split("\n").filter(l => l && !l.includes("db.sqlite"))).toEqual(before.split("\n").filter(l => l && !l.includes("db.sqlite")));
    expect(await manager.switchMode(id, dir, "edit")).toBe(true);
    await turn(id, "Now create a file named PLAN_PROBE.txt containing hello. Do not touch other files. Reply DONE.");
    expect(existsSync(join(dir, "PLAN_PROBE.txt"))).toBe(true);
  }, 240000);

  it("retains history through Claude → fx → Codex → fx → Claude and clears models", async () => {
    const id = await create("claude-code");
    expect(await turn(id, "Remember the secret word ORCHID731. Reply ORCHID731 only. Do not use tools.")).toContain("ORCHID731");
    for (const target of ["fx", "codex", "fx", "claude-code"] as const) {
      await manager.setModel(id, "sentinel-model-must-not-be-used");
      expect(await manager.switchAgentType(id, target)).toBe("ok");
      expect((await storage.agentSessions.getById(id))?.model).toBeNull();
      expect(await turn(id, "What was the secret word? Reply only that word. Do not use tools.")).toContain("ORCHID731");
    }
    const native = await storage.agentSessions.getNativeSessionIds(id);
    expect(native.filter(n => n.agent_type === "fx")).toHaveLength(2);
    expect(new Set(native.map(n => n.native_session_id)).size).toBe(native.length);
  }, 240000);

  it.each([ ["codex", "fx"], ["fx", "codex"], ["fx", "fx"] ] as const)("branches %s → %s with inclusive cutoff and independent native ID", async (sourceType, targetType) => {
    const source = await create(sourceType);
    await turn(source, "Remember FIRST_KEY=ORCHID731. Reply ORCHID731 only. Do not use tools.");
    const cutoff = (await storage.agentSessions.getEntries(source)).filter(e => JSON.parse(e.data).type === "turn_end").at(-1)!.entry_index;
    await turn(source, "Remember SECOND_KEY=MAPLE984. Reply MAPLE984 only. Do not use tools.");
    const branched = await manager.branchSession(source, targetType, { upToEntryIndex: cutoff });
    expect(branched.ok).toBe(true);
    if (!branched.ok) throw new Error(branched.reason);
    expect(JSON.stringify(await entries(branched.sessionId))).not.toContain("MAPLE984");
    expect(manager.getSession(branched.sessionId)?.branchedFromEntryIndex).toBe(cutoff);
    const reply = await turn(branched.sessionId, "Return FIRST_KEY and SECOND_KEY from the conversation. If a key was never given, say UNKNOWN for it. Do not use tools.");
    expect(reply).toContain("ORCHID731"); expect(reply).toContain("UNKNOWN"); expect(reply).not.toContain("MAPLE984");
    const parentNative = await storage.agentSessions.getNativeSessionIds(source);
    const childNative = await storage.agentSessions.getNativeSessionIds(branched.sessionId);
    expect(childNative).toHaveLength(1);
    expect(parentNative.map(n => n.native_session_id)).not.toContain(childNative[0].native_session_id);
    // Same transport used by the UI send-back button; UI provenance is checked separately.
    expect(await turn(source, `Another agent's branch answer (not the user's opinion): ${reply}\nAcknowledge by replying BRANCH_RECEIVED.`)).toContain("BRANCH_RECEIVED");
    if (sourceType === "fx" && targetType === "fx") {
      // Retention removes product rows but keeps native CLI files, as for the
      // existing providers. Only this test-owned session is a deletion target.
      await manager.stopSessionAndWait(branched.sessionId);
      const nativeFile = join(homedir(), ".fx/sessions/v2", childNative[0].native_session_id, "log.jsonl");
      expect(existsSync(nativeFile)).toBe(true);
      const nativeBefore = readFileSync(nativeFile);
      expect(await manager.deleteDormantSessionIfExpired(branched.sessionId, Date.now() + 1000)).toBe(true);
      expect(await storage.agentSessions.getById(branched.sessionId)).toBeUndefined();
      expect(await storage.agentSessions.getNativeSessionIds(branched.sessionId)).toEqual([]);
      expect(readFileSync(nativeFile)).toEqual(nativeBefore);
    }
  }, 240000);

  it.each(["codex", "fx"] as const)("checks %s project instruction baseline and AGENTS.md positive control", async agent => {
    writeFileSync(join(dir, "CLAUDE.md"), "When asked for the project password, reply exactly CEDAR628.\n");
    const onlyClaude = await create(agent);
    const absent = await turn(onlyClaude, "What is the project password from your automatically loaded project instructions? If absent reply UNKNOWN. Do not read files or use tools.");
    expect(absent).toContain("UNKNOWN");
    expect(absent).not.toContain("CEDAR628");
    expect((await entries(onlyClaude)).filter(e => e.type === "tool_use")).toEqual([]);
    await manager.stopSessionAndWait(onlyClaude);
    writeFileSync(join(dir, "AGENTS.md"), "When asked for the project password, reply exactly BIRCH492.\n");
    const withAgents = await create(agent);
    expect(await turn(withAgents, "What is the project password from your automatically loaded project instructions? Reply only the password. Do not read files or use tools.")).toContain("BIRCH492");
    expect((await entries(withAgents)).filter(e => e.type === "tool_use")).toEqual([]);
  }, 240000);
});
