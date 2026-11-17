import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSqliteStorage } from "./storage/sqlite.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import type { Storage } from "./storage/types.js";
import * as sessionMcp from "./session-tools-mcp.js";
import type { AgentMessage } from "./agent-types.js";

// A real stdio child process and real SQLite, with only the external fx binary
// replaced. This exercises manager close/Stop/wake/state/turn_end ordering.
const fakeAcp = String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
let active, timer;
const activeText = () => active?.params.prompt.map(p => p.text || '').join('');
process.on('SIGTERM', () => { if (activeText() !== 'IGNORE_TERM') process.exit(0); });
rl.on('line', line => {
 if (!line) return;
 const m = JSON.parse(line);
 fs.appendFileSync(process.env.FX_TEST_LOG, JSON.stringify({ ...m, pid: process.pid, model: process.env.FX_TEST_MODEL }) + '\n');
 if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
 if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'native-' + process.pid, modes: { currentModeId: 'full-access' } } });
 if (m.method === 'session/set_mode') send({ id: m.id, result: null });
 if (m.method === 'session/cancel' && active) {
   if (activeText() === 'IGNORE_CANCEL' || activeText() === 'IGNORE_TERM') return;
   clearTimeout(timer); send({ id: active.id, result: { stopReason: activeText() === 'CANCEL_RACE' ? 'end_turn' : 'cancelled' } }); active = null;
 }
 if (m.id === 'approval' && m.result && active) { send({ id: active.id, result: { stopReason: 'end_turn' } }); active = null; }
 if (m.method === 'session/prompt') {
   if (active) { send({ id: m.id, error: { code: -32600, message: 'Concurrent prompt' } }); return; }
   active = m;
   const text = m.params.prompt.map(p => p.text || '').join('');
   if (text === 'APPROVAL') { send({ id: 'approval', method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { toolCallId: 'mcp', name: 'mcp_vibedeckx_propose_task', rawInput: { tasks: [] } }, options: [{ optionId: 'deny', kind: 'reject_once' }] } }); return; }
   if (text.startsWith('TOOLS_')) {
     for (const name of ['shell', 'subagent']) send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: name, name, rawInput: { action: 'run', command: 'sleep 30' }, status: 'in_progress' } } });
     if (text === 'TOOLS_ERROR') { send({ id: m.id, error: { code: -32000, message: 'Failed with tools in progress' } }); active = null; return; }
   }
   if (text === 'IGNORE_CANCEL' || text === 'IGNORE_TERM') return;
   if (text === 'PROMPT_ERROR') { send({ id: m.id, error: { code: -32000, message: 'Rate limit' } }); active = null; return; }
   if (text === 'CRASH') { process.exit(1); }
   if (text === 'MALFORMED') { process.stdout.write('broken-json\n'); return; }
   timer = setTimeout(() => {
     if (text === 'TOOLS_REPORT' || text === 'LATE_REPORT') {
       for (const text of ['Sent to child', 'CHILD_DONE', 'CHILD_DONE']) send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'subagent', status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] } } });
     }
     for (const [kind, text] of [['agent_thought_chunk', 'think '], ['agent_thought_chunk', 'more'], ['agent_message_chunk', 'ans'], ['agent_message_chunk', 'wer']]) {
       send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } } });
     }
     send({ id: m.id, result: { stopReason: 'end_turn' } }); active = null;
   }, text === 'TOOLS_CANCEL' || text === 'HOLD' || text === 'CANCEL_RACE' ? 2000 : 20);
 }
});
`;

describe("fx manager lifecycle", () => {
  let dir: string, storage: Storage, manager: AgentSessionManager, log: string;
  const provider = getProvider("fx");
  const waitFor = async (fn: () => Promise<boolean> | boolean) => {
    const end = Date.now() + 5000;
    while (!await fn()) {
      if (Date.now() > end) throw new Error("Timed out waiting for manager state");
      await new Promise(r => setTimeout(r, 10));
    }
  };
  const entries = async (id: string): Promise<AgentMessage[]> => (await storage.agentSessions.getEntries(id)).map(e => JSON.parse(e.data));
  const wire = (): Array<{ method: string; pid: number; model: string; params: { sessionId?: string; prompt?: Array<{ text: string }> } }> => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };
  const newSession = () => manager.createNewSession("p", null, dir, false, "edit", "fx", false, false, { model: "old-model" });
  const completed = (id: string, count: number) => waitFor(async () => (await entries(id)).filter(e => e.type === "turn_end").length === count);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fx-manager-")); log = join(dir, "wire.jsonl");
    execFileSync("git", ["init", "-q", dir]);
    storage = await createSqliteStorage(join(dir, "db.sqlite"));
    await storage.projects.create({ id: "p", name: "p", path: dir });
    manager = new AgentSessionManager(storage);
    manager.suppressTitleGeneration = true;
    vi.spyOn(provider, "buildSpawnConfig").mockImplementation((_cwd, _mode, _cross, model) => ({ command: process.execPath, args: ["-e", fakeAcp], env: { FX_TEST_LOG: log, FX_TEST_MODEL: model ?? "default" } }));
  });
  afterEach(async () => { for (const row of await storage.agentSessions.getAll()) await manager.stopSessionAndWait(row.id); await manager.shutdown(); await storage.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it("passes freshly minted MCP configuration through initialization on each spawn", async () => {
    manager.hostsSessionTools = true;
    manager.localApiOrigin = "http://127.0.0.1:9999";
    const mint = vi.spyOn(sessionMcp, "mintSessionToolsMcpConfig")
      .mockResolvedValueOnce({ url: "http://127.0.0.1:9999/api/session-mcp", token: "first-token" })
      .mockResolvedValueOnce({ url: "http://127.0.0.1:9999/api/session-mcp", token: "renewed-token" });
    const init = vi.spyOn(provider, "getInitializationMessages");
    const id = await newSession();
    await manager.sendUserMessage(id, "first", dir); await completed(id, 1);
    await (manager as unknown as { hibernateSession(id: string): Promise<boolean> }).hibernateSession(id);
    await manager.sendUserMessage(id, "wake", dir); await completed(id, 2);
    expect(mint).toHaveBeenCalledTimes(2);
    const tokens = init.mock.calls.filter(c => c[1]).map(c => c[1]?.sessionToolsMcp?.token);
    expect(tokens).toEqual(["first-token", "renewed-token"]);
    const requests = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(m => m.method === "session/new");
    expect(requests.map(m => m.params.mcpServers[0].headers[0].value)).toEqual(["Bearer first-token", "Bearer renewed-token"]);
  });

  it("cancels unexpected fx approval requests and records an error without a card", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "APPROVAL", dir);
    await completed(id, 1);
    const history = await entries(id);
    expect(history.some(e => e.type === "error" && e.message.includes("full-access"))).toBe(true);
    expect(history.some(e => e.type === "approval_request")).toBe(false);
    const messages = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(messages.find(m => m.id === "approval").result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it.each(["TOOLS_SUCCESS", "TOOLS_CANCEL", "TOOLS_ERROR"])("returns to stopped after tools were in progress: %s", async scenario => {
    const id = await newSession();
    await manager.sendUserMessage(id, scenario, dir);
    await waitFor(async () => (await entries(id)).filter(e => e.type === "tool_use").length === 2);
    if (scenario === "TOOLS_CANCEL") await manager.stopSession(id, { interruptOnly: true });
    await completed(id, 1);
    expect(manager.getSession(id)?.status).toBe("stopped");
    expect((await entries(id)).filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual([scenario === "TOOLS_SUCCESS" ? "completed" : scenario === "TOOLS_CANCEL" ? "stopped" : "failed"]);
    await manager.sendUserMessage(id, "next", dir);
    await completed(id, 2);
    expect(manager.getSession(id)?.status).toBe("stopped");
  });

  it("persists the late child report in the same result card", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "TOOLS_REPORT", dir);
    await completed(id, 1);
    const results = (await entries(id)).filter(e => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool: "Agent", toolUseId: "subagent", output: "CHILD_DONE" });
    expect(manager.getSession(id)?.status).toBe("stopped");
  });

  it("preserves the original tool cards in storage when reports arrive in the next turn after cancellation", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "TOOLS_CANCEL", dir);
    await waitFor(async () => (await entries(id)).filter(e => e.type === "tool_use").length === 2);
    await manager.stopSession(id, { interruptOnly: true });
    await completed(id, 1);
    const originalCalls = (await entries(id)).filter(e => e.type === "tool_use");
    await manager.sendUserMessage(id, "LATE_REPORT", dir);
    await completed(id, 2);
    const persisted = await entries(id);
    expect(persisted.filter(e => e.type === "tool_use")).toEqual(originalCalls);
    expect(persisted.filter(e => e.type === "tool_result")).toEqual([
      expect.objectContaining({ tool: "Agent", toolUseId: "subagent", output: "CHILD_DONE" }),
    ]);
    expect(persisted.filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual(["stopped", "completed"]);
    expect(manager.getSession(id)?.status).toBe("stopped");
  });

  it("queues turns with distinct end markers, keeps Stop's process and permits a following turn", async () => {
    const turnWrites = vi.spyOn(storage.agentSessions, "upsertTurnEndWithOutbox");
    const id = await newSession();
    await manager.sendUserMessage(id, "one", dir);
    await manager.sendUserMessage(id, "two", dir);
    await completed(id, 2);
    expect((await entries(id)).filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual(["completed", "completed"]);
    expect((await entries(id)).filter(e => e.type === "assistant").map(e => e.content)).toEqual(["answer", "answer"]);
    expect((await entries(id)).filter(e => e.type === "thinking").map(e => e.content)).toEqual(["think more", "think more"]);
    await manager.sendUserMessage(id, "HOLD", dir);
    await waitFor(() => wire().filter(m => m.method === "session/prompt").length === 3);
    await manager.stopSession(id, { interruptOnly: true });
    await completed(id, 3);
    const stoppedEntries = await entries(id);
    expect(stoppedEntries.filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual(["completed", "completed", "stopped"]);
    expect(stoppedEntries.some(e => e.type === "error")).toBe(false);
    const cancelledWrite = turnWrites.mock.calls.find(([write]) => JSON.parse(write.entryData).outcome === "stopped");
    expect(cancelledWrite?.[0].outbox).toBeUndefined();
    expect(stoppedEntries.some(e => e.type === "system" && e.content === "Session stopped by user.")).toBe(true);
    await manager.sendUserMessage(id, "after cancel", dir);
    await completed(id, 4);
    expect(new Set(wire().map(m => m.pid)).size).toBe(1);
    expect(wire().some(m => m.method === "session/cancel")).toBe(true);
    expect(manager.getSession(id)?.status).toBe("stopped");
  });
  it.each([true, false])("mirrors stopped branch activity to remote subscribers (interruptOnly=%s)", async interruptOnly => {
    const id = await newSession();
    const frames: Array<{ branchActivity?: { activity: string; since: number } }> = [];
    const socket = { send: (raw: string) => frames.push(JSON.parse(raw)) } as unknown as Parameters<typeof manager.subscribe>[1];
    const unsubscribe = await manager.subscribe(id, socket);
    try {
      await manager.sendUserMessage(id, "HOLD", dir);
      await waitFor(() => wire().some(m => m.method === "session/prompt"));
      await manager.stopSession(id, { interruptOnly });
      await completed(id, 1);
      await waitFor(() => frames.some(frame => frame.branchActivity?.activity === "stopped"));
      const stopped = frames.filter(frame => frame.branchActivity?.activity === "stopped");
      expect(stopped).toHaveLength(1);
      expect(stopped[0].branchActivity?.since).toEqual(expect.any(Number));
      expect(Boolean(manager.getSession(id)?.process)).toBe(interruptOnly);
      expect((await entries(id)).filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual(["stopped"]);
    } finally { unsubscribe?.(); }
  });

  it("does not send a completion notification when end_turn races user Stop", async () => {
    const writes = vi.spyOn(storage.agentSessions, "upsertTurnEndWithOutbox");
    const id = await newSession();
    await manager.sendUserMessage(id, "CANCEL_RACE", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    await manager.stopSession(id, { interruptOnly: true });
    await completed(id, 1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.mock.calls[0][0].entryData).outcome).toBe("stopped");
    expect(writes.mock.calls[0][0].outbox).toBeUndefined();
  });
  it("ends a prompt error and runs the next message on the same process", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "PROMPT_ERROR", dir); await completed(id, 1);
    expect(manager.getSession(id)?.status).toBe("stopped");
    await manager.sendUserMessage(id, "retry", dir); await completed(id, 2);
    expect((await entries(id)).filter(e => e.type === "turn_end").map(e => e.outcome)).toEqual(["failed", "completed"]);
    expect(new Set(wire().map(m => m.pid)).size).toBe(1);
  });
  it("persists one complete thinking entry per stream, not each chunk", async () => {
    const writes = vi.spyOn(storage.agentSessions, "upsertEntry");
    const id = await newSession();
    await manager.sendUserMessage(id, "one", dir); await completed(id, 1);
    const thoughts = writes.mock.calls.map(call => JSON.parse(call[2])).filter(e => e.type === "thinking");
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].content).toBe("think more");
  });
  it("forced capacity eviction confirms the running fx process exited before replacing it", async () => {
    vi.spyOn(storage.settings, "get").mockResolvedValue(JSON.stringify({ maxResidentAgentProcesses: 1 }));
    const id = await newSession();
    await manager.sendUserMessage(id, "IGNORE_CANCEL", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    const oldProcess = manager.getSession(id)!.process!;
    const replacement = await manager.createNewSession("p", null, dir, false, "edit", "fx", false, true);
    expect(oldProcess.exitCode !== null || oldProcess.signalCode !== null).toBe(true);
    expect(manager.getLiveSessionIdsForBranch("p", null)).toEqual([replacement]);
    expect(manager.getSession(id)?.status).toBe("stopped");
    await completed(id, 1);
  });

  it("refuses a forced replacement when process exit cannot be confirmed", async () => {
    vi.spyOn(storage.settings, "get").mockResolvedValue(JSON.stringify({ maxResidentAgentProcesses: 1 }));
    const id = await newSession();
    await manager.sendUserMessage(id, "IGNORE_CANCEL", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    const stopping = vi.spyOn(manager, "stopSessionAndWait").mockResolvedValueOnce(false);
    await expect(manager.createNewSession("p", null, dir, false, "edit", "fx", false, true)).rejects.toThrow(/capacity was not released/);
    stopping.mockRestore();
    expect(manager.getLiveSessionIdsForBranch("p", null)).toEqual([id]);
    expect(await storage.agentSessions.getAll()).toHaveLength(1);
  });

  it("ordinary stop without a note terminates fx instead of preserving its process", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "IGNORE_CANCEL", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    const proc = manager.getSession(id)!.process!;
    await manager.stopSession(id);
    await waitFor(() => proc.exitCode !== null || proc.signalCode !== null);
    expect(manager.getSession(id)?.process).toBeNull();
    expect(manager.getSession(id)?.dormant).toBe(true);
    await completed(id, 1);
  });

  it("a second user Stop force-stops an unacknowledged cancel", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "IGNORE_CANCEL", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    const proc = manager.getSession(id)!.process!;
    await manager.stopSession(id, { interruptOnly: true });
    expect(manager.getSession(id)?.process).toBe(proc);
    await manager.stopSession(id, { interruptOnly: true });
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(manager.getSession(id)?.interruptTimer).toBeUndefined();
    await completed(id, 1);
  });

  it("times out a missing cancel response and escalates when SIGTERM is ignored", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "IGNORE_TERM", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    const proc = manager.getSession(id)!.process!;
    await manager.stopSession(id, { interruptOnly: true, cancelGraceMs: 30 });
    await waitFor(() => proc.signalCode === "SIGKILL");
    expect(manager.getSession(id)?.status).toBe("stopped");
    expect((await entries(id)).some(e => e.type === "system" && e.content.includes("did not acknowledge"))).toBe(true);
    await completed(id, 1);
    await manager.sendUserMessage(id, "after timeout", dir); await completed(id, 2);
  }, 10000);

  it("retires the cancel deadline before starting a queued next turn on the same process", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "HOLD", dir);
    await waitFor(() => wire().filter(m => m.method === "session/prompt").length === 1);
    const proc = manager.getSession(id)!.process!;
    await manager.stopSession(id, { interruptOnly: true, cancelGraceMs: 500 });
    await manager.sendUserMessage(id, "HOLD", dir);
    await completed(id, 1);
    await waitFor(() => wire().filter(m => m.method === "session/prompt").length === 2);
    await new Promise(r => setTimeout(r, 600));
    expect(manager.getSession(id)?.process).toBe(proc);
    expect(manager.getSession(id)?.status).toBe("running");
    expect(manager.getSession(id)?.interruptTimer).toBeUndefined();
    await manager.stopSessionAndWait(id); await completed(id, 2);
  });

  it("hibernates and wakes through a fresh handshake with history exactly once; model changes survive replay", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "HISTORY731", dir); await completed(id, 1);
    const oldNative = (await storage.agentSessions.getById(id))!.native_session_id;
    await (manager as unknown as { hibernateSession(id: string): Promise<boolean> }).hibernateSession(id);
    await manager.sendUserMessage(id, "wake", dir); await completed(id, 2);
    const secondNative = (await storage.agentSessions.getById(id))!.native_session_id;
    expect(secondNative).not.toBe(oldNative);
    await manager.setModel(id, "new-model");
    await manager.sendUserMessage(id, "after model change", dir); await completed(id, 3);
    const prompts = wire().filter(m => m.method === "session/prompt");
    expect(prompts).toHaveLength(3);
    expect(prompts[1].params.prompt![0].text.match(/HISTORY731/g)).toHaveLength(1);
    expect(prompts[2].model).toBe("new-model");
    expect(prompts[2].params.sessionId).not.toBe(secondNative);
    expect(wire().filter(m => m.method === "initialize")).toHaveLength(3);
    expect((await entries(id)).filter(e => e.type === "user").map(e => e.content)).toEqual(["HISTORY731", "wake", "after model change"]);
    expect(wire().some(m => /load|resume/.test(m.method))).toBe(false);
  });
  it.each(["CRASH", "MALFORMED"])("ends the turn and shows an error for %s", async input => {
    const id = await newSession();
    await manager.sendUserMessage(id, input, dir); await completed(id, 1);
    await waitFor(() => manager.getSession(id)?.status !== "running");
    expect((await entries(id)).some(e => e.type === "error")).toBe(true);
    await waitFor(() => manager.getSession(id)?.process === null);
    await manager.sendUserMessage(id, "after failure", dir); await completed(id, 2);
    expect(wire().filter(m => m.method === "initialize")).toHaveLength(2);
  });
  it.each(["claude-code", "codex"])("wakes %s after an unexpected exit and replays the existing user message once", async agentType => {
    const other = getProvider(agentType);
    const spawns = vi.spyOn(other, "buildSpawnConfig").mockReturnValue({ command: process.execPath, args: ["-e", `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        if (line === 'CRASH') process.exit(1);
        process.stdout.write('DONE\\n');
      });
    `] });
    vi.spyOn(other, "formatUserInput").mockImplementation(content => JSON.stringify(content) === '"CRASH"' ? "CRASH\n" : "REPLAY\n");
    if (other.getInitializationMessages) vi.spyOn(other, "getInitializationMessages").mockReturnValue(null);
    vi.spyOn(other, "parseStdoutLine").mockReturnValue([{ type: "text", content: "recovered" }, { type: "result", subtype: "success" }]);
    const id = await manager.createNewSession("p", null, dir, false, "edit", agentType);
    await manager.sendUserMessage(id, "CRASH", dir);
    await completed(id, 1);
    await waitFor(() => manager.getSession(id)?.process === null);
    await manager.sendUserMessage(id, "retry", dir);
    await completed(id, 2);
    expect(spawns).toHaveBeenCalledTimes(2);
    expect((await entries(id)).filter(e => e.type === "user").map(e => e.content)).toEqual(["CRASH", "retry"]);
    expect(other.formatUserInput).toHaveBeenLastCalledWith(expect.stringContaining("CRASH"), id);
  });

  it.each([
    "fx needs access to Vercel AI Gateway. Run fx login to sign in.",
    "Unknown model: user/invalid-model",
    "Access denied for model openai/private",
  ])("surfaces handshake failure and retires a child that stays alive: %s", async message => {
    vi.mocked(provider.buildSpawnConfig).mockReturnValue({ command: process.execPath, args: ["-e", `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32600,message:${JSON.stringify(message)}}}) + '\\n');
      });
    `] });
    const id = await newSession();
    await waitFor(async () => (await entries(id)).some(e => e.type === "error" && e.message.includes(message)));
    await waitFor(() => manager.getSession(id)?.process === null);
    expect(manager.getSession(id)?.status).not.toBe("running");
    const errors = (await entries(id)).filter(e => e.type === "error");
    expect(errors.some(e => e.type === "error" && e.message.includes("fx is not logged in"))).toBe(message.includes("fx login"));
    vi.mocked(provider.buildSpawnConfig).mockReturnValue({ command: process.execPath, args: ["-e", fakeAcp], env: { FX_TEST_LOG: log } });
    await manager.sendUserMessage(id, "retry after fixing configuration", dir);
    await waitFor(async () => (await entries(id)).some(e => e.type === "assistant"));
    await waitFor(() => manager.getSession(id)?.status !== "running");
  });

  it("rejects changing the fx model during a turn and clears it when switching agents", async () => {
    const id = await newSession();
    await manager.sendUserMessage(id, "HOLD", dir);
    await waitFor(() => wire().some(m => m.method === "session/prompt"));
    expect(await manager.setModel(id, "user/custom-model")).toBe("busy");
    expect(manager.getSession(id)?.model).toBe("old-model");
    await completed(id, 1);
    expect(await manager.switchAgentType(id, "codex")).toBe("ok");
    expect(manager.getSession(id)?.model).toBeNull();
    expect(await manager.switchAgentType(id, "fx")).toBe("ok");
    await manager.sendUserMessage(id, "use fx default", dir);
    await completed(id, 2);
    expect(wire().filter(m => m.method === "session/prompt").at(-1)?.model).toBe("default");
  });

  it("puts the installation hint in conversation history when the fx executable is missing", async () => {
    vi.mocked(provider.buildSpawnConfig).mockReturnValue({ command: join(dir, "missing-fx"), args: [] });
    const id = await newSession();
    await waitFor(async () => (await entries(id)).some(e => e.type === "error" && e.message.includes("https://fx.sh")));
    await waitFor(() => manager.getSession(id)?.process === null);
    expect(manager.getSession(id)?.status).toBe("error");
  });

  it("rejects plan before creating a row or killing an existing process", async () => {
    await expect(manager.createNewSession("p", null, dir, false, "plan", "fx")).rejects.toThrow(/plan/);
    await expect(manager.prepareSessionRow({ sessionId: "reviewer", projectId: "p", branch: null, projectPath: dir,
      permissionMode: "plan", agentType: "fx", model: null, purpose: "workflow_review", owner: null,
      prepareOperationId: "operation", pendingExpiresAt: Date.now() + 60_000,
    })).rejects.toThrow(/plan/);
    expect(await storage.agentSessions.getAll()).toHaveLength(0);
    const id = await newSession();
    await expect(manager.switchMode(id, dir, "plan")).rejects.toThrow(/plan/);
    await manager.sendUserMessage(id, "still usable", dir); await completed(id, 1);
    expect((await storage.agentSessions.getById(id))!.permission_mode).toBe("edit");
  });
});
