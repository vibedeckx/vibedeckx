/** Real-model behaviour eval. Runbook: docs/commander-plan-eval.md. */
import { evalite } from "evalite";
import { vi } from "vitest";
import { PROVIDERS, PROVIDER_IDS, isProviderId, parseChatProviderConfig } from "../src/utils/chat-model.js";
import { createHarness } from "./commander-plan-harness.js";
import { scenarios, scenarioCheckNames, type Checks } from "./commander-plan-scenarios.js";
import type { AgentMessage } from "../src/agent-types.js";

// Eval-only instrumentation: production resolution stays intact. Trace every
// model call (including approval resumes), and don't cache independent trials.
vi.mock("../src/utils/chat-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/chat-model.js")>();
  const { traceCommanderModel } = await import("./trace-commander-model.js");
  return {
    ...actual,
    resolveChatModel: async (...args: Parameters<typeof actual.resolveChatModel>) =>
      traceCommanderModel(await actual.resolveChatModel(...args)),
  };
});

const enabled = process.env.COMMANDER_PLAN_EVAL === "1";
const provider = process.env.COMMANDER_PLAN_EVAL_PROVIDER ?? PROVIDER_IDS.find((id) => process.env[PROVIDERS[id].envKey]);
const model = isProviderId(provider) ? process.env.COMMANDER_PLAN_EVAL_MODEL || PROVIDERS[provider].defaultModel : "unconfigured";
const reps = Math.max(1, Math.min(10, Number(process.env.COMMANDER_PLAN_EVAL_REPS) || 1));
interface Output { checks: Checks; messages: AgentMessage[] }

const selectedNames = process.env.COMMANDER_PLAN_EVAL_SCENARIOS?.split(",").map((name) => name.trim()).filter(Boolean);
if (selectedNames?.some((name) => !scenarios.some((scenario) => scenario.name === name))) {
  throw new Error("Unknown COMMANDER_PLAN_EVAL_SCENARIOS name. Check the scenario names in commander-plan-scenarios.ts.");
}
for (const scenario of scenarios.filter((scenario) => !selectedNames || selectedNames.includes(scenario.name))) {
  (enabled ? evalite : evalite.skip)(`Commander plans / ${scenario.name}`, {
    data: [{ input: { scenario: scenario.name, provider, model } }],
    trialCount: reps,
    task: async (): Promise<Output> => {
      if (!isProviderId(provider) || !process.env[PROVIDERS[provider].envKey]) {
        throw new Error("Set COMMANDER_PLAN_EVAL_PROVIDER and its API key (DEEPSEEK_API_KEY, OPENROUTER_API_KEY or AI_GATEWAY_API_KEY).");
      }
      const config = parseChatProviderConfig(JSON.stringify({ main: { provider, model } }));
      const h = createHarness(config);
      try {
        const checks = await scenario.run(h);
        return { checks, messages: h.messages() };
      } finally {
        h.stop();
      }
    },
    scorers: scenarioCheckNames[scenario.name].map((name) => ({
      name,
      scorer: ({ output }: { output: Output }) => output.checks[name] === true ? 1 : 0,
    })),
    columns: ({ input, output }) => [
      { label: "Scenario", value: input.scenario },
      { label: "Model", value: `${input.provider}/${input.model}` },
      { label: "Requests", value: output.messages.filter((message) => message.type === "user").map((message) => message.content) },
      { label: "Failed checks", value: Object.entries(output.checks).filter(([, pass]) => !pass).map(([name]) => name) },
    ],
  });
}
