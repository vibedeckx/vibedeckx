import { describe, expect, it } from "vitest";
import { explicitChecks, broadChecks, clarificationChecks, scenarios, scenarioCheckNames } from "./commander-plan-scenarios.js";
import type { AgentMessage } from "../src/agent-types.js";
import type { ChatPlanInput } from "../src/chat-plan.js";

// The rubric itself must reject wrong behaviour even without API credentials.
describe("Commander plan eval rubric", () => {
  it("registers all eleven scenarios with distinct named scorers", () => {
    expect(scenarios).toHaveLength(11);
    expect(Object.keys(scenarioCheckNames).sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
    for (const names of Object.values(scenarioCheckNames)) {
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
  });
  const message = (plan: ChatPlanInput): AgentMessage => ({ type: "tool_use", tool: "setPlan", input: plan, timestamp: 0 });
  const good: ChatPlanInput = {
    goal: "检查并预览", completionCriteria: ["测试通过，预览可访问"], requireConfirmation: false,
    steps: [
      { id: "test", title: "运行测试", status: "pending" },
      { id: "fix", title: "失败时修复并重新测试", status: "pending" },
      { id: "preview", title: "启动预览", status: "pending" },
    ],
  };
  it("accepts conditional steps without requiring exact wording", () => {
    expect(Object.values(explicitChecks([message(good)])).every(Boolean)).toBe(true);
  });
  it("rejects reordered steps, lost conditions and extra deployment", () => {
    const bad = { ...good, steps: [good.steps[2], good.steps[0], { ...good.steps[1], title: "修复问题并部署" }] };
    const checks = explicitChecks([message(bad)]);
    expect(checks["test before repair before preview"]).toBe(false);
    expect(checks["failure condition preserved"]).toBe(false);
    expect(checks["no added deployment"]).toBe(false);
  });
  it("rejects vague completion criteria", () => {
    const checks = broadChecks([message({ ...good, goal: "GitHub 登录", completionCriteria: ["功能完善"], requireConfirmation: true })]);
    expect(checks["concrete login acceptance criterion"]).toBe(false);
  });
  it("does not count the confirmation flag alone as real confirmation", () => {
    const checks = broadChecks([message({ ...good, goal: "GitHub 登录", requireConfirmation: true })]);
    expect(checks["requests confirmation"]).toBe(false);
  });
  const assistant = (content: string): AgentMessage => ({ type: "assistant", content, timestamp: 0 });
  it("accepts a targeted question instead of a plan", () => {
    const checks = clarificationChecks([assistant("你希望部署到测试环境还是生产环境？")], /环境|平台/);
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });
  it("does not accept generic questions or narrated inspections as clarification", () => {
    expect(clarificationChecks([assistant("还有什么需要帮忙的吗？")], /环境|平台/)["asks a targeted clarification"]).toBe(false);
    expect(clarificationChecks([assistant("我会先检查部署环境。")], /环境|平台/)["asks a targeted clarification"]).toBe(false);
    expect(clarificationChecks([assistant("我将查看日志。还有什么需要帮忙的吗？")], /日志/)["asks a targeted clarification"]).toBe(false);
  });
  it("rejects execution and completion while waiting for missing requirements", () => {
    const messages: AgentMessage[] = [assistant("你希望部署到哪个环境？"),
      { type: "tool_use", tool: "runExecutor", input: { executorName: "deploy" }, timestamp: 1 },
      { type: "tool_use", tool: "complete_task", input: {}, timestamp: 2 },
      message(good),
    ];
    const checks = clarificationChecks(messages, /环境/);
    expect(checks["asks a targeted clarification"]).toBe(true);
    expect(checks["no execution before clarification"]).toBe(false);
    expect(checks["no guessed plan"]).toBe(false);
    expect(checks["does not mark an unresolved task complete"]).toBe(false);
  });

});
