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

  it("parses system/task_updated with terminal status as redundant task_finished", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "aa462d9841ec77a13",
      patch: { status: "completed", end_time: 1783126857624 },
      uuid: "37f09ecf-3516-4e4e-a886-43999351dcdb",
      session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
    });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([
      { type: "task_finished", taskId: "aa462d9841ec77a13", status: "completed" },
    ]);
  });

  it("ignores system/task_updated with a non-terminal status", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "aa462d9841ec77a13",
      patch: { status: "in_progress" },
    });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([]);
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

  // Real capture from Claude Code 2.1.205 — fires on every change to the set
  // of running background tasks, including tasks launched by subagents.
  it("parses system/background_tasks_changed into task_list_changed", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a2c8b3b8fef0c5b25", task_type: "local_agent", description: "Return OK immediately" },
        { task_id: "a0b37e04e9bcdb02a", task_type: "local_agent", description: "Return OK immediately" },
      ],
      uuid: "3b01f301-faa4-44a9-86eb-5f2d156492e8",
      session_id: "cdc13acc-4319-48b4-8003-f0fc1ac347b7",
    });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([
      { type: "task_list_changed", taskIds: ["a2c8b3b8fef0c5b25", "a0b37e04e9bcdb02a"] },
    ]);
  });

  it("parses an empty background_tasks_changed snapshot", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "8e498186-8b2f-4f04-905d-149031a578d3",
      session_id: "cdc13acc-4319-48b4-8003-f0fc1ac347b7",
    });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([
      { type: "task_list_changed", taskIds: [] },
    ]);
  });

  it("ignores background_tasks_changed without a tasks array (drift guard)", () => {
    const line = JSON.stringify({ type: "system", subtype: "background_tasks_changed" });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([]);
  });

  // Real capture (2.1.205): every turn — including auto-resume turns injected
  // by background-task completions — starts with a system/init. It arrives
  // ~20ms after the previous turn's result (measured live), long before the
  // resume's first assistant event (a full LLM roundtrip later), so it is the
  // signal that cancels a grace-held completion in time.
  it("parses system/init into turn_started", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "cdc13acc-4319-48b4-8003-f0fc1ac347b7",
      model: "claude-fable-5",
      cwd: "/tmp/scratch",
    });
    expect(provider.parseStdoutLine(line, SESSION)).toEqual([{ type: "turn_started" }]);
  });

  it("omits --mcp-config when no cross-remote config is given", () => {
    const provider = new ClaudeCodeProvider();
    const config = provider.buildSpawnConfig("/tmp", "edit");
    expect(config.args).not.toContain("--mcp-config");
  });

  it("appends --mcp-config with the cross-remote server when given", () => {
    const provider = new ClaudeCodeProvider();
    const config = provider.buildSpawnConfig("/tmp", "edit", {
      url: "https://app.example.com/api/cross-remote-mcp",
      token: "tok",
    });

    const flagIndex = config.args.indexOf("--mcp-config");
    expect(flagIndex).toBeGreaterThan(-1);

    const blob = JSON.parse(config.args[flagIndex + 1]);
    expect(blob.mcpServers["cross-remote"].url).toBe("https://app.example.com/api/cross-remote-mcp");
    expect(blob.mcpServers["cross-remote"].headers.Authorization).toBe("Bearer tok");
  });
});
