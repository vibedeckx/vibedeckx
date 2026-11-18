import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FxProvider } from "./fx-provider.js";
import type { ParsedAgentEvent } from "../agent-provider.js";

/** Replay real ACP traffic through the product provider, including late reports. */
function replay(file: string, prefix = "task5") {
  const provider = new FxProvider();
  provider.onSessionCreated("recorded");
  provider.getInitializationMessages("recorded", { cwd: "/workspace" });
  const events: ParsedAgentEvent[] = [];
  const resultsAt: number[] = [];
  for (const line of readFileSync(new URL(`../protocol/fx/__fixtures__/${prefix}-${file}.jsonl`, import.meta.url), "utf8").trim().split("\n")) {
    const { direction, message } = JSON.parse(line);
    if (direction === "stdin") {
      if (message.method === "session/prompt") provider.formatUserInput(message.params.prompt, "recorded");
      if (message.method === "session/cancel") provider.formatInterrupt("recorded");
    } else if (direction === "stdout") {
      // These immutable tool recordings predate edit → full-access. Adapt only
      // the handshake mode for tool replay; mode enforcement has its own tests.
      if (prefix === "task5" && message.result?.sessionId && message.result?.modes) {
        message.result.modes.currentModeId = "full-access";
      }
      events.push(...provider.parseStdoutLine(JSON.stringify(message), "recorded"));
      if (message.result?.stopReason) resultsAt.push(events.length - 1);
    }
  }
  expect(events.filter(e => e.type === "result")).toHaveLength(resultsAt.length);
  expect(events.some(e => e.type === "task_started" || e.type === "task_finished")).toBe(false);
  // No residual running prompt prevents the next user message from being sent.
  expect(JSON.parse(provider.formatUserInput("continue", "recorded")).method).toBe("session/prompt");
  return { events, resultsAt };
}
describe("fx 0.0.17 tool recordings", () => {
  it.each(["task7", "task7-macos"])("replays %s full-access lifecycle recordings without adapting the handshake", (prefix) => {
    const first = replay("fx-lifecycle-1", prefix);
    expect(first.events.filter(e => e.type === "result").map(e => e.subtype)).toEqual(["success", "success", "cancelled", "success", "success"]);
    expect(first.events.some(e => e.type === "tool_result" && e.output.includes("FX_TOOL_OK"))).toBe(true);
    const second = replay("fx-lifecycle-2", prefix);
    expect(second.events.filter(e => e.type === "result").map(e => e.subtype)).toEqual(["success"]);
    expect(second.events.filter(e => e.type === "text").map(e => e.content).join("")).toContain("LIFECYCLE731");
    expect(second.events.find(e => e.type === "native_session_id")).not.toEqual(first.events.find(e => e.type === "native_session_id"));
  });
  it("maps real file/search calls and their results", () => {
    const { events } = replay("tool-cards");
    const calls = events.filter(e => e.type === "tool_use");
    expect(calls.map(e => e.tool)).toEqual(["Write", "Read", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(calls[1].input).toMatchObject({ file_path: "probe.txt", offset: 1, limit: 5 });
    expect(calls[4].input).toMatchObject({ glob: "*.txt" });
    // Native provider search can omit the query: do not invent it.
    expect(calls[5].input).toEqual({});
    expect(events.filter(e => e.type === "tool_result").map(e => e.tool)).toEqual(calls.map(e => e.tool));
  });
  it("keeps the question fallback, final child report and yielded shell output", () => {
    const { events, resultsAt } = replay("tools-lifecycle");
    expect(events.some(e => e.type === "tool_use" && e.tool === "AskUserQuestion")).toBe(true);
    expect(events.some(e => e.type === "tool_result" && e.output.includes("only available in the interactive shell"))).toBe(true);
    const childReport = events.findIndex(e => e.type === "tool_result" && e.tool === "Agent" && e.output.includes("CHILD_DONE"));
    expect(childReport).toBeGreaterThan(-1);
    expect(childReport).toBeLessThan(resultsAt[1]);
    expect(events.some(e => e.type === "tool_result" && e.tool === "Bash" && e.output.includes("SHELL_DONE"))).toBe(true);
  });
  it("finishes cancelled shell, failed shell command and no-wait subagent turns", () => {
    const { events, resultsAt } = replay("shell-cancel-failure");
    expect(events.filter(e => e.type === "result").map(e => e.subtype)).toEqual(["cancelled", "success", "success", "success"]);
    expect(events.some(e => e.type === "tool_result" && e.output.includes("FAILURE_OUTPUT"))).toBe(true);
    const report = events.findIndex(e => e.type === "tool_result" && e.output.includes("CHILD_NOWAIT_DONE"));
    expect(report).toBeGreaterThan(resultsAt[2]);
    expect(report).toBeLessThan(resultsAt[3]);
  });
  it("finishes child cancellation and supports shell stop without phantom tasks", () => {
    const { events, resultsAt } = replay("subagent-cancel-shell-stop");
    const childId = "call_BFGwvkb1T9jdncyfYiAyukng";
    const calls = events.filter(e => e.type === "tool_use" && e.toolUseId === childId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "Agent", input: { agent: "cancel-child", action: "message" } });
    const reports = events.filter(e => e.type === "tool_result" && e.toolUseId === childId);
    expect(reports).toHaveLength(2);
    expect(reports.every(e => e.tool === "Agent")).toBe(true);
    expect(reports[1].output).toContain("Subagent report");
    expect(events.indexOf(reports[1])).toBeGreaterThan(resultsAt[0]);
    expect(events.indexOf(reports[1])).toBeLessThan(resultsAt[1]);
    expect(events.filter(e => e.type === "result").map(e => e.subtype)).toEqual(["cancelled", "success", "success", "success"]);
    expect(events.some(e => e.type === "tool_use" && e.tool === "Bash" && (e.input as { action?: string }).action === "stop")).toBe(true);
  });
});
