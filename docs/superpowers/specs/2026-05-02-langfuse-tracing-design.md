# Langfuse Tracing for Chat Sessions and AI SDK Calls

**Date**: 2026-05-02
**Status**: Approved (pending spec review)

## Goal

Add Langfuse observability to every Vercel AI SDK call in vibedeckx so chat
sessions, session-title generation, translation, and task suggestions all show
up in the Langfuse UI with proper session/user grouping.

## Scope

In scope — every code path that uses `ai` (Vercel AI SDK):

- `chat-session-manager.ts` — `streamText` (multi-turn chat with tools)
- `utils/session-title.ts` — `generateText` (one-shot title generation)
- `routes/translate-routes.ts` — `generateText` (one-shot translate)
- `routes/task-routes.ts` — `generateText` (one-shot task suggestion)

Out of scope:

- `agent-session-manager.ts` — spawns Claude Code / Codex as child processes,
  does not go through AI SDK. No telemetry hook available without parsing
  stdout, which is a separate, larger project.
- Storing Langfuse config in `storage.settings`. Configuration is env-only.
- DB schema changes. No new columns, no migrations.

## Approach

Langfuse JS SDK v4 + OpenTelemetry. The AI SDK already emits OTel spans when
`experimental_telemetry: { isEnabled: true }` is set, so the integration is
"register a span processor at startup, add a telemetry block to each call."

Reject the v3 path (`langfuse-vercel` + `@vercel/otel`). v3 is legacy and
@vercel/otel is a Next.js-shaped wrapper; vibedeckx is a Fastify CLI.

Reject manual tracing via `@langfuse/tracing` low-level APIs. AI SDK's native
telemetry already produces correctly-shaped spans (steps, tool calls, token
usage); duplicating that work risks divergence.

## Architecture

### Initialization

New file `packages/vibedeckx/src/instrumentation.ts`:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const enabled = !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;

export const langfuseSpanProcessor = enabled ? new LangfuseSpanProcessor() : null;

if (enabled) {
  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor!] });
  sdk.start();
  console.log("[Langfuse] tracing enabled");

  const shutdown = async () => {
    try { await sdk.shutdown(); } catch { /* best-effort */ }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} else {
  console.log("[Langfuse] tracing disabled (LANGFUSE_PUBLIC_KEY not set)");
}
```

`bin.ts` modification — import the instrumentation module first, before any
AI-SDK-using module loads:

```ts
#!/usr/bin/env node
import "./instrumentation.js";
import { run } from "@stricli/core";
import { program } from "./command.js";
run(program, process.argv.slice(2), { process });
```

When the env vars are absent the SDK never starts. `experimental_telemetry`
becomes a no-op because there is no active TracerProvider, so business code
needs no conditionals.

### Environment variables

Read by `LangfuseSpanProcessor` from `process.env`:

| Variable | Required | Purpose |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | yes | Project public key |
| `LANGFUSE_SECRET_KEY` | yes | Project secret key |
| `LANGFUSE_BASE_URL` | no | Defaults to `https://cloud.langfuse.com` |
| `LANGFUSE_TRACING_ENVIRONMENT` | no | e.g. `production`, `development` |

README and deployment docs need a brief section listing these.

### Telemetry metadata shape

Every AI SDK call gets:

```ts
experimental_telemetry: {
  isEnabled: true,
  functionId: "<one of: chat-session | session-title | translate | task-suggest>",
  metadata: {
    sessionId: <ChatSession.id>,    // chat-session only — groups multi-turn in Langfuse Sessions view
    userId: <Clerk userId>,
    tags: ["vibedeckx", "<functionId>"],
    projectId: <projectId>,         // custom — surfaces in Langfuse trace metadata
    branch: <branch ?? "(default)">,
  },
}
```

`sessionId` only goes on chat-session traces. The other three are one-shot
short tasks; giving them a sessionId would group unrelated traces.

`userId` is always a real Clerk user id. Every AI-SDK-using route is already
gated by `requireAuth`, which returns early on missing auth — so we never
reach a `streamText` / `generateText` call without a real userId. There is no
anonymous fallback needed.

### userId propagation

#### chat-session (multi-turn, persistent in-memory)

`ChatSession` interface gains a `userId: string` field. The route captures
userId at session creation:

```ts
// routes/chat-session-routes.ts
fastify.post("/api/projects/:projectId/chat-sessions", async (req, reply) => {
  const userId = requireAuth(req, reply);
  if (userId === null) return;
  const sessionId = fastify.chatSessionManager.getOrCreateSession(projectId, branch, userId);
  // ...
});
```

`chatSessionManager.getOrCreateSession(projectId, branch, userId)` writes
`userId` onto the in-memory `ChatSession`. `sendMessage` reads `session.userId`
when building the telemetry block — no extra plumbing per message.

The message route also gains `requireAuth` (currently missing — small
correctness fix bundled in).

Same `(projectId, branch)` always belongs to the same user (the
`projects.getById(projectId, userId)` ownership check upstream guarantees
this), so userId is locked at session creation and never overwritten.

ChatSession is purely in-memory; server restart wipes them, so there is no
recovery scenario to worry about.

#### One-shot generateText calls (translate, task-suggest)

Both live inside HTTP routes that already call `requireAuth`. userId is
already in scope; just pass it into the telemetry metadata block.

#### session-title (called from agent-session-manager)

`ensureSessionTitle` is invoked from `persistEntry` only on the first user
message of a fresh session, gated by `markTitleResolved` (idempotent). At that
exact moment the HTTP request that delivered the user message has Clerk auth.
Thread userId through:

```
HTTP /api/agent-sessions/:id/message (requireAuth → userId)
  → agentSessionManager.sendUserMessage(sessionId, content, projectPath, userId)
    → persistEntry(session, index, message, userId)
      → ensureSessionTitle(session, userText, userId)
        → generateSessionTitle(storage, userText, userId)
          → generateText({ experimental_telemetry: { metadata: { userId } } })
```

Title generation never runs for restored dormant sessions because the title is
written once and persisted in `agent_sessions.title`; subsequent runs of
`ensureSessionTitle` short-circuit on the non-null check
(`agent-session-manager.ts:755`). So the "userId at title-generation time"
question reduces to "userId at first-user-message time" — which always has
Clerk auth.

`RunningSession` does **not** gain a userId field. userId is a one-shot
parameter threaded through the call stack on each user message. No DB column,
no schema change.

### Per-call wiring sketches

`chat-session-manager.ts` `sendMessage`:

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

`utils/session-title.ts` (new userId param):

```ts
export async function generateSessionTitle(
  storage: Storage,
  userText: string,
  userId: string,
): Promise<string | null> {
  // ...
  const { text } = await generateText({
    model,
    prompt,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "session-title",
      metadata: {
        userId,
        tags: ["vibedeckx", "session-title"],
      },
    },
  });
  // ...
}
```

`routes/translate-routes.ts` and `routes/task-routes.ts`: identical pattern,
`functionId` is `"translate"` / `"task-suggest"`, `userId` is the local var
already returned by `requireAuth`. translate/task-suggest also include
`projectId` in metadata when available.

## esbuild compatibility

vibedeckx ships as an esbuild-bundled CLI. `@opentelemetry/sdk-node`'s
auto-instrumentation loaders try to `require()` instrumentation packages we
do not install (e.g. `@opentelemetry/instrumentation-http`). We use only
manual instrumentation (AI SDK's own spans) plus the Langfuse processor, so
the auto-loaders should not be invoked.

Implementation step: build the bundle once with the new dependencies and
verify no runtime `MODULE_NOT_FOUND` errors. If any surface, mark the
problematic OTel sub-packages as `external` in `esbuild.config.mjs` so they
are loaded from `node_modules` at runtime instead of bundled.

## Files changed

| File | Change |
|---|---|
| `packages/vibedeckx/src/instrumentation.ts` | new — NodeSDK + LangfuseSpanProcessor + signal handlers |
| `packages/vibedeckx/src/bin.ts` | add `import "./instrumentation.js"` as first import |
| `packages/vibedeckx/src/chat-session-manager.ts` | add `userId` to `ChatSession`; `getOrCreateSession(...userId)`; `streamText` telemetry block |
| `packages/vibedeckx/src/routes/chat-session-routes.ts` | thread userId into `getOrCreateSession`; add `requireAuth` to message route |
| `packages/vibedeckx/src/utils/session-title.ts` | `generateSessionTitle(...userId)` signature; telemetry block |
| `packages/vibedeckx/src/agent-session-manager.ts` | thread userId through `sendUserMessage` → `persistEntry` → `ensureSessionTitle` |
| `packages/vibedeckx/src/routes/agent-session-routes.ts` | pass userId from `requireAuth` into `sendUserMessage` |
| `packages/vibedeckx/src/routes/translate-routes.ts` | telemetry block on `generateText` |
| `packages/vibedeckx/src/routes/task-routes.ts` | telemetry block on `generateText` |
| `packages/vibedeckx/package.json` | add `@langfuse/otel`, `@opentelemetry/sdk-node` |
| `packages/vibedeckx/esbuild.config.mjs` | mark OTel packages external if bundling fails (verify during impl) |

## Failure modes

- Env vars missing: SDK never starts, business code is no-op (validated in
  instrumentation.ts).
- Langfuse endpoint unreachable: `LangfuseSpanProcessor` retries internally
  and drops on backpressure; AI SDK calls are not blocked.
- esbuild bundle excludes OTel files at runtime: caught in build verification
  step; resolved by `external` markers.

## Testing

- Build the CLI bundle, run with env vars set against a Langfuse cloud or
  self-hosted instance, perform one chat-session message + one
  translate/task/title operation, verify traces appear with correct
  `sessionId` / `userId` / `tags` / `projectId` / `branch` metadata in the
  Langfuse UI.
- Run with env vars unset, verify the startup log says "tracing disabled" and
  all four call sites work normally.

## Out of scope (future work)

- agent-session tracing (Claude Code / Codex stdout parsing)
- A vibedeckx settings UI for Langfuse keys
- Custom dashboards or alerting in Langfuse
