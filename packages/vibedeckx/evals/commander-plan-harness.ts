import type { ToolSet } from "ai";
import { ChatSessionManager } from "../src/chat-session-manager.js";
import { chatPlanSchema, type ChatPlanInput } from "../src/chat-plan.js";
import type { AgentMessage } from "../src/agent-types.js";
import type { ChatProviderConfig } from "../src/utils/chat-model.js";
import type { Storage } from "../src/storage/types.js";
import type { ProcessManager } from "../src/process-manager.js";
import type { AgentSessionManager } from "../src/agent-session-manager.js";
import type { RemotePatchCache } from "../src/remote-patch-cache.js";

const readOnly = new Set(["getAgentConversation", "getExecutorStatus", "listTerminals", "screenshot", "getPageContent", "waitForElement"]);
export const isAction = (message: AgentMessage) => message.type === "tool_use" &&
  !readOnly.has(message.tool) && message.tool !== "setPlan" && message.tool !== "complete_task";
export function plans(messages: AgentMessage[]): ChatPlanInput[] {
  return messages.flatMap((message) => {
    if (message.type !== "tool_use" || message.tool !== "setPlan") return [];
    const parsed = chatPlanSchema.safeParse(message.input);
    return parsed.success ? [parsed.data] : [];
  });
}
export function validPlanCalls(messages: AgentMessage[]): boolean {
  const calls = messages.filter((message) => message.type === "tool_use" && message.tool === "setPlan");
  return calls.length > 0 && calls.length === plans(messages).length;
}
export function planText(plan: ChatPlanInput): string {
  return [plan.goal, ...plan.completionCriteria, ...plan.steps.map((step) => step.title)].join("\n");
}

/** Real manager/prompt/schema/approval. Only external tool execution is simulated. */
export function createHarness(config: ChatProviderConfig) {
  const storage = {
    projects: { getById: async () => ({ id: "eval", name: "Eval project", path: "/eval/project" }) },
    projectRemotes: { getByProject: async () => [] },
    rules: { getByWorkspace: async () => [] },
    userSettings: { get: async (_user: string, key: string) => key === "chat_provider" ? JSON.stringify(config) : undefined },
  } as unknown as Storage;
  const manager = new ChatSessionManager(
    storage, {} as ProcessManager,
    {
      emitBranchActivityIfChanged: () => {},
      getCurrentBranchActivity: () => "main-running",
    } as unknown as AgentSessionManager,
    new Map(), new Map(), {} as RemotePatchCache,
  );
  const id = manager.getOrCreateSession("eval", "dev", "eval-user");
  const internal = manager as unknown as { createTools: (project: string, branch: string | null, sessionId?: string) => ToolSet };
  const original = internal.createTools.bind(manager);
  internal.createTools = (...args) => {
    const tools = original(...args);
    for (const [name, definition] of Object.entries(tools)) {
      if (name === "setPlan" || name === "complete_task") continue;
      // No shell, filesystem, browser, remote server or agent action can run.
      definition.execute = async () => {
        if (!readOnly.has(name) && manager.getSession(id)!.planState.blocked) {
          return { success: false, message: "Plan needs user confirmation." };
        }
        if (name === "getExecutorStatus") return {
          observedAt: new Date().toISOString(),
          executors: ["test", "dev-server"].map((name) => ({ name, status: "never_started", command: name === "test" ? "npm test" : "npm run dev" })),
        };
        if (name === "getAgentConversation") return { success: true, messages: [], message: "No coding agent has started. The project uses GitHub OAuth; no email/password login is implemented." };
        if (name === "listTerminals") return { success: true, terminals: [{ id: "eval-terminal", name: "Terminal" }] };
        if (readOnly.has(name)) return { success: true, content: "Development workspace ready." };
        return { success: true, message: "Operation started. Wait for its separate completion event; no completion has arrived yet." };
      };
    }
    return tools;
  };

  async function settle() {
    const deadline = Date.now() + 120_000;
    while (manager.getSession(id)!.abortController && !manager.getSession(id)!.pendingApproval) {
      if (Date.now() > deadline) throw new Error("Commander did not finish or reach approval within 120 seconds");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async function bounded(action: () => Promise<unknown>) {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; manager.stopGeneration(id); }, 120_000);
    try { await action(); await settle(); } finally { clearTimeout(timer); }
    if (timedOut) throw new Error("Commander evaluation timed out after 120 seconds");
    const errors = manager.getMessages(id).filter((message) => message.type === "error");
    if (errors.length) throw new Error(`Commander returned ${errors.length} stream error(s); inspect the transcript.`);
  }
  return {
    manager, id,
    messages: () => manager.getMessages(id),
    async send(text: string) { await bounded(() => manager.sendMessage(id, text)); },
    async decide(approved: boolean) {
      const request = [...manager.getMessages(id)].reverse().find((message) =>
        message.type === "tool_approval_request" && message.tool === "setPlan" && !message.resolved);
      if (request?.type !== "tool_approval_request") throw new Error("Expected a pending setPlan approval request");
      await bounded(async () => {
        if (!manager.resolveToolApproval(id, request.approvalId, approved)) throw new Error("Approval was not accepted");
      });
    },
    stop: () => manager.stopGeneration(id),
  };
}
