import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { evalite } from "evalite";
import { generateConversationTitleWithModel } from "../src/utils/conversation-title.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModel: any | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getModel(): any {
  if (cachedModel) return cachedModel;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const modelId = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat-v3-0324";
    cachedModel = createOpenRouter({ apiKey: openrouterKey })(modelId);
    return cachedModel;
  }
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    cachedModel = createDeepSeek({ apiKey: deepseekKey })("deepseek-chat");
    return cachedModel;
  }
  throw new Error(
    "Set DEEPSEEK_API_KEY or OPENROUTER_API_KEY in the environment before running evals.",
  );
}

evalite("conversation title generation", {
  data: () => [
    { input: "帮我写一个 Python 的快速排序" },
    { input: "What's the difference between let and var in JavaScript?" },
    { input: "我想给我的 React 应用加一个登录页，用 Clerk 做鉴权" },
    { input: "explain monads to me like I'm five" },
    { input: "fix the bug where the websocket disconnects after 30 seconds of idle" },
    { input: "summarize the key arguments in this paper about transformer scaling laws" },
  ],
  task: async (input) => {
    const title = await generateConversationTitleWithModel(getModel(), input);
    return title ?? "";
  },
  scorers: [],
});
