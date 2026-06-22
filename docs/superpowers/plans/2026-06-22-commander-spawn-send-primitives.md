# Commander Spawn/Send Agent Primitives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Main Chat commander two new tools — `spawnAgentSession` (create a coding agent in the current workspace and hand it a task) and `sendToAgentSession` (send a follow-up message to the workspace's existing agent) — wired into the existing task-completion wake loop.

**Architecture:** Both tools are added to `ChatSessionManager.createTools()` and call the existing `AgentSessionManager` methods (`getSessionByBranch`, `createNewSession`, `sendUserMessage`). Spawned/targeted agent runs on the commander's own `project+branch` (no worktree creation). The tools register the agent session in `chatInitiatedAgentTasks` and enable event listening, so the already-built `handleSessionTaskCompleted` handler wakes the commander when the agent finishes. No storage, schema, or route changes.

**Tech Stack:** TypeScript (backend ESM, NodeNext), Vercel `ai` SDK `tool()` + `zod` schemas, Next.js/React frontend.

## Global Constraints

- **Scope = primitives only.** No plan-first gating, no subtask storage, no approval bubbling, no cross-branch parallelism / worktree creation. (Per spec `docs/superpowers/specs/2026-06-22-commander-spawn-send-primitives-design.md` §1.)
- **Spawned agent always runs on the commander's own `project+branch`** — pass the project **root** path (`project.path`); `createNewSession`/`restartSession` resolve the worktree internally via `resolveWorktreePath`.
- **Permission mode is hard-coded `"edit"`** for spawned agents. Not exposed to the commander.
- **`AgentType` is `"claude-code" | "codex"`** (`packages/vibedeckx/src/agent-types.ts:7`); default `"claude-code"`.
- **No test framework is configured** (per `CLAUDE.md`). Verification per task = type-check (`npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` for backend, `cd apps/vibedeckx-ui && npx tsc --noEmit` for frontend) plus the manual e2e procedure in the final task. Do not invent a test runner.
- Backend ESM: all local imports use `.js` extensions.

---

### Task 1: `spawnAgentSession` tool

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (import line ~15; new tool inside `createTools()` return object, after `getAgentConversation` which ends near line ~1340)

**Interfaces:**
- Consumes (existing, verified):
  - `storage.projects.getById(projectId): { path?: string } | undefined`
  - `agentSessionManager.getSessionByBranch(projectId, branch): RunningSession | null` (has `.id`, `.status`, `.dormant`)
  - `agentSessionManager.createNewSession(projectId: string, branch: string | null, projectPath: string, skipDb?: boolean, permissionMode?: "plan"|"edit", agentType?: AgentType): string`
  - `agentSessionManager.sendUserMessage(sessionId: string, content: string, projectPath?: string): boolean`
  - `this.registerChatInitiatedAgentTask(agentSessionId: string): void`
  - `this.setEventListening(sessionId: string, enabled: boolean): boolean`
- Produces: tool key `spawnAgentSession` returning `{ success: boolean; agentSessionId?: string; message: string }`.

- [ ] **Step 1: Import `AgentType`**

In `packages/vibedeckx/src/chat-session-manager.ts`, change the existing import (currently line 15):

```ts
import type { AgentMessage, AgentSessionStatus } from "./agent-types.js";
```

to:

```ts
import type { AgentMessage, AgentSessionStatus, AgentType } from "./agent-types.js";
```

- [ ] **Step 2: Add the `spawnAgentSession` tool**

Inside the object returned by `createTools()`, immediately after the `getAgentConversation: tool({ ... }),` entry, add:

```ts
      spawnAgentSession: tool({
        description:
          "Start a brand-new coding agent in THIS workspace and hand it a task. " +
          "Use this when this workspace has no coding agent yet and a sub-goal genuinely needs an autonomous, multi-step coding agent (not a one-off terminal/executor action). " +
          "The agent runs in edit mode on this workspace's branch: it executes autonomously and does NOT ask for per-step approval. " +
          "Asynchronous — see async-execution-model: this only kicks the agent off. Its completion arrives later as an '[Agent Event: Task Completed]' message that wakes you. Do NOT claim the task is done based on this tool's return value. " +
          "If this workspace already has an agent, use sendToAgentSession instead.",
        inputSchema: z.object({
          prompt: z
            .string()
            .min(1)
            .describe(
              "The task / sub-goal to hand to the new coding agent. Because it runs autonomously in edit mode, spell out any irreversible or destructive-operation boundaries it must respect.",
            ),
          agentType: z
            .enum(["claude-code", "codex"])
            .optional()
            .describe("Which agent to spawn. Defaults to claude-code."),
        }),
        execute: async ({ prompt, agentType }) => {
          if (!sessionId) {
            return { success: false, message: "No session context available." };
          }
          const project = storage.projects.getById(projectId);
          if (!project?.path) {
            return { success: false, message: "No project path configured for this workspace." };
          }
          const existing = agentSessionManager.getSessionByBranch(projectId, branch);
          if (existing) {
            return {
              success: false,
              message:
                "This workspace already has a coding agent. Use sendToAgentSession to send it a message instead.",
            };
          }
          const newSessionId = agentSessionManager.createNewSession(
            projectId,
            branch,
            project.path,
            false,
            "edit",
            (agentType as AgentType | undefined) ?? "claude-code",
          );
          agentSessionManager.sendUserMessage(newSessionId, prompt, project.path);
          this.registerChatInitiatedAgentTask(newSessionId);
          this.setEventListening(sessionId, true);
          return {
            success: true,
            agentSessionId: newSessionId,
            message:
              "Coding agent started and given the task. It runs autonomously; you'll be woken with an '[Agent Event: Task Completed]' message when it finishes. Do not claim completion yet.",
          };
        },
      }),
```

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no errors). If `AgentType` import is unused elsewhere, it is used by the cast above.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: add spawnAgentSession commander tool"
```

---

### Task 2: `sendToAgentSession` tool

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (new tool inside `createTools()` return object, immediately after `spawnAgentSession`)

**Interfaces:**
- Consumes (existing, verified): same `agentSessionManager.getSessionByBranch`, `agentSessionManager.sendUserMessage`, `this.registerChatInitiatedAgentTask`, `this.setEventListening`, `storage.projects.getById` as Task 1.
- Produces: tool key `sendToAgentSession` returning `{ success: boolean; message: string }`.

- [ ] **Step 1: Add the `sendToAgentSession` tool**

Immediately after the `spawnAgentSession: tool({ ... }),` entry, add:

```ts
      sendToAgentSession: tool({
        description:
          "Send a follow-up message to the coding agent already running in THIS workspace — to chain the next step, correct course, or answer a question it raised. " +
          "Asynchronous — see async-execution-model: the agent processes it and its completion arrives later as an '[Agent Event: Task Completed]' message that wakes you. Do NOT claim the task is done based on this tool's return value. " +
          "If this workspace has no agent yet, use spawnAgentSession instead. " +
          "If the agent is mid-turn (busy), this will not send — wait to be woken when it finishes, then send.",
        inputSchema: z.object({
          message: z
            .string()
            .min(1)
            .describe("The message to send to the coding agent."),
        }),
        execute: async ({ message }) => {
          if (!sessionId) {
            return { success: false, message: "No session context available." };
          }
          const project = storage.projects.getById(projectId);
          const target = agentSessionManager.getSessionByBranch(projectId, branch);
          if (!target) {
            return {
              success: false,
              message:
                "This workspace has no coding agent yet. Use spawnAgentSession to start one.",
            };
          }
          if (target.status === "running") {
            return {
              success: false,
              message:
                "The coding agent is busy mid-turn. You'll be woken with an '[Agent Event: Task Completed]' message when it finishes — send your message then.",
            };
          }
          const sent = agentSessionManager.sendUserMessage(target.id, message, project?.path);
          if (!sent) {
            return { success: false, message: "Failed to deliver the message to the coding agent." };
          }
          this.registerChatInitiatedAgentTask(target.id);
          this.setEventListening(sessionId, true);
          return {
            success: true,
            message:
              "Message delivered to the coding agent. You'll be woken with an '[Agent Event: Task Completed]' message when it finishes. Do not claim completion yet.",
          };
        },
      }),
```

- [ ] **Step 2: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: add sendToAgentSession commander tool"
```

---

### Task 3: System-prompt tool descriptions

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` — the `<agent-tools>` block in `getSystemPrompt()` (currently lines ~1140-1144)

**Interfaces:**
- Consumes: nothing new. This is prompt copy that documents Task 1 & 2 tools.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Expand the `<agent-tools>` section**

Replace this block (currently lines ~1140-1144):

```ts
    sections.push(
      "  <agent-tools>",
      "  - getAgentConversation: view the coding agent's conversation history. Use when the user asks about what the agent is doing, has done, or references agent activities.",
      "  </agent-tools>",
    );
```

with:

```ts
    sections.push(
      "  <agent-tools>",
      "  - getAgentConversation: view the coding agent's conversation history. Use when the user asks about what the agent is doing, has done, or references agent activities.",
      "  - spawnAgentSession: start a NEW coding agent in this workspace and hand it a task. Use only when this workspace has no agent yet AND the sub-goal needs an autonomous multi-step coding agent (not a terminal/executor action). The agent runs in edit mode (autonomous, no per-step approval) on this branch.",
      "  - sendToAgentSession: send a follow-up message to the coding agent ALREADY running in this workspace (chain next step / correct course / answer its question).",
      "  - Choosing between them: no agent here yet → spawnAgentSession; an agent already exists → sendToAgentSession. Both are asynchronous (see async-execution-model): completion arrives later as an '[Agent Event: Task Completed]' message that wakes you — never claim the task is done from the kick-off tool's return value.",
      "  - Safety (transitional): spawned agents run in edit mode with no approval prompts and may perform destructive operations. When delegating, write any irreversible/dangerous-operation boundaries directly into the prompt you give the agent.",
      "  </agent-tools>",
    );
```

- [ ] **Step 2: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: document spawn/send agent tools in commander system prompt"
```

---

### Task 4: Frontend tool labels

**Files:**
- Modify: `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` — `getToolLabel()` switch (currently lines 57-70)

**Interfaces:**
- Consumes: nothing. `getToolLabel` already has a `default` fallback that renders unknown tools as `Running ${tool}...`.
- Produces: friendly labels for the two new tool names.

- [ ] **Step 1: Add the two cases**

In `getToolLabel`, add these two cases before `default:`:

```ts
    case "spawnAgentSession":
      return "Starting a coding agent...";
    case "sendToAgentSession":
      return "Sending a message to the agent...";
```

The full switch becomes:

```ts
function getToolLabel(tool: string): string {
  switch (tool) {
    case "getExecutorStatus":
      return "Checking executor status...";
    case "getAgentConversation":
      return "Checking agent conversation...";
    case "listTerminals":
      return "Listing terminals...";
    case "runInTerminal":
      return "Sending command to terminal...";
    case "spawnAgentSession":
      return "Starting a coding agent...";
    case "sendToAgentSession":
      return "Sending a message to the agent...";
    default:
      return `Running ${tool}...`;
  }
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation/main-conversation.tsx
git commit -m "feat: add chat tool labels for spawn/send agent tools"
```

---

### Task 5: End-to-end manual verification

**Files:** none (verification only).

**Interfaces:** exercises Tasks 1-4 together.

- [ ] **Step 1: Build / run the dev stack**

Run: `pnpm dev:all`
Expected: backend on 5173, frontend on 3000, no startup errors.

- [ ] **Step 2: Spawn happy path**

In a workspace's Main Chat (with no coding agent running on that branch), ask the commander to make a small change (e.g. "add a comment to README"). Confirm:
- The commander calls `spawnAgentSession` (label "Starting a coding agent...").
- A coding agent session appears in the agent window for that workspace and executes.
- The commander's return does NOT claim completion; it states the agent was started.

- [ ] **Step 3: Wake/report loop**

When the agent finishes, confirm the commander receives an `[Agent Event: Task Completed]` message and reports a 1-2 sentence summary. Confirm the workspace dot is driven as a workflow continuation (not treated as a passive agent-window summary).

- [ ] **Step 4: Send happy path**

With that agent now idle (turn ended), ask the commander to give a follow-up instruction. Confirm it calls `sendToAgentSession` (label "Sending a message to the agent...") and the agent receives and acts on it.

- [ ] **Step 5: Boundary checks**

- Ask the commander to spawn again while the agent exists → confirm `spawnAgentSession` is refused with the "already has a coding agent... use sendToAgentSession" message.
- In a fresh workspace with no agent, ask the commander to send a message → confirm `sendToAgentSession` errors with "no coding agent yet... use spawnAgentSession".
- While an agent is mid-turn, ask the commander to send → confirm `sendToAgentSession` returns the "busy mid-turn" message and does not interleave input.

- [ ] **Step 6: Final type-check sweep**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && (cd apps/vibedeckx-ui && npx tsc --noEmit)`
Expected: both PASS.
