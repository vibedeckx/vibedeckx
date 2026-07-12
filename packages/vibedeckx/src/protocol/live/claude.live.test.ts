import { describe, expect, it } from "vitest";
import { buildClaudePrintCommand } from "../claude-code/cli.js";
import { detectBinary } from "../shared/binary.js";
import { buildMcpConfigArg } from "../../cross-remote-mcp-config.js";
import { claudeBinaryAvailable, compatRequired, runClaudeSession, runOneShot } from "./runner.js";
import { startStubMcpServer } from "./stub-mcp-server.js";

const MODEL_ARGS = ["--model", "claude-haiku-4-5-20251001"];
const available = claudeBinaryAvailable();

if (!available && compatRequired()) {
  throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no claude binary available");
}

describe.skipIf(!available)("claude live probes (core)", () => {
  it("CC-1: basic turn — assistant text then result", async () => {
    const r = await runClaudeSession({
      turns: ["Reply with a short greeting. Do not use any tools."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc1-basic",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const types = r.messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types).toContain("result");
    const assistantTexts = r.messages.filter((m) => (m as { type: string }).type === "assistant");
    expect(assistantTexts.length).toBeGreaterThan(0);
  });

  it("CC-2: forced tool call — tool_use and tool_result shapes", async () => {
    const r = await runClaudeSession({
      turns: ["Use the Bash tool to run exactly this command: echo vibedeckx-probe. Then stop. Do not run anything else."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc2-tool",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    // find a Bash tool_use block in an assistant message
    const toolUses = r.messages.flatMap((m) => {
      const content = (m as { type: string; message?: { content?: Array<{ type: string; name?: string; id?: string; input?: unknown }> } });
      if (content.type !== "assistant" || !Array.isArray(content.message?.content)) return [];
      return content.message.content.filter((b) => b.type === "tool_use");
    });
    expect(toolUses.length).toBeGreaterThan(0);
    const bash = toolUses.find((t) => t.name === "Bash");
    expect(bash, `expected a Bash tool_use, saw: ${toolUses.map((t) => t.name).join(", ")}`).toBeDefined();
    expect(typeof bash!.id).toBe("string");
    // and a matching tool_result in a user message
    const toolResults = r.messages.flatMap((m) => {
      const um = m as { type: string; message?: { content?: Array<{ type: string; tool_use_id?: string }> } };
      if (um.type !== "user" || !Array.isArray(um.message?.content)) return [];
      return um.message.content.filter((b) => b.type === "tool_result");
    });
    expect(toolResults.some((tr) => tr.tool_use_id === bash!.id)).toBe(true);
  });

  it("CC-4: multi-turn liveness — process answers a second stdin turn after result", async () => {
    const r = await runClaudeSession({
      turns: [
        "Reply with the word ONE and nothing else. No tools.",
        "Reply with the word TWO and nothing else. No tools.",
      ],
      extraArgs: MODEL_ARGS,
      recordAs: "cc4-multiturn",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const results = r.messages.filter((m) => (m as { type: string }).type === "result");
    expect(results.length, "process must stay alive after result and answer turn 2").toBe(2);
  });

  it("CC-8: -p print mode — one-shot run exits with a result", async () => {
    const cmd = buildClaudePrintCommand(detectBinary("claude"), "Reply with the word PONG and nothing else.") + " --output-format=stream-json --model claude-haiku-4-5-20251001";
    const r = await runOneShot(cmd);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const types = lines.map((l) => { try { return JSON.parse(l).type; } catch { return null; } });
    expect(types).toContain("result");
  });
});

describe.skipIf(!available)("claude live probes (lifecycle & flags)", () => {
  it("CC-3: run_in_background emits task_started and task_notification", async () => {
    const r = await runClaudeSession({
      turns: ["Use the Bash tool with run_in_background set to true to run: sleep 3. Then wait for it to finish and reply DONE."],
      extraArgs: MODEL_ARGS,
      timeoutMs: 150_000,
      recordAs: "cc3-background",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const systems = r.messages.filter((m) => (m as { type: string }).type === "system") as Array<{ subtype?: string; task_id?: string }>;
    const started = systems.filter((s) => s.subtype === "task_started" && s.task_id);
    // The background-task ledger depends on these two events — this is the core drift tripwire.
    expect(started.length, "no task_started event — background-task ledger protocol drifted?").toBeGreaterThan(0);
    const finished = systems.filter(
      (s) => (s.subtype === "task_notification" && s.task_id) || (s.subtype === "task_updated" && s.task_id),
    );
    expect(finished.length, "no task_notification/task_updated terminal event").toBeGreaterThan(0);
  });

  it("CC-5: plan mode — ExitPlanMode tool_use appears", async () => {
    const r = await runClaudeSession({
      turns: ["Make a one-step plan to create a file named hello.txt. Do not write any files or use ToolSearch. As soon as you have the one-step plan in mind, immediately call the ExitPlanMode tool (it is a core built-in tool available directly in this session, not something you need to search for) with the plan text to present it and exit plan mode."],
      permissionMode: "plan",
      extraArgs: MODEL_ARGS,
      recordAs: "cc5-planmode",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const toolNames = r.messages.flatMap((m) => {
      const am = m as { type: string; message?: { content?: Array<{ type: string; name?: string }> } };
      if (am.type !== "assistant" || !Array.isArray(am.message?.content)) return [];
      return am.message.content.filter((b) => b.type === "tool_use").map((b) => b.name);
    });
    expect(toolNames, `expected ExitPlanMode among: ${toolNames.join(", ")}`).toContain("ExitPlanMode");
  });

  it("CC-6: --disallowedTools AskUserQuestion is honored", async () => {
    const r = await runClaudeSession({
      turns: ["Ask me a multiple-choice question about my favorite color using the AskUserQuestion tool. If that tool is unavailable, ask in plain text instead."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc6-disallowed",
    });
    expect(r.outcome).toBe("ok");
    const toolNames = r.messages.flatMap((m) => {
      const am = m as { type: string; message?: { content?: Array<{ type: string; name?: string }> } };
      if (am.type !== "assistant" || !Array.isArray(am.message?.content)) return [];
      return am.message.content.filter((b) => b.type === "tool_use").map((b) => b.name);
    });
    expect(toolNames, "AskUserQuestion must be blocked by --disallowedTools").not.toContain("AskUserQuestion");
  });
});

describe.skipIf(!available)("claude live probes (mcp-config)", () => {
  it("CC-7: --mcp-config http server with bearer auth — connects and can call the tool", async () => {
    const stub = await startStubMcpServer();
    try {
      const r = await runClaudeSession({
        turns: ["Call the MCP tool compat_ping from the cross-remote server exactly once, then reply with what it returned. Do not use any other tools."],
        mcpConfigArg: buildMcpConfigArg({ url: stub.url, token: "compat-probe-token" }),
        extraArgs: MODEL_ARGS,
        recordAs: "cc7-mcp",
      });
      expect(r.outcome).toBe("ok");
      // Transport-level assertion first — its failure message distinguishes
      // "CLI never connected" (transport drift) from "agent didn't call the tool".
      expect(stub.requests.length, "claude CLI never contacted the MCP stub — --mcp-config http transport drifted?").toBeGreaterThan(0);
      expect(
        stub.authHeaders.filter(Boolean).every((h) => h === "Bearer compat-probe-token"),
        `unexpected Authorization headers: ${JSON.stringify([...new Set(stub.authHeaders)])}`,
      ).toBe(true);
      expect(stub.toolCalls, "MCP transport connected but the tool was never invoked").toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });
});
