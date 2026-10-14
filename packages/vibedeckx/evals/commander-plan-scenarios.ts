import { createHarness, isAction, plans, planText, validPlanCalls } from "./commander-plan-harness.js";
import type { AgentMessage } from "../src/agent-types.js";
export type Checks = Record<string, boolean>;

const approval = (messages: AgentMessage[]) => messages.some((message) =>
  message.type === "tool_approval_request" && message.tool === "setPlan" && !message.resolved);
const firstPlan = (messages: AgentMessage[]) => plans(messages)[0];
const broadRequest = "把 GitHub 登录功能做到可以验收。具体步骤和完成条件由你整理。";

export function explicitChecks(messages: AgentMessage[]): Checks {
  const plan = firstPlan(messages);
  const titles = plan?.steps.map((step) => step.title) ?? [];
  const test = titles.findIndex((title) => /测试|test/i.test(title));
  const fix = titles.findIndex((title) => /修复|fix|repair/i.test(title));
  const preview = titles.findIndex((title) => /预览|preview/i.test(title));
  const firstAction = messages.findIndex(isAction);
  const firstCall = messages.findIndex((message) => message.type === "tool_use" && message.tool === "setPlan");
  return {
    "valid plan": validPlanCalls(messages),
    "test before repair before preview": test >= 0 && fix > test && preview > fix,
    "failure condition preserved": titles.some((title) => /失败|未通过|不通过|fail/i.test(title) && /修复|fix|repair/i.test(title)),
    "pass condition preserved": Boolean(plan && /通过|pass|success/i.test(planText(plan))),
    "no added deployment": !titles.some((title) => /部署|发布|deploy|publish/i.test(title)),
    "new plan starts pending": Boolean(plan?.steps.every((step) => step.status === "pending")),
    "plan before actions": firstCall >= 0 && (firstAction < 0 || firstCall < firstAction),
    "explicit steps do not need confirmation": plan?.requireConfirmation === false && !approval(messages),
  };
}

export function broadChecks(messages: AgentMessage[]): Checks {
  const plan = firstPlan(messages);
  return {
    "valid plan": validPlanCalls(messages),
    "GitHub requirement included": Boolean(plan && /github/i.test(planText(plan))),
    "multiple steps": Boolean(plan && plan.steps.length >= 2),
    "verification step included": Boolean(plan?.steps.some((step) => /测试|验证|验收|test|verif|validat|check/i.test(step.title))),
    "completion criteria defined": Boolean(plan?.completionCriteria.length),
    "concrete login acceptance criterion": Boolean(plan?.completionCriteria.some((criterion) =>
      /登录|login|oauth|认证|auth/i.test(criterion) && /成功|跳转|错误|失败|会话|登出|回调|令牌|success|redirect|error|fail|session|logout|callback|token/i.test(criterion))),
    "requests confirmation": plan?.requireConfirmation === true && approval(messages),
    "no action before confirmation": !messages.some(isAction),
  };
}

export function clarificationChecks(messages: AgentMessage[], topic: RegExp): Checks {
  const asksForInformation = (text: string) => /[?？]|请(?:提供|说明|告诉|描述)|需要你(?:提供|确认)|could you|can you|please (?:provide|describe|specify)/i.test(text);
  const clauses = messages.flatMap((message) => message.type === "assistant"
    ? String(message.content).split(/(?<=[。！？.!?])|\n/).map((text) => text.trim()) : []);
  return {
    "asks a targeted clarification": clauses.some((text) => asksForInformation(text) && topic.test(text)),
    "no execution before clarification": !messages.some(isAction),
    "no guessed plan": !messages.some((message) => message.type === "tool_use" && message.tool === "setPlan"),
    "does not mark an unresolved task complete": !messages.some((message) => message.type === "tool_use" && message.tool === "complete_task"),
  };
}

export const clarificationCases = [
  { name: "clarify-deployment", request: "部署一下。", topic: /环境|平台|哪里|哪[个里]|目标|服务器|生产|测试|environment|platform|where|target|server/i },
  { name: "clarify-optimization", request: "帮我优化一下。", topic: /性能|速度|界面|体验|代码|范围|方面|什么|哪|performance|speed|ui|code|scope|which|what/i },
  { name: "clarify-unspecified-bug", request: "修一下这个问题。", topic: /问题|报错|错误|现象|复现|步骤|截图|日志|error|issue|symptom|repro|steps|logs/i },
];

export const scenarios = [
  ...clarificationCases.map(({ name, request, topic }) => ({
    name,
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send(request);
      return clarificationChecks(h.messages(), topic);
    },
  })),
  {
    name: "ordinary-question",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send("解释一下单元测试和集成测试有什么区别。这只是讨论，不需要执行任何操作。");
      return {
        "no plan for discussion": !h.messages().some((message) => message.type === "tool_use" && message.tool === "setPlan"),
        "no execution": !h.messages().some(isAction),
        "answers the question": h.messages().some((message) => message.type === "assistant" && /单元|unit/i.test(String(message.content)) && /集成|integration/i.test(String(message.content))),
      };
    },
  },
  {
    name: "single-action",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send("启动 dev-server 开发服务器。");
      return {
        "no unnecessary plan": !h.messages().some((message) => message.type === "tool_use" && message.tool === "setPlan"),
        "starts requested executor": h.messages().some((message) => message.type === "tool_use" && message.tool === "runExecutor" && (message.input as { executorName?: string }).executorName === "dev-server"),
      };
    },
  },
  {
    name: "explicit-command",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      // Commands currently enter Main Chat as plain text, exactly like this.
      await h.send("先运行测试；只有测试失败时才修复并重新测试；全部通过后启动预览。不要部署或发布。");
      return explicitChecks(h.messages());
    },
  },
  {
    name: "broad-goal",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send(broadRequest);
      return broadChecks(h.messages());
    },
  },
  {
    name: "confirm-plan",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send(broadRequest);
      const before = h.messages().length;
      const checks = broadChecks(h.messages());
      await h.decide(true);
      return {
        ...checks,
        "approval recorded": h.messages().some((message) => message.type === "tool_approval_request" && message.resolved === "approved"),
        "execution proceeds after confirmation": h.messages().slice(before).some(isAction),
        "plan is applied": h.manager.getSession(h.id)!.planState.current !== null,
      };
    },
  },
  {
    name: "decline-plan",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send(broadRequest);
      const before = h.messages().length;
      const checks = broadChecks(h.messages());
      await h.decide(false);
      const after = h.messages().slice(before);
      return {
        ...checks,
        "no execution after decline": !after.some(isAction),
        "no immediate resubmission": !after.some((message) => message.type === "tool_use" && message.tool === "setPlan"),
        "asks for changes": after.some((message) => message.type === "assistant" && /[?？]|调整|修改|告诉|change|revise|what|how/i.test(String(message.content))),
      };
    },
  },
  {
    name: "revise-declined-plan",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send("把邮箱密码登录功能做到可以验收。具体步骤和完成条件由你整理。");
      await h.decide(false);
      const before = h.messages().length;
      await h.send("改为 GitHub 登录，不要实现邮箱密码登录。请重新给我计划，等我确认后再执行。");
      const after = h.messages().slice(before);
      const plan = firstPlan(after);
      return {
        ...broadChecks(after),
        "removes email implementation": Boolean(plan && !plan.steps.some((step) => /邮箱|密码|email|password/i.test(step.title) && /实现|添加|支持|implement|add|support/i.test(step.title) && !/不要|不实现|不支持|移除|删除|not|remove/i.test(step.title))),
      };
    },
  },
  {
    name: "revise-approved-scope",
    run: async (h: ReturnType<typeof createHarness>): Promise<Checks> => {
      await h.send(broadRequest);
      await h.decide(true);
      const previous = h.manager.getSession(h.id)!.planState.current;
      const before = h.messages().length;
      await h.send("增加邮箱密码登录也要支持。先更新现有计划，等我确认后再执行新增工作。");
      const after = h.messages().slice(before);
      const plan = firstPlan(after);
      return {
        "valid revised plan": validPlanCalls(after),
        "same plan ID": Boolean(previous && plan?.planId === previous.planId),
        "adds email requirement": Boolean(plan && /邮箱|密码|email|password/i.test(planText(plan))),
        "keeps GitHub requirement": Boolean(plan && /github/i.test(planText(plan))),
        "requests confirmation again": approval(after),
        "no execution before reconfirmation": !after.some(isAction),
      };
    },
  },
];


// Only applicable checks become scorers; unrelated cases do not get free points.
const broad = Object.keys(broadChecks([]));
export const scenarioCheckNames: Record<string, string[]> = {
  ...Object.fromEntries(clarificationCases.map(({ name }) => [name, Object.keys(clarificationChecks([], /./))])),
  "ordinary-question": ["no plan for discussion", "no execution", "answers the question"],
  "single-action": ["no unnecessary plan", "starts requested executor"],
  "explicit-command": Object.keys(explicitChecks([])),
  "broad-goal": broad,
  "confirm-plan": [...broad, "approval recorded", "execution proceeds after confirmation", "plan is applied"],
  "decline-plan": [...broad, "no execution after decline", "no immediate resubmission", "asks for changes"],
  "revise-declined-plan": [...broad, "removes email implementation"],
  "revise-approved-scope": ["valid revised plan", "same plan ID", "adds email requirement", "keeps GitHub requirement", "requests confirmation again", "no execution before reconfirmation"],
};
