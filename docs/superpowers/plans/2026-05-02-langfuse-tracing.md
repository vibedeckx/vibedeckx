# Langfuse Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Langfuse v4 (OpenTelemetry-based) tracing to every Vercel AI SDK call in vibedeckx — chat sessions, session-title generation, translate, and task-suggest — so they appear in the Langfuse UI grouped by sessionId/userId.

**Architecture:** Langfuse v4 + OTel `NodeSDK` registered at process start in a dedicated `instrumentation.ts` imported as the very first line of `bin.ts`. Each AI SDK call gets `experimental_telemetry: { isEnabled: true, functionId, metadata: { sessionId?, userId, tags, projectId, branch? } }`. userId resolves from `requireAuth(req)`; `undefined` returns map to `"local"`. No DB schema changes; no migrations.

**Tech Stack:** `@langfuse/otel`, `@opentelemetry/sdk-node`, Vercel AI SDK v6 (`ai`), Fastify, Clerk.

**Spec:** [docs/superpowers/specs/2026-05-02-langfuse-tracing-design.md](../specs/2026-05-02-langfuse-tracing-design.md)

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| create | `packages/vibedeckx/src/instrumentation.ts` | NodeSDK + LangfuseSpanProcessor lifecycle, env-gated start, signal handlers |
| create | `packages/vibedeckx/src/utils/resolve-user-id.ts` | Single helper `resolveUserId(authResult)` — maps `requireAuth` return to a non-empty trace userId string |
| modify | `packages/vibedeckx/src/bin.ts` | Add `import "./instrumentation.js"` as the first import |
| modify | `packages/vibedeckx/package.json` | Add `@langfuse/otel`, `@opentelemetry/sdk-node` |
| modify | `packages/vibedeckx/src/chat-session-manager.ts` | Add `userId: string` to `ChatSession`; thread into `getOrCreateSession`; add telemetry block to `streamText` |
| modify | `packages/vibedeckx/src/routes/chat-session-routes.ts` | Pass userId into `getOrCreateSession`; add `requireAuth` to message route |
| modify | `packages/vibedeckx/src/utils/session-title.ts` | Add `userId` parameter to `generateSessionTitle`; telemetry block on `generateText` |
| modify | `packages/vibedeckx/src/agent-session-manager.ts` | Thread userId through `sendUserMessage` → `persistEntry` → `ensureSessionTitle` → `generateSessionTitle` |
| modify | `packages/vibedeckx/src/routes/agent-session-routes.ts` | Pass userId into `sendUserMessage`; add `requireAuth` to message endpoint; pass userId into `generateAndPushRemoteSessionTitle` and downstream `generateSessionTitle` |
| modify | `packages/vibedeckx/src/routes/translate-routes.ts` | Telemetry block on `generateText` |
| modify | `packages/vibedeckx/src/routes/task-routes.ts` | Telemetry block on `generateText` |

---

## Phase 1 — Dependencies and Instrumentation Bootstrap

### Task 1: Install Langfuse + OTel SDK packages

**Files:**
- Modify: `packages/vibedeckx/package.json`

- [ ] **Step 1: Add the dependencies via pnpm**

Run from repo root:

```bash
pnpm add --filter vibedeckx @langfuse/otel @opentelemetry/sdk-node
```

- [ ] **Step 2: Verify the dependencies landed in `packages/vibedeckx/package.json`**

Run:

```bash
cat packages/vibedeckx/package.json | grep -E "@langfuse/otel|@opentelemetry/sdk-node"
```

Expected: two lines printed showing both packages with version specifiers.

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/package.json pnpm-lock.yaml
git commit -m "feat(deps): add @langfuse/otel and @opentelemetry/sdk-node"
```

---

### Task 2: Create `instrumentation.ts`

**Files:**
- Create: `packages/vibedeckx/src/instrumentation.ts`

- [ ] **Step 1: Create the file**

```ts
// packages/vibedeckx/src/instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const enabled =
  !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;

export const langfuseSpanProcessor = enabled
  ? new LangfuseSpanProcessor()
  : null;

if (enabled && langfuseSpanProcessor) {
  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
  sdk.start();
  console.log("[Langfuse] tracing enabled");

  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch {
      // best-effort
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} else {
  console.log("[Langfuse] tracing disabled (LANGFUSE_PUBLIC_KEY not set)");
}
```

- [ ] **Step 2: Type-check the new file**

Run:

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors. If `@langfuse/otel` types are missing, re-run `pnpm install` to ensure type packages are resolved.

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/instrumentation.ts
git commit -m "feat(observability): add langfuse OTel instrumentation bootstrap"
```

---

### Task 3: Wire `instrumentation.ts` into `bin.ts`

**Files:**
- Modify: `packages/vibedeckx/src/bin.ts`

- [ ] **Step 1: Read current contents to confirm starting state**

```bash
cat packages/vibedeckx/src/bin.ts
```

Expected current contents (4 lines + shebang):

```ts
#!/usr/bin/env node

import { run } from "@stricli/core";
import { program } from "./command.js";

run(program, process.argv.slice(2), { process });
```

- [ ] **Step 2: Add the instrumentation import as the first non-shebang line**

Final contents must be:

```ts
#!/usr/bin/env node

import "./instrumentation.js";
import { run } from "@stricli/core";
import { program } from "./command.js";

run(program, process.argv.slice(2), { process });
```

The order is critical: `./instrumentation.js` must precede every other import so the OTel SDK starts before any AI-SDK module loads.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Smoke-test the CLI starts with tracing disabled**

Run from a clean shell (no Langfuse env vars):

```bash
unset LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY
node -e "import('./packages/vibedeckx/src/instrumentation.ts').catch(e => { console.error(e); process.exit(1); })" 2>&1 | head -5
```

Easier alternative — run via tsc dev mode:

```bash
pnpm --filter vibedeckx dev &
DEVPID=$!
sleep 3
kill $DEVPID 2>/dev/null
```

Expected: server log includes `[Langfuse] tracing disabled (LANGFUSE_PUBLIC_KEY not set)`.

- [ ] **Step 5: Smoke-test with tracing enabled (no real backend needed)**

```bash
LANGFUSE_PUBLIC_KEY=pk-test LANGFUSE_SECRET_KEY=sk-test pnpm --filter vibedeckx dev &
DEVPID=$!
sleep 3
kill $DEVPID 2>/dev/null
```

Expected: server log includes `[Langfuse] tracing enabled`. No crash.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/bin.ts
git commit -m "feat(observability): import langfuse instrumentation at CLI entry"
```

---

### Task 4: Verify esbuild bundle still works

**Files:**
- Modify: `packages/vibedeckx/esbuild.config.mjs` (only if bundle fails)

- [ ] **Step 1: Run the production bundle build**

```bash
pnpm --filter vibedeckx build
```

Expected: `dist/bin.js` is produced without errors. If the build complains about missing modules under `@opentelemetry/...` (e.g. auto-instrumentation packages we did not install), proceed to Step 2; otherwise skip to Step 4.

- [ ] **Step 2: Mark missing OTel sub-packages as external**

Edit `packages/vibedeckx/esbuild.config.mjs` and append to the `external` array. The current array is:

```js
external: ["node-pty", "better-sqlite3", "playwright-core"],
```

Replace with (only if Step 1 failed):

```js
external: [
  "node-pty",
  "better-sqlite3",
  "playwright-core",
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@langfuse/otel",
],
```

- [ ] **Step 3: Re-run the build**

```bash
pnpm --filter vibedeckx build
```

Expected: success.

- [ ] **Step 4: Smoke-test the built CLI starts**

```bash
LANGFUSE_PUBLIC_KEY=pk-test LANGFUSE_SECRET_KEY=sk-test \
  node packages/vibedeckx/dist/bin.js --help 2>&1 | head -10
```

Expected: stricli prints help text. Log line `[Langfuse] tracing enabled` appears.

- [ ] **Step 5: Commit (only if Step 2 ran)**

```bash
git add packages/vibedeckx/esbuild.config.mjs
git commit -m "build: mark OTel packages external in esbuild bundle"
```

---

## Phase 2 — userId Resolution Helper

### Task 5: Create `resolveUserId` helper

**Files:**
- Create: `packages/vibedeckx/src/utils/resolve-user-id.ts`

- [ ] **Step 1: Create the file**

```ts
// packages/vibedeckx/src/utils/resolve-user-id.ts

/**
 * Map a `requireAuth` return value into a non-empty userId string suitable
 * for Langfuse trace metadata. `undefined` (no-auth mode and remote-proxy
 * api-key path both return undefined) collapses to `"local"`. `null` —
 * which `requireAuth` returns when it has already sent a 401 reply —
 * never reaches code that needs to call this helper, but we still handle
 * it defensively as `"local"`.
 */
export function resolveUserId(authResult: string | undefined | null): string {
  return typeof authResult === "string" ? authResult : "local";
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/utils/resolve-user-id.ts
git commit -m "feat(observability): add resolveUserId helper for trace metadata"
```

---

## Phase 3 — Chat Session userId Threading + Telemetry

### Task 6: Add `userId` to `ChatSession` and `getOrCreateSession`

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:39-48` (interface), `:778-801` (`getOrCreateSession`)

- [ ] **Step 1: Add `userId` field to `ChatSession` interface**

Replace the current interface (around line 39):

```ts
interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  store: ChatStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  abortController: AbortController | null;
  eventListeningEnabled: boolean;
}
```

with:

```ts
interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  userId: string;
  store: ChatStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  abortController: AbortController | null;
  eventListeningEnabled: boolean;
}
```

- [ ] **Step 2: Update `getOrCreateSession` to accept and store `userId`**

Replace the current method (around line 778):

```ts
  getOrCreateSession(projectId: string, branch: string | null): string {
    const key = `${projectId}:${branch ?? ""}`;
    const existing = this.sessionIndex.get(key);
    if (existing && this.sessions.has(existing)) {
      return existing;
    }

    const id = randomUUID();
    const session: ChatSession = {
      id,
      projectId,
      branch,
      store: { patches: [], entries: [], nextIndex: 0 },
      subscribers: new Set(),
      status: "stopped",
      abortController: null,
      eventListeningEnabled: false,
    };

    this.sessions.set(id, session);
    this.sessionIndex.set(key, id);
    console.log(`[ChatSession] Created session ${id} for project=${projectId} branch=${branch}`);
    return id;
  }
```

with:

```ts
  getOrCreateSession(projectId: string, branch: string | null, userId: string): string {
    const key = `${projectId}:${branch ?? ""}`;
    const existing = this.sessionIndex.get(key);
    if (existing && this.sessions.has(existing)) {
      return existing;
    }

    const id = randomUUID();
    const session: ChatSession = {
      id,
      projectId,
      branch,
      userId,
      store: { patches: [], entries: [], nextIndex: 0 },
      subscribers: new Set(),
      status: "stopped",
      abortController: null,
      eventListeningEnabled: false,
    };

    this.sessions.set(id, session);
    this.sessionIndex.set(key, id);
    console.log(`[ChatSession] Created session ${id} for project=${projectId} branch=${branch} userId=${userId}`);
    return id;
  }
```

- [ ] **Step 3: Type-check (will fail at the call site in chat-session-routes.ts — this is expected and Task 7 fixes it)**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: a TS error at `packages/vibedeckx/src/routes/chat-session-routes.ts:22` saying `Expected 3 arguments, but got 2.` Move on; Task 7 supplies the missing argument.

---

### Task 7: Update chat-session-routes to pass userId

**Files:**
- Modify: `packages/vibedeckx/src/routes/chat-session-routes.ts:10-61`

- [ ] **Step 1: Add `requireAuth` to message endpoint and pass userId at session creation**

Replace lines 10-61 with:

```ts
const routes: FastifyPluginAsync = async (fastify) => {
  // Create or get existing chat session for a project+branch
  fastify.post<{
    Params: { projectId: string };
    Body: { branch?: string | null };
  }>("/api/projects/:projectId/chat-sessions", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const { projectId } = req.params;
    const branch = req.body?.branch ?? null;

    const sessionId = fastify.chatSessionManager.getOrCreateSession(
      projectId,
      branch,
      resolveUserId(userId),
    );
    const session = fastify.chatSessionManager.getSession(sessionId);
    const messages = fastify.chatSessionManager.getMessages(sessionId);

    return reply.send({
      session: {
        id: session!.id,
        projectId: session!.projectId,
        branch: session!.branch,
        status: session!.status,
        eventListeningEnabled: session!.eventListeningEnabled,
      },
      messages,
    });
  });

  // Send a user message (triggers AI streaming)
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string };
  }>("/api/chat-sessions/:sessionId/message", async (req, reply) => {
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;

    const { sessionId } = req.params;
    const { content } = req.body;

    if (!content?.trim()) {
      return reply.code(400).send({ error: "Message content is required" });
    }

    const session = fastify.chatSessionManager.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    // Fire and forget — response streams over WebSocket
    fastify.chatSessionManager.sendMessage(sessionId, content.trim()).catch((err) => {
      console.error(`[ChatRoutes] sendMessage error for ${sessionId}:`, err);
    });

    return reply.send({ ok: true });
  });
```

- [ ] **Step 2: Add the helper import at the top of the file**

After the existing imports at the top of `routes/chat-session-routes.ts`, add:

```ts
import { resolveUserId } from "../utils/resolve-user-id.js";
```

The full import block should look like:

```ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";
```

- [ ] **Step 3: Type-check the chat-session paths**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors related to `chat-session-routes.ts` or `chat-session-manager.ts`. (Errors in agent-session areas are still fine — those are fixed in Phase 5.)

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts packages/vibedeckx/src/routes/chat-session-routes.ts
git commit -m "feat(chat): thread userId into chat session creation for tracing"
```

---

### Task 8: Add telemetry block to chat session `streamText`

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:1828-1836`

- [ ] **Step 1: Replace the `streamText` call with the version that includes telemetry**

Find the existing call (around line 1828):

```ts
      const result = streamText({
        model: resolveChatModel(this.storage),
        system: this.getSystemPrompt(session.projectId, session.branch),
        messages,
        tools: this.createTools(session.projectId, session.branch, session.id),
        stopWhen: stepCountIs(3),
        abortSignal: abortController.signal,
      });
```

Replace with:

```ts
      const result = streamText({
        model: resolveChatModel(this.storage),
        system: this.getSystemPrompt(session.projectId, session.branch),
        messages,
        tools: this.createTools(session.projectId, session.branch, session.id),
        stopWhen: stepCountIs(3),
        abortSignal: abortController.signal,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "chat-session",
          metadata: {
            sessionId: session.id,
            userId: session.userId,
            tags: ["vibedeckx", "chat-session"],
            projectId: session.projectId,
            branch: session.branch ?? "(default)",
          },
        },
      });
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat(observability): add langfuse telemetry to chat session streamText"
```

---

## Phase 4 — One-Shot generateText Telemetry (Translate, Task)

### Task 9: Add telemetry to translate route

**Files:**
- Modify: `packages/vibedeckx/src/routes/translate-routes.ts`

- [ ] **Step 1: Replace the route handler body with the telemetry-enabled version**

Replace lines 8-43 with:

```ts
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { text: string } }>(
    "/api/translate",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const { text } = req.body;
      if (!text || !text.trim()) {
        return reply.code(400).send({ error: "text is required" });
      }

      try {
        const { text: translatedText } = await generateText({
          model: resolveChatModel(fastify.storage),
          prompt: `You are a precise translation assistant for software development.
Translate the following text into English. This text is an instruction for an AI coding agent.

Rules:
1. Preserve ALL technical terms exactly (function names, variable names, file paths, CLI commands, package names, code snippets)
2. Preserve all markdown formatting, code blocks, and special characters
3. If the text is already in English, return it EXACTLY as-is
4. Return ONLY the translated text, nothing else

Text:
${text}`,
          experimental_telemetry: {
            isEnabled: true,
            functionId: "translate",
            metadata: {
              userId: resolveUserId(userId),
              tags: ["vibedeckx", "translate"],
            },
          },
        });

        return reply.code(200).send({ translatedText: translatedText.trim() });
      } catch (error) {
        console.error("[translate] Translation failed:", error);
        return reply.code(500).send({ error: "Translation failed" });
      }
    }
  );
};
```

- [ ] **Step 2: Add the import**

The full imports block at the top of `translate-routes.ts` should be:

```ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { generateText } from "ai";
import { resolveChatModel } from "../utils/chat-model.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors in `translate-routes.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/translate-routes.ts
git commit -m "feat(observability): add langfuse telemetry to translate route"
```

---

### Task 10: Add telemetry to task-suggest generateText

**Files:**
- Modify: `packages/vibedeckx/src/routes/task-routes.ts:42-54`

- [ ] **Step 1: Replace the `generateText` call with the telemetry-enabled version**

Find the call (around lines 42-54):

```ts
    let title = providedTitle;
    if (!title) {
      try {
        const { text } = await generateText({
          model: resolveChatModel(fastify.storage),
          prompt: `Generate a concise task title (under 10 words) that captures the essence of this task description. Return only the title text, nothing else.\n\nDescription: ${description}`,
        });
        title = text.trim();
      } catch {
        title = description.length > 50 ? description.slice(0, 50) + "..." : description;
      }
    }
```

Replace with:

```ts
    let title = providedTitle;
    if (!title) {
      try {
        const { text } = await generateText({
          model: resolveChatModel(fastify.storage),
          prompt: `Generate a concise task title (under 10 words) that captures the essence of this task description. Return only the title text, nothing else.\n\nDescription: ${description}`,
          experimental_telemetry: {
            isEnabled: true,
            functionId: "task-suggest",
            metadata: {
              userId: resolveUserId(userId),
              tags: ["vibedeckx", "task-suggest"],
              projectId: req.params.projectId,
            },
          },
        });
        title = text.trim();
      } catch {
        title = description.length > 50 ? description.slice(0, 50) + "..." : description;
      }
    }
```

- [ ] **Step 2: Add the import**

After the existing imports at the top of `task-routes.ts`, add:

```ts
import { resolveUserId } from "../utils/resolve-user-id.js";
```

The full imports block should be:

```ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { resolveChatModel } from "../utils/chat-model.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: no errors in `task-routes.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/task-routes.ts
git commit -m "feat(observability): add langfuse telemetry to task-suggest"
```

---

## Phase 5 — Agent Session userId Threading for session-title

### Task 11: Add `userId` parameter to `generateSessionTitle`

**Files:**
- Modify: `packages/vibedeckx/src/utils/session-title.ts:64-100`

- [ ] **Step 1: Update the function signature and add the telemetry block**

Replace the existing `generateSessionTitle` (lines 64-100):

```ts
export async function generateSessionTitle(
  storage: Storage,
  userMessage: string,
): Promise<string | null> {
  if (!isChatModelConfigured(storage)) return null;
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return null;

  // Cap the prompt so a giant first message doesn't blow up the token budget.
  const MAX_INPUT_CHARS = 2000;
  const input = trimmed.length > MAX_INPUT_CHARS
    ? trimmed.slice(0, MAX_INPUT_CHARS) + "…"
    : trimmed;

  try {
    const result = await Promise.race([
      generateText({
        model: resolveChatModel(storage),
        system:
          "You write very short, descriptive titles for chat conversations. " +
          "Reply with the title only — no quotes, no trailing punctuation, no markdown, no prefixes like 'Title:'. " +
          "Use the same language as the user's message. Keep it under 8 words and 50 characters.",
        prompt: `Generate a title for a conversation that begins with this user message:\n\n${input}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("title generation timed out")), AI_TIMEOUT_MS),
      ),
    ]);

    const text = (result as { text?: string }).text ?? "";
    const sanitized = sanitizeTitle(text);
    return sanitized.length > 0 ? sanitized : null;
  } catch (error) {
    console.warn("[SessionTitle] AI generation failed:", (error as Error).message);
    return null;
  }
}
```

with:

```ts
export async function generateSessionTitle(
  storage: Storage,
  userMessage: string,
  userId: string,
): Promise<string | null> {
  if (!isChatModelConfigured(storage)) return null;
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return null;

  // Cap the prompt so a giant first message doesn't blow up the token budget.
  const MAX_INPUT_CHARS = 2000;
  const input = trimmed.length > MAX_INPUT_CHARS
    ? trimmed.slice(0, MAX_INPUT_CHARS) + "…"
    : trimmed;

  try {
    const result = await Promise.race([
      generateText({
        model: resolveChatModel(storage),
        system:
          "You write very short, descriptive titles for chat conversations. " +
          "Reply with the title only — no quotes, no trailing punctuation, no markdown, no prefixes like 'Title:'. " +
          "Use the same language as the user's message. Keep it under 8 words and 50 characters.",
        prompt: `Generate a title for a conversation that begins with this user message:\n\n${input}`,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "session-title",
          metadata: {
            userId,
            tags: ["vibedeckx", "session-title"],
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("title generation timed out")), AI_TIMEOUT_MS),
      ),
    ]);

    const text = (result as { text?: string }).text ?? "";
    const sanitized = sanitizeTitle(text);
    return sanitized.length > 0 ? sanitized : null;
  } catch (error) {
    console.warn("[SessionTitle] AI generation failed:", (error as Error).message);
    return null;
  }
}
```

- [ ] **Step 2: Type-check (will fail at callers — fixed in next tasks)**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: TS errors at:
- `packages/vibedeckx/src/agent-session-manager.ts:1402` — `generateSessionTitle(this.storage, userText)` missing arg.
- `packages/vibedeckx/src/routes/agent-session-routes.ts:86` — `generateSessionTitle(fastify.storage, userText)` missing arg.

These are expected and resolved in Tasks 12-14.

---

### Task 12: Thread userId through `agentSessionManager.sendUserMessage` → `persistEntry` → `ensureSessionTitle`

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts` — `sendUserMessage` (line 783), `pushEntry` (line 704), `persistEntry` (line 739), `ensureSessionTitle` (line 1398), `wakeDormantSession` (line 1253)

- [ ] **Step 1: Update `sendUserMessage` signature**

Find (around line 783):

```ts
  sendUserMessage(sessionId: string, content: string | ContentPart[], projectPath?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // If session is dormant, wake it up
    if (session.dormant) {
      if (!projectPath) {
        console.error(`[AgentSession] Cannot wake dormant session ${sessionId} without projectPath`);
        return false;
      }
      this.wakeDormantSession(session, projectPath, content);
      return true;
    }
```

Replace with:

```ts
  sendUserMessage(
    sessionId: string,
    content: string | ContentPart[],
    projectPath?: string,
    userId: string = "local",
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // If session is dormant, wake it up
    if (session.dormant) {
      if (!projectPath) {
        console.error(`[AgentSession] Cannot wake dormant session ${sessionId} without projectPath`);
        return false;
      }
      this.wakeDormantSession(session, projectPath, content, userId);
      return true;
    }
```

- [ ] **Step 2: Update the user-message `pushEntry` call inside `sendUserMessage` to pass userId through**

Find (around line 815-820 inside `sendUserMessage`):

```ts
    // Add user message with ADD patch
    this.pushEntry(sessionId, {
      type: "user",
      content,
      timestamp: Date.now(),
    }, true);
```

Replace with:

```ts
    // Add user message with ADD patch
    this.pushEntry(sessionId, {
      type: "user",
      content,
      timestamp: Date.now(),
    }, true, userId);
```

- [ ] **Step 3: Update `pushEntry` signature to accept and forward userId**

Find (around line 704):

```ts
  private pushEntry(
    sessionId: string,
    message: AgentMessage,
    broadcast: boolean = true
  ): number {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;

    const { store } = session;

    // Get next index from provider
    const index = store.indexProvider.next();

    // Store the entry
    store.entries[index] = message;

    // Create ADD patch
    const patch = ConversationPatch.addEntry(index, message);
    store.patches.push(patch);

    // Persist to DB (skip streaming assistant text — those get finalized later)
    if (!session.skipDb && message.type !== "assistant") {
      this.persistEntry(session, index, message);
    }

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }
```

Replace with:

```ts
  private pushEntry(
    sessionId: string,
    message: AgentMessage,
    broadcast: boolean = true,
    userId: string = "local",
  ): number {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;

    const { store } = session;

    // Get next index from provider
    const index = store.indexProvider.next();

    // Store the entry
    store.entries[index] = message;

    // Create ADD patch
    const patch = ConversationPatch.addEntry(index, message);
    store.patches.push(patch);

    // Persist to DB (skip streaming assistant text — those get finalized later)
    if (!session.skipDb && message.type !== "assistant") {
      this.persistEntry(session, index, message, userId);
    }

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }
```

- [ ] **Step 4: Update `persistEntry` signature and pass userId to `ensureSessionTitle`**

Find (around line 739):

```ts
  private persistEntry(session: RunningSession, index: number, message: AgentMessage): void {
    if (session.skipDb) return;
    try {
      this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
      this.storage.agentSessions.touchUpdatedAt(session.id);
      if (message.type === "user") {
        const now = Date.now();
        this.storage.agentSessions.markUserMessage(session.id, now);
        this.eventBus?.emit({
          type: "branch:activity",
          projectId: session.projectId,
          branch: session.branch,
          activity: "working",
          since: now,
        });
        const dbRow = this.storage.agentSessions.getById(session.id);
        if (dbRow && (dbRow.title === null || dbRow.title === undefined)) {
          const text = extractUserText(message.content);
          if (text.trim().length > 0 && this.markTitleResolved(session.id)) {
            void this.ensureSessionTitle(session, text);
          }
        }
      }
    } catch (error) {
      console.error(`[AgentSession] Failed to persist entry ${index}:`, error);
    }
  }
```

Replace with:

```ts
  private persistEntry(
    session: RunningSession,
    index: number,
    message: AgentMessage,
    userId: string = "local",
  ): void {
    if (session.skipDb) return;
    try {
      this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
      this.storage.agentSessions.touchUpdatedAt(session.id);
      if (message.type === "user") {
        const now = Date.now();
        this.storage.agentSessions.markUserMessage(session.id, now);
        this.eventBus?.emit({
          type: "branch:activity",
          projectId: session.projectId,
          branch: session.branch,
          activity: "working",
          since: now,
        });
        const dbRow = this.storage.agentSessions.getById(session.id);
        if (dbRow && (dbRow.title === null || dbRow.title === undefined)) {
          const text = extractUserText(message.content);
          if (text.trim().length > 0 && this.markTitleResolved(session.id)) {
            void this.ensureSessionTitle(session, text, userId);
          }
        }
      }
    } catch (error) {
      console.error(`[AgentSession] Failed to persist entry ${index}:`, error);
    }
  }
```

- [ ] **Step 5: Update `ensureSessionTitle` signature and pass userId to `generateSessionTitle`**

Find (around line 1398):

```ts
  private async ensureSessionTitle(session: RunningSession, userText: string): Promise<void> {
    const fallback = snippetTitle(userText);
    let title: string | null = null;
    try {
      title = await generateSessionTitle(this.storage, userText);
    } catch (error) {
      console.warn(`[AgentSession] Title generation threw for ${session.id}:`, error);
    }
```

Replace with:

```ts
  private async ensureSessionTitle(
    session: RunningSession,
    userText: string,
    userId: string,
  ): Promise<void> {
    const fallback = snippetTitle(userText);
    let title: string | null = null;
    try {
      title = await generateSessionTitle(this.storage, userText, userId);
    } catch (error) {
      console.warn(`[AgentSession] Title generation threw for ${session.id}:`, error);
    }
```

- [ ] **Step 6: Update `wakeDormantSession` signature to accept userId and forward it**

Find (around line 1253):

```ts
  private wakeDormantSession(session: RunningSession, projectPath: string, userMessage: string | ContentPart[]): void {
    console.log(`[AgentSession] Waking dormant session ${session.id}`);

    session.dormant = false;
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "running");
    this.broadcastPatch(session.id, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // Spawn Claude Code process
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);
    this.spawnAgent(session, absoluteWorktreePath);

    // Push user message to store (+ persist to DB)
    this.pushEntry(session.id, {
      type: "user",
      content: userMessage,
      timestamp: Date.now(),
    }, true);
```

Replace with:

```ts
  private wakeDormantSession(
    session: RunningSession,
    projectPath: string,
    userMessage: string | ContentPart[],
    userId: string = "local",
  ): void {
    console.log(`[AgentSession] Waking dormant session ${session.id}`);

    session.dormant = false;
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "running");
    this.broadcastPatch(session.id, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // Spawn Claude Code process
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);
    this.spawnAgent(session, absoluteWorktreePath);

    // Push user message to store (+ persist to DB)
    this.pushEntry(session.id, {
      type: "user",
      content: userMessage,
      timestamp: Date.now(),
    }, true, userId);
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: only one remaining error — `agent-session-routes.ts:86` (`generateSessionTitle(fastify.storage, userText)` missing arg). Fixed in Task 13. The `agentSessionManager.sendUserMessage(...)` call at `agent-session-routes.ts:747` is **not** an error because the new `userId` param has a default value.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/utils/session-title.ts
git commit -m "feat(agent): thread userId through sendUserMessage → ensureSessionTitle"
```

---

### Task 13: Update agent-session-routes to pass userId

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts:71-110` (`generateAndPushRemoteSessionTitle`), `:680-755` (message endpoint)

- [ ] **Step 1: Add `userId` parameter to `generateAndPushRemoteSessionTitle`**

Find (around line 71):

```ts
  async function generateAndPushRemoteSessionTitle(
    localSessionId: string,
    userText: string,
    remoteInfo: RemoteSessionInfo,
  ): Promise<void> {
    if (userText.trim().length === 0) return;
    // Cheap in-memory dedupe within this process lifetime.
    if (!fastify.agentSessionManager.markTitleResolved(localSessionId)) return;
    // Persistent dedupe across restarts: if a previous server lifetime already
    // resolved this session's title, don't regenerate (the new title would be
    // derived from a non-first message and would clobber the original).
    if (fastify.storage.remoteSessionMappings.isTitleResolved(localSessionId)) return;

    let aiTitle: string | null = null;
    try {
      aiTitle = await generateSessionTitle(fastify.storage, userText);
    } catch (error) {
      console.warn(
        `[SessionTitle] AI title generation threw for ${localSessionId}:`,
        (error as Error).message,
      );
    }
```

Replace with:

```ts
  async function generateAndPushRemoteSessionTitle(
    localSessionId: string,
    userText: string,
    remoteInfo: RemoteSessionInfo,
    userId: string,
  ): Promise<void> {
    if (userText.trim().length === 0) return;
    // Cheap in-memory dedupe within this process lifetime.
    if (!fastify.agentSessionManager.markTitleResolved(localSessionId)) return;
    // Persistent dedupe across restarts: if a previous server lifetime already
    // resolved this session's title, don't regenerate (the new title would be
    // derived from a non-first message and would clobber the original).
    if (fastify.storage.remoteSessionMappings.isTitleResolved(localSessionId)) return;

    let aiTitle: string | null = null;
    try {
      aiTitle = await generateSessionTitle(fastify.storage, userText, userId);
    } catch (error) {
      console.warn(
        `[SessionTitle] AI title generation threw for ${localSessionId}:`,
        (error as Error).message,
      );
    }
```

- [ ] **Step 2: Find the agent-session message route handler and add `requireAuth` plus userId threading**

Find the start of the `/api/agent-sessions/:sessionId/message` POST handler. Locate where the message endpoint is defined — search for `"/api/agent-sessions/:sessionId/message"` near line 680. Within the route handler, before the body-validation block, add:

```ts
    const authResult = requireAuth(req, reply);
    if (authResult === null) return;
    const userId = resolveUserId(authResult);
```

If `requireAuth` is already called near the top of the handler — re-use that local `userId`/`authResult`. Otherwise add the lines above as the first statements inside the handler body.

- [ ] **Step 3: Pass userId into the remote-title helper call**

Find (around line 729):

```ts
      void generateAndPushRemoteSessionTitle(
        req.params.sessionId,
        extractUserText(content),
        remoteInfo,
      );
```

Replace with:

```ts
      void generateAndPushRemoteSessionTitle(
        req.params.sessionId,
        extractUserText(content),
        remoteInfo,
        userId,
      );
```

- [ ] **Step 4: Pass userId into `agentSessionManager.sendUserMessage`**

Find (around line 747):

```ts
    const success = fastify.agentSessionManager.sendUserMessage(req.params.sessionId, content, projectPathForWake);
```

Replace with:

```ts
    const success = fastify.agentSessionManager.sendUserMessage(
      req.params.sessionId,
      content,
      projectPathForWake,
      userId,
    );
```

- [ ] **Step 5: Add the `resolveUserId` import at the top of the file**

If not already present, add to the imports block at the top of `routes/agent-session-routes.ts`:

```ts
import { resolveUserId } from "../utils/resolve-user-id.js";
```

- [ ] **Step 6: Type-check the entire backend**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/vibedeckx/src/routes/agent-session-routes.ts
git commit -m "feat(agent): pass userId from auth into agent-session message + title"
```

---

### Task 14: Confirm no other callers of `generateSessionTitle` were missed

**Files:**
- Verify across the repo

- [ ] **Step 1: Grep for remaining 2-arg calls**

```bash
grep -rn "generateSessionTitle(" packages/vibedeckx/src/ --include="*.ts"
```

Expected: every match calls with **3 arguments** (storage, userText, userId). If any 2-arg call remains, fix it before continuing.

- [ ] **Step 2: Final type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: zero errors.

- [ ] **Step 3: Frontend type-check (sanity — no frontend changes are expected, but the backend-API surface used by the frontend remained source-compatible)**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit && cd ../..
```

Expected: zero errors.

---

## Phase 6 — End-to-End Verification

### Task 15: Full bundle build

**Files:**
- None modified.

- [ ] **Step 1: Production bundle**

```bash
pnpm build
```

Expected: success across both `pnpm build:main` (backend) and `pnpm build:ui` (frontend).

---

### Task 16: Live trace verification (manual, requires Langfuse credentials)

**Files:**
- None modified.

- [ ] **Step 1: Run with Langfuse env set against any Langfuse project**

```bash
export LANGFUSE_PUBLIC_KEY=<your-public-key>
export LANGFUSE_SECRET_KEY=<your-secret-key>
# optional: export LANGFUSE_BASE_URL=https://cloud.langfuse.com
node packages/vibedeckx/dist/bin.js --port 5173 &
```

Open `http://localhost:5173`, perform:
- Send one chat-session message to the built-in AI assistant.
- Trigger the translate route (POST `/api/translate` with a Chinese sentence).
- Create a task without providing a title (so `task-suggest` runs).
- Start an agent session and send the first user message (so `session-title` runs).

- [ ] **Step 2: Open the Langfuse UI and verify**

In the Traces view:
- 4 distinct traces appear, one per `functionId` value: `chat-session`, `translate`, `task-suggest`, `session-title`.
- Each trace's metadata shows the expected `userId` (real Clerk id when started with `--auth`, otherwise `"local"`).
- The `chat-session` trace has a non-empty `sessionId` matching the in-memory `ChatSession.id`. The other three have no `sessionId` (one-shot tasks).
- Tags include `"vibedeckx"` and the matching `functionId` on every trace.
- The chat-session trace's spans include sub-spans for each tool call when the AI uses tools.

- [ ] **Step 3: Verify the disabled path**

```bash
unset LANGFUSE_PUBLIC_KEY
node packages/vibedeckx/dist/bin.js --port 5173 &
```

Server log first line includes: `[Langfuse] tracing disabled (LANGFUSE_PUBLIC_KEY not set)`. Repeat the four user actions above; confirm zero crashes and normal behavior.

- [ ] **Step 4: Document the env vars in the project README**

Append to `README.md` (or the existing observability section if present) — exact lines below the "Configuration" or "Environment variables" heading:

```markdown
### Observability (optional)

Set these to enable Langfuse tracing of all AI SDK calls:

- `LANGFUSE_PUBLIC_KEY` — Langfuse project public key
- `LANGFUSE_SECRET_KEY` — Langfuse project secret key
- `LANGFUSE_BASE_URL` — defaults to `https://cloud.langfuse.com`
- `LANGFUSE_TRACING_ENVIRONMENT` — e.g. `production`, `development`

When the keys are unset, tracing is silently disabled at startup.
```

- [ ] **Step 5: Commit the README update**

```bash
git add README.md
git commit -m "docs: document Langfuse tracing env vars"
```

---

## Rollback

To disable tracing without reverting code: leave `LANGFUSE_PUBLIC_KEY` unset. The server logs `tracing disabled` and AI SDK calls behave identically to the pre-change baseline (the OTel SDK never starts; `experimental_telemetry: { isEnabled: true }` is a no-op without an active TracerProvider).

To revert entirely: `git revert` the Phase 1–5 commits.
