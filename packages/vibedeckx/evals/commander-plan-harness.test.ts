import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { traceCommanderModel } from "./trace-commander-model.js";
import { reportTraceLocalStorage, type reportTrace } from "evalite/traces";
import { createHarness } from "./commander-plan-harness.js";
import { parseChatProviderConfig, resolveChatModel } from "../src/utils/chat-model.js";

vi.mock("../src/utils/chat-model.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/chat-model.js")>(),
  resolveChatModel: vi.fn(),
}));
type Result = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type Part = Result["stream"] extends ReadableStream<infer Value> ? Value : never;

describe("Commander plan eval harness", () => {
  it("uses the production prompt and approval path while simulating executor execution", async () => {
    let phase = 0;
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      expect(options.prompt.find((message) => message.role === "system")?.content).toContain("<task-plans>");
      const index = phase++;
      const parts: Part[] = index === 0 ? [{
        type: "tool-call", toolCallId: "plan", toolName: "setPlan",
        input: JSON.stringify({ goal: "Start preview", completionCriteria: ["Preview accessible"], requireConfirmation: true, steps: [{ id: "preview", title: "Start preview", status: "pending" }] }),
      }] : index === 1 ? [{
        type: "tool-call", toolCallId: "execute", toolName: "runExecutor",
        input: JSON.stringify({ executorName: "dev-server" }),
      }] : [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Waiting for completion." },
        { type: "text-end", id: "text" },
      ];
      if (index === 0) parts.unshift(
        { type: "reasoning-start", id: "reasoning" },
        { type: "reasoning-delta", id: "reasoning", delta: "Plan before execution." },
        { type: "reasoning-end", id: "reasoning" },
      );
      const reason = index < 2 ? "tool-calls" : "stop";
      return {
        stream: new ReadableStream<Part>({ start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          parts.forEach((part) => controller.enqueue(part));
          controller.enqueue({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          } });
          controller.close();
        } }),
      };
    } });
    vi.mocked(resolveChatModel).mockResolvedValue(traceCommanderModel(model));
    const traces: Parameters<typeof reportTrace>[0][] = [];
    const h = createHarness(parseChatProviderConfig(undefined));
    try {
      await reportTraceLocalStorage.run((trace) => traces.push(trace), async () => {
        await h.send("Start a preview after showing me a plan.");
        expect(h.messages().some((message) => message.type === "tool_approval_request" && !message.resolved)).toBe(true);
        expect(h.messages().some((message) => message.type === "tool_use" && message.tool === "runExecutor")).toBe(false);
        await h.decide(true);
        const result = h.messages().find((message) => message.type === "tool_result" && message.tool === "runExecutor");
        expect(result?.type).toBe("tool_result");
        if (result?.type === "tool_result") expect(JSON.parse(result.output)).toMatchObject({ success: true, message: expect.stringContaining("Operation started") });
        expect(h.manager.getSession(h.id)!.planState.current?.goal).toBe("Start preview");
        expect(h.messages().some((message) => message.type === "error")).toBe(false);
      });
      expect(traces).toHaveLength(3);
      expect(JSON.stringify(traces.map((trace) => trace.input))).toContain("reasoning");
      expect(traces.every((trace) => trace.usage?.totalTokens === 2)).toBe(true);
    } finally { h.stop(); }
  });
});
