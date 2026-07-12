import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { checkContract } from "./contract-check.js";
import { parseClaudeLine } from "./claude-code/codec.js";
import { parseCodexLine } from "./codex/codec.js";
import {
  CLAUDE_CONTRACTS,
  ClaudeAssistantMessageSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
} from "./claude-code/schema.js";
import {
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
  ThreadStartResultSchema,
  CommandApprovalParamsSchema,
} from "./codex/schema.js";

function fixtureLines(url: URL): string[] {
  return readFileSync(url, "utf-8").split("\n").filter((l) => l.trim());
}

describe("claude-code fixture corpus honors the contract", () => {
  const lines = fixtureLines(new URL("./claude-code/__fixtures__/stream-session.jsonl", import.meta.url));

  it("every fixture line parses", () => {
    for (const line of lines) {
      expect(parseClaudeLine(line), `unparseable: ${line}`).not.toBeNull();
    }
  });

  it("every fixture line validates against its message schema", () => {
    const byType = {
      assistant: ClaudeAssistantMessageSchema,
      system: ClaudeSystemMessageSchema,
      result: ClaudeResultMessageSchema,
    } as const;
    for (const line of lines) {
      const msg = parseClaudeLine(line)! as { type: keyof typeof byType };
      const schema = byType[msg.type];
      expect(schema, `no schema for type=${msg.type}`).toBeDefined();
      const report = checkContract({ id: `CC-OUT-${msg.type}`, schema, consumers: [] }, msg);
      expect(report.ok, `${report.issues.join("; ")} in: ${line}`).toBe(true);
    }
  });

  it("contract registry is wired", () => {
    expect(CLAUDE_CONTRACTS.map((c) => c.id)).toContain("CC-OUT-system");
  });
});

describe("codex fixture corpus honors the contract", () => {
  const lines = fixtureLines(new URL("./codex/__fixtures__/app-server-session.jsonl", import.meta.url));

  it("every fixture line classifies and validates", () => {
    for (const line of lines) {
      const incoming = parseCodexLine(line);
      expect(incoming.kind, `ignored: ${line}`).not.toBe("ignored");

      if (incoming.kind === "response") {
        expect(checkContract({ id: "CX-RESP-thread_start", schema: ThreadStartResultSchema, consumers: [] }, incoming.result).ok).toBe(true);
      } else if (incoming.kind === "notification") {
        const schema = {
          [CODEX_NOTIFICATIONS.itemCompleted]: ItemCompletedParamsSchema,
          [CODEX_NOTIFICATIONS.turnCompleted]: TurnCompletedParamsSchema,
          [CODEX_NOTIFICATIONS.tokenUsageUpdated]: TokenUsageParamsSchema,
        }[incoming.method];
        expect(schema, `no schema for ${incoming.method}`).toBeDefined();
        const report = checkContract({ id: incoming.method, schema: schema!, consumers: [] }, incoming.params);
        expect(report.ok, report.issues.join("; ")).toBe(true);
        if (incoming.method === CODEX_NOTIFICATIONS.itemCompleted) {
          const item = (incoming.params as { item: unknown }).item;
          expect(checkContract({ id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: [] }, item).ok).toBe(true);
        }
      } else if (incoming.kind === "server_request") {
        expect(incoming.method).toBe(CODEX_SERVER_REQUESTS.commandApproval);
        expect(checkContract({ id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema, consumers: [] }, incoming.params).ok).toBe(true);
      }
    }
  });
});

describe("checkContract", () => {
  it("fails with readable issues on a broken shape and reports unknown keys", () => {
    const report = checkContract(
      { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema, consumers: ["x.ts"] },
      { tokenUsage: { last: { inputTokens: "12" } }, brandNewField: 1 },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.join(" ")).toContain("inputTokens");
    expect(report.unknownKeys).toContain("brandNewField");
  });
});
