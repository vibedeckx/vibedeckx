import { describe, expect, it } from "vitest";
import {
  AskForApprovalSchema,
  CODEX_CONTRACTS,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  SandboxModeSchema,
  ThreadStartResultSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
} from "./schema.js";

describe("protocol/codex schemas", () => {
  it("accepts a real commandExecution item/completed payload", () => {
    const params = {
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: '/bin/bash -lc "echo hi"',
        aggregatedOutput: "hi\n",
        status: "completed",
      },
    };
    expect(ItemCompletedParamsSchema.safeParse(params).success).toBe(true);
    expect(KnownThreadItemSchema.safeParse(params.item).success).toBe(true);
  });

  it("accepts a final agentMessage item", () => {
    const item = { type: "agentMessage", id: "msg-1", text: "Done.", phase: "final_answer" };
    expect(KnownThreadItemSchema.safeParse(item).success).toBe(true);
  });

  it("accepts a fileChange item with object kind", () => {
    const item = {
      type: "fileChange",
      id: "fc-1",
      changes: [{ path: "a.ts", diff: "+x", kind: { type: "edit" } }],
      status: "completed",
    };
    expect(KnownThreadItemSchema.safeParse(item).success).toBe(true);
  });

  it("tolerates unknown extra fields (loose objects)", () => {
    const params = {
      turn: { id: "turn-1", status: "completed", someNewField: 42 },
      anotherNewField: true,
    };
    expect(TurnCompletedParamsSchema.safeParse(params).success).toBe(true);
  });

  it("rejects a commandExecution item missing its command", () => {
    expect(KnownThreadItemSchema.safeParse({ type: "commandExecution", id: "x" }).success).toBe(false);
  });

  it("parses thread/start result and token usage", () => {
    expect(ThreadStartResultSchema.safeParse({ thread: { id: "t-1" } }).success).toBe(true);
    expect(
      TokenUsageParamsSchema.safeParse({ tokenUsage: { last: { inputTokens: 12, outputTokens: 34 } } }).success,
    ).toBe(true);
  });

  it("pins the enum values our thread/start params depend on", () => {
    expect(SandboxModeSchema.options).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(AskForApprovalSchema.options).toEqual(["untrusted", "on-failure", "on-request", "never"]);
  });

  it("every contract item has an ID and at least one consumer", () => {
    expect(CODEX_CONTRACTS.length).toBeGreaterThan(5);
    for (const c of CODEX_CONTRACTS) {
      expect(c.id).toMatch(/^CX-/);
      expect(c.consumers.length).toBeGreaterThan(0);
    }
  });
});
