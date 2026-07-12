import { describe, expect, it } from "vitest";
import { buildClaudePrintCommand } from "../claude-code/cli.js";
import { detectBinary } from "../shared/binary.js";
import { claudeBinaryAvailable, compatRequired, runClaudeSession, runOneShot } from "./runner.js";

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
