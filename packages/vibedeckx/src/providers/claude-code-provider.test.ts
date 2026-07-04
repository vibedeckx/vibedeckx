import { describe, it, expect } from "vitest";
import { ClaudeCodeProvider } from "./claude-code-provider.js";

/**
 * Background-task lifecycle parsing. Fixture lines are real stream-json
 * output captured from Claude Code 2.1.198 (`--output-format stream-json
 * --verbose`) during a run where the main agent launched a background
 * subagent (Agent tool with run_in_background: true) and was auto-resumed
 * by its completion notification.
 */
const SESSION = "test-session";

const TASK_STARTED_AGENT = JSON.stringify({
  type: "system",
  subtype: "task_started",
  task_id: "aa462d9841ec77a13",
  tool_use_id: "toolu_01M21wx2oyVzZSY4M3HWrHAv",
  description: "Sleep 15 then reply DONE",
  subagent_type: "claude",
  task_type: "local_agent",
  prompt: "Run the bash command 'sleep 15' and then reply with the single word DONE.",
  uuid: "85005f62-c256-416a-8ac9-927cf1e1afce",
  session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
});

const TASK_STARTED_BASH = JSON.stringify({
  type: "system",
  subtype: "task_started",
  task_id: "bjpgos1hw",
  tool_use_id: "toolu_019pZw4sw7V3r8QMWJRrtQGX",
  description: "Sleep for 15 seconds",
  task_type: "local_bash",
  uuid: "3668156d-f0e7-450c-b25d-ace30f3fa8c6",
  session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
});

const TASK_NOTIFICATION = JSON.stringify({
  type: "system",
  subtype: "task_notification",
  task_id: "aa462d9841ec77a13",
  tool_use_id: "toolu_01M21wx2oyVzZSY4M3HWrHAv",
  status: "completed",
  output_file: "/tmp/tasks/aa462d9841ec77a13.output",
  summary: "DONE",
  usage: { total_tokens: 16233, tool_uses: 1, duration_ms: 25961 },
  uuid: "e96b54c7-b3fd-41ed-91e4-36084cc2a24f",
  session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
});

const TASK_PROGRESS = JSON.stringify({
  type: "system",
  subtype: "task_progress",
  task_id: "aa462d9841ec77a13",
  tool_use_id: "toolu_01M21wx2oyVzZSY4M3HWrHAv",
  description: "Running Sleep for 15 seconds",
  subagent_type: "claude",
  usage: { total_tokens: 12864, tool_uses: 1, duration_ms: 5830 },
  last_tool_name: "Bash",
  uuid: "f5b1f1ac-cc14-4d9d-8aaa-967f48974796",
  session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
});

describe("ClaudeCodeProvider background-task lifecycle parsing", () => {
  const provider = new ClaudeCodeProvider();

  it("parses system/task_started (background subagent) into task_started", () => {
    const events = provider.parseStdoutLine(TASK_STARTED_AGENT, SESSION);
    expect(events).toEqual([
      {
        type: "task_started",
        taskId: "aa462d9841ec77a13",
        taskType: "local_agent",
        description: "Sleep 15 then reply DONE",
      },
    ]);
  });

  it("parses system/task_started (background bash) into task_started", () => {
    const events = provider.parseStdoutLine(TASK_STARTED_BASH, SESSION);
    expect(events).toEqual([
      {
        type: "task_started",
        taskId: "bjpgos1hw",
        taskType: "local_bash",
        description: "Sleep for 15 seconds",
      },
    ]);
  });

  it("parses system/task_notification into task_finished", () => {
    const events = provider.parseStdoutLine(TASK_NOTIFICATION, SESSION);
    expect(events).toEqual([
      { type: "task_finished", taskId: "aa462d9841ec77a13", status: "completed" },
    ]);
  });

  it("ignores system/task_progress (no ledger effect)", () => {
    expect(provider.parseStdoutLine(TASK_PROGRESS, SESSION)).toEqual([]);
  });

  it("still surfaces plain system messages with a message field", () => {
    const line = JSON.stringify({ type: "system", subtype: "info", message: "hello" });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([
      { type: "system", content: "hello" },
    ]);
  });

  it("ignores task events missing task_id", () => {
    const line = JSON.stringify({ type: "system", subtype: "task_notification", status: "completed" });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([]);
  });
});
