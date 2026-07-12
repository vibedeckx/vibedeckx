import { describe, expect, it } from "vitest";
import {
  CLAUDE_CONTRACTS,
  ClaudeAssistantMessageSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
  FRONTEND_RENDERED_TOOLS,
  TERMINAL_TASK_STATUSES,
} from "./schema.js";

describe("protocol/claude-code schemas", () => {
  it("accepts a real captured task_started system message", () => {
    const msg = {
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
    };
    const parsed = ClaudeSystemMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it("accepts an assistant message with text, tool_use, and thinking blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "Running it." },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo hi" } },
        ],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
      },
      session_id: "s-1",
    };
    expect(ClaudeAssistantMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an assistant message whose content is not an array", () => {
    const msg = { type: "assistant", message: { content: "oops" } };
    expect(ClaudeAssistantMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("accepts success and error result messages", () => {
    expect(
      ClaudeResultMessageSchema.safeParse({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        cost_usd: 0.003,
        result: "Done.",
        session_id: "s-1",
      }).success,
    ).toBe(true);
    expect(
      ClaudeResultMessageSchema.safeParse({ type: "result", subtype: "error", error: "boom" }).success,
    ).toBe(true);
  });

  it("pins the terminal task statuses the ledger clears on", () => {
    expect(TERMINAL_TASK_STATUSES).toEqual(["completed", "failed", "cancelled", "canceled", "killed", "error"]);
  });

  it("lists the tool names the frontend special-cases", () => {
    // Mirror of the switch in apps/vibedeckx-ui/components/agent/agent-message.tsx.
    // If you change one side, change the other.
    for (const tool of ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "TodoWrite", "ExitPlanMode", "AskUserQuestion", "Task", "WebFetch", "WebSearch", "Skill"]) {
      expect(FRONTEND_RENDERED_TOOLS).toContain(tool);
    }
  });

  it("every contract item has an ID and at least one consumer", () => {
    expect(CLAUDE_CONTRACTS.length).toBeGreaterThan(3);
    for (const c of CLAUDE_CONTRACTS) {
      expect(c.id).toMatch(/^CC-/);
      expect(c.consumers.length).toBeGreaterThan(0);
    }
  });
});
