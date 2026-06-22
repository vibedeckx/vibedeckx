# Remote Agent Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `spawnAgentSession` / `sendToAgentSession` work in remote workspaces (`project.agent_mode !== 'local'`) with the same semantics as local and without depending on the frontend.

**Architecture:** Extract the UI route's remote-session-create logic into a shared helper (`remote-agent-sessions.ts`) reused by both the route and the chat tools. Move the existing persistent remote-stream connector (`connectPersistentRemoteWs`) into that module and add an idempotent `ensureRemoteAgentStream` so a commander-spawned remote session gets its completion stream consumed headlessly — that stream already bridges remote `taskCompleted` to the local EventBus, which wakes the commander. The two chat tools gain an `agent_mode` branch delegating to new private methods.

**Tech Stack:** TypeScript (backend ESM, NodeNext), Vercel `ai` SDK `tool()` + `zod`, reverse-connect WS proxy + `proxyToRemoteAuto`.

## Global Constraints

- **Scope = remote path for spawn/send only.** No frontend "live-surface session" (Req 2), no plan-first, no approval bubbling, no cross-branch parallelism. Local path behavior must NOT change.
- **Spawned remote agent runs on the commander's own project+branch**, permission mode hard-coded `"edit"`.
- **Session creation must be identical to the UI path** — reuse the same helper; the two paths must produce interoperable sessions.
- **No dependency on the frontend** — the commander establishes the completion stream itself via `ensureRemoteAgentStream`.
- **`remote-` local session id format:** `` `remote-${agentMode}-${projectId}-${remoteSessionId}` `` (must match the UI path exactly so `findRemoteSessionForProject` keeps working).
- **Remote message body shape:** `{ content: <text> }` to `POST /api/agent-sessions/:remoteSessionId/message`.
- **Remote status read:** `GET /api/agent-sessions/:remoteSessionId` → `{ session: { status } }`; `status === "running"` means actively mid-turn.
- **NO test framework is configured** (per CLAUDE.md). Verification = backend type-check (`npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`) plus manual e2e. Two PRE-EXISTING unrelated tsc errors exist and must remain untouched: `routes/file-routes.ts(993)` and `server.ts(5)` (`@fastify/multipart`). No new error may reference `chat-session-manager.ts`, `remote-agent-sessions.ts`, `routes/agent-session-routes.ts`, or `routes/websocket-routes.ts`.
- Backend ESM: all local imports use `.js` extensions.

---

### Task 1: Extract `createRemoteAgentSession` shared helper

**Files:**
- Create: `packages/vibedeckx/src/remote-agent-sessions.ts`
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` (the `useRemoteAgent` block of the `/api/projects/:projectId/agent-sessions/new` route, currently lines ~583-641)

**Interfaces:**
- Consumes (existing, verified): `proxyToRemoteAuto(remoteServerId, remoteUrl, apiKey, method, apiPath, body?, options?)`; `storage.remoteSessionMappings.upsert(localSessionId, projectId, remoteServerId, remoteSessionId, branch)`; `remotePatchCache.getOrCreate(id)` / `.appendMessage(id, raw, isPatch)`; `agentSessionManager.emitBranchActivityIfChanged(projectId, branch, {activity, since})`; `ConversationPatch.addEntry(index, msg)`.
- Produces: `createRemoteAgentSession(deps, params): Promise<CreateRemoteAgentSessionResult>`, plus exported types `RemoteAgentSessionDeps` and `CreateRemoteAgentSessionResult`.

- [ ] **Step 1: Create the helper module**

Create `packages/vibedeckx/src/remote-agent-sessions.ts`:

```ts
import { proxyToRemoteAuto } from "./utils/remote-proxy.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { AgentMessage } from "./agent-types.js";
import type { Storage } from "./storage/types.js";
import type { RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";

export interface RemoteAgentSessionDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remoteSessionMappings: Storage["remoteSessionMappings"];
  remotePatchCache: RemotePatchCache;
  agentSessionManager: AgentSessionManager;
  reverseConnectManager: ReverseConnectManager | null;
}

export type CreateRemoteAgentSessionResult =
  | { ok: true; localSessionId: string; remoteSession: { id: string }; messages: unknown[] }
  | { ok: false; status: number; data: unknown };

/**
 * Create an agent session on the remote server and register the local handle
 * (remoteSessionMap + persisted mapping + seeded patch cache). Identical to the
 * UI create path (agent-session-routes.ts) — both call this so the two paths
 * produce interoperable sessions. Throws only on transport errors; a non-2xx
 * remote response is returned as { ok: false }.
 */
export async function createRemoteAgentSession(
  deps: RemoteAgentSessionDeps,
  params: {
    projectId: string;
    agentMode: string;
    remoteConfig: { server_url: string | null; server_api_key?: string; remote_path?: string | null };
    branch: string | null;
    permissionMode: "plan" | "edit";
    agentType?: string;
  },
): Promise<CreateRemoteAgentSessionResult> {
  const { projectId, agentMode, remoteConfig, branch, permissionMode, agentType } = params;

  const result = await proxyToRemoteAuto(
    agentMode,
    remoteConfig.server_url ?? "",
    remoteConfig.server_api_key || "",
    "POST",
    `/api/path/agent-sessions/new`,
    { path: remoteConfig.remote_path, branch, permissionMode, agentType },
    { reverseConnectManager: deps.reverseConnectManager ?? undefined },
  );
  if (!result.ok) {
    return { ok: false, status: result.status, data: result.data };
  }

  const remoteData = result.data as { session: { id: string }; messages: unknown[] };
  const localSessionId = `remote-${agentMode}-${projectId}-${remoteData.session.id}`;

  deps.remoteSessionMap.set(localSessionId, {
    remoteServerId: agentMode,
    remoteUrl: remoteConfig.server_url ?? "",
    remoteApiKey: remoteConfig.server_api_key || "",
    remoteSessionId: remoteData.session.id,
    branch: branch ?? null,
  });
  deps.remoteSessionMappings.upsert(localSessionId, projectId, agentMode, remoteData.session.id, branch ?? null);

  if (remoteData.messages && remoteData.messages.length > 0) {
    const cacheEntry = deps.remotePatchCache.getOrCreate(localSessionId);
    if (cacheEntry.messages.length === 0) {
      for (let i = 0; i < remoteData.messages.length; i++) {
        const patch = ConversationPatch.addEntry(i, remoteData.messages[i] as AgentMessage);
        deps.remotePatchCache.appendMessage(localSessionId, JSON.stringify({ JsonPatch: patch }), true);
      }
    }
  }

  deps.agentSessionManager.emitBranchActivityIfChanged(projectId, branch ?? null, { activity: "idle", since: Date.now() });

  return { ok: true, localSessionId, remoteSession: remoteData.session, messages: remoteData.messages };
}
```

- [ ] **Step 2: Refactor the create route to call the helper**

In `packages/vibedeckx/src/routes/agent-session-routes.ts`, add to the existing import from `../remote-agent-sessions.js` (create the import line near the other imports at the top of the file):

```ts
import { createRemoteAgentSession } from "../remote-agent-sessions.js";
```

Then replace the entire `if (useRemoteAgent) { ... }` block (currently ~lines 583-642, from `if (useRemoteAgent) {` through its closing `}` just before `if (!project.path) {`) with:

```ts
    if (useRemoteAgent) {
      const remoteConfig = fastify.storage.projectRemotes.getByProjectAndServer(project.id, agentMode);
      if (!remoteConfig) {
        return reply.code(400).send({ error: `Remote server configuration not found for agent_mode="${agentMode}"` });
      }
      try {
        const created = await createRemoteAgentSession(
          {
            remoteSessionMap: fastify.remoteSessionMap,
            remoteSessionMappings: fastify.storage.remoteSessionMappings,
            remotePatchCache: fastify.remotePatchCache,
            agentSessionManager: fastify.agentSessionManager,
            reverseConnectManager: fastify.reverseConnectManager,
          },
          {
            projectId: project.id,
            agentMode,
            remoteConfig,
            branch: branch ?? null,
            permissionMode: permissionMode || "edit",
            agentType,
          },
        );
        if (created.ok) {
          return reply.code(200).send({
            session: { ...created.remoteSession, id: created.localSessionId, projectId: req.params.projectId },
            messages: created.messages,
          });
        }
        return reply.code(proxyStatus({ status: created.status })).send(created.data);
      } catch (error) {
        console.error("[API] Remote agent session proxy error (new):", error);
        return reply.code(502).send({ error: `Remote agent error: ${String(error)}` });
      }
    }
```

This preserves identical behavior (same remote call, same registration, same response and error codes). Note: the previous block seeded the patch cache and emitted branch activity inline; the helper now does both.

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json 2>&1`
Expected: no error referencing `remote-agent-sessions.ts` or `agent-session-routes.ts`. Only the two pre-existing unrelated errors (`file-routes.ts(993)`, `server.ts(5)`) may remain. If `proxyToRemoteAuto` is now unused elsewhere in the route file, leave other imports untouched — it is still used by other handlers.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/remote-agent-sessions.ts packages/vibedeckx/src/routes/agent-session-routes.ts
git commit -m "refactor: extract createRemoteAgentSession shared helper"
```

---

### Task 2: Move `connectPersistentRemoteWs` into the shared module + add `ensureRemoteAgentStream`

**Files:**
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts` (add the moved connector + `ensureRemoteAgentStream`)
- Modify: `packages/vibedeckx/src/routes/websocket-routes.ts` (remove the moved definitions, import them back)

**Interfaces:**
- Consumes: the helper module from Task 1; existing `connectPersistentRemoteWs(sessionId, remoteInfo, cache, wsOptions, reverseConnectManager?, eventBus?, agentSessionManager?)` and its private helpers `scheduleRemoteReconnect`, `buildRemoteWsUrl`, `tryParseWsMessage`, and constants `REMOTE_RECONNECT_*`, currently in `websocket-routes.ts`.
- Produces: exported `connectPersistentRemoteWs`, `tryParseWsMessage`, and `ensureRemoteAgentStream(localSessionId, deps): void`.

- [ ] **Step 1: Move the connector + its helpers into `remote-agent-sessions.ts`**

Cut these definitions from `packages/vibedeckx/src/routes/websocket-routes.ts` and paste them into `packages/vibedeckx/src/remote-agent-sessions.ts` (append after `createRemoteAgentSession`):
- the constants `REMOTE_RECONNECT_MAX_ATTEMPTS`, `REMOTE_RECONNECT_BASE_DELAY_MS`, `REMOTE_RECONNECT_MAX_DELAY_MS`, `REMOTE_RECONNECT_STABILITY_MS` (currently lines ~22-26),
- `function tryParseWsMessage(...)` (currently lines ~36-43),
- `function buildRemoteWsUrl(...)` (currently line ~29),
- `function connectPersistentRemoteWs(...)` (currently lines ~51-316),
- `function scheduleRemoteReconnect(...)` (currently lines ~322-362).

Add `export` to `connectPersistentRemoteWs` and `tryParseWsMessage`. Add these imports to the top of `remote-agent-sessions.ts` (merge with existing imports; do not duplicate `RemotePatchCache`/`AgentSessionManager`/`RemoteSessionInfo`/`ReverseConnectManager` which are already imported as types — but the moved code uses some as values/runtime, so adjust):

```ts
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import { statusEventFromRemotePatch, projectIdFromRemoteSessionId } from "./routes/remote-status-bridge.js";
import type { EventBus } from "./event-bus.js";
```

(`reverseConnectManager` and `eventBus` and `agentSessionManager` are passed as parameters to the moved functions, so they stay as the existing type imports.)

- [ ] **Step 2: Import the moved functions back into `websocket-routes.ts`**

In `packages/vibedeckx/src/routes/websocket-routes.ts`, add:

```ts
import { connectPersistentRemoteWs, tryParseWsMessage } from "../remote-agent-sessions.js";
```

Remove the now-moved definitions and any imports/constants left unused by the move (the type-check in Step 4 will flag unused ones if `noUnusedLocals` is on; remove exactly those). Do NOT remove imports still used elsewhere in `websocket-routes.ts` (e.g. `VirtualWsAdapter`, `statusEventFromRemotePatch`, `randomUUID` may still be used by other handlers — check before removing; only delete a websocket-routes import if grep shows it has no remaining use in that file).

- [ ] **Step 3: Add `ensureRemoteAgentStream` to `remote-agent-sessions.ts`**

Append:

```ts
export interface EnsureStreamDeps {
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remotePatchCache: RemotePatchCache;
  reverseConnectManager: ReverseConnectManager | null;
  eventBus: EventBus | null;
  agentSessionManager: AgentSessionManager;
  wsOptions?: Record<string, unknown>;
}

/**
 * Idempotently ensure a persistent remote stream is connected for this session,
 * so its remote `taskCompleted` bridges to the local EventBus (which wakes the
 * commander) even when no frontend window is open. No-op if a connection is
 * already live or reconnecting. Reverse-connect deployments don't use wsOptions.
 */
export function ensureRemoteAgentStream(localSessionId: string, deps: EnsureStreamDeps): void {
  const remoteInfo = deps.remoteSessionMap.get(localSessionId);
  if (!remoteInfo) return;
  if (deps.remotePatchCache.getRemoteWs(localSessionId) || deps.remotePatchCache.isReconnecting(localSessionId)) return;
  connectPersistentRemoteWs(
    localSessionId,
    remoteInfo,
    deps.remotePatchCache,
    deps.wsOptions ?? {},
    deps.reverseConnectManager ?? undefined,
    deps.eventBus ?? undefined,
    deps.agentSessionManager,
  );
}
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json 2>&1`
Expected: no error referencing `remote-agent-sessions.ts` or `websocket-routes.ts`. Fix any unused-import or missing-import errors introduced by the move. Only the two pre-existing unrelated errors may remain.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/remote-agent-sessions.ts packages/vibedeckx/src/routes/websocket-routes.ts
git commit -m "refactor: move persistent remote-stream connector to shared module + add ensureRemoteAgentStream"
```

---

### Task 3: Remote branch in `spawnAgentSession`

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (import; new private method `spawnRemoteAgentSession`; branch in the `spawnAgentSession` tool's `execute`)

**Interfaces:**
- Consumes: `createRemoteAgentSession`, `ensureRemoteAgentStream` (Task 1/2); `proxyToRemoteAuto` (already imported); `this.findRemoteSessionForProject(projectId, branch): { localSessionId: string; info: RemoteSessionInfo } | null`; `this.registerChatInitiatedAgentTask(id)`; `this.setEventListening(sessionId, true)`; `this.storage.projectRemotes.getByProjectAndServer(projectId, agentMode)`; `this.storage.projects.getById(projectId)` returning a row with `agent_mode` and optional `path`.
- Produces: `private async spawnRemoteAgentSession(params): Promise<{ success: boolean; agentSessionId?: string; message: string }>`.

- [ ] **Step 1: Add the helper imports**

In `packages/vibedeckx/src/chat-session-manager.ts`, add near the other local imports:

```ts
import { createRemoteAgentSession, ensureRemoteAgentStream } from "./remote-agent-sessions.js";
```

- [ ] **Step 2: Add the `spawnRemoteAgentSession` private method**

Add this method to the `ChatSessionManager` class (place it near `findRemoteSessionForProject`):

```ts
  private async spawnRemoteAgentSession(params: {
    projectId: string;
    branch: string | null;
    agentMode: string;
    prompt: string;
    agentType?: string;
    chatSessionId: string;
  }): Promise<{ success: boolean; agentSessionId?: string; message: string }> {
    const { projectId, branch, agentMode, prompt, agentType, chatSessionId } = params;

    const remoteConfig = this.storage.projectRemotes.getByProjectAndServer(projectId, agentMode);
    if (!remoteConfig) {
      return { success: false, message: `No remote server configured for this workspace (agent_mode="${agentMode}").` };
    }

    // Guard: reject only if an existing remote session for this branch is actively running.
    let staleLocalId: string | null = null;
    const existing = this.findRemoteSessionForProject(projectId, branch);
    if (existing) {
      try {
        const statusRes = await proxyToRemoteAuto(
          existing.info.remoteServerId, existing.info.remoteUrl, existing.info.remoteApiKey,
          "GET", `/api/agent-sessions/${existing.info.remoteSessionId}`, undefined,
          { reverseConnectManager: this.reverseConnectManager ?? undefined },
        );
        const status = statusRes.ok ? (statusRes.data as { session?: { status?: string } }).session?.status : undefined;
        if (status === "running") {
          return { success: false, message: "This workspace already has an active coding agent. Use sendToAgentSession to send it a message instead." };
        }
      } catch {
        // Status unknown — treat as not-active and proceed (the stale mapping is replaced below).
      }
      staleLocalId = existing.localSessionId;
    }

    let created;
    try {
      created = await createRemoteAgentSession(
        {
          remoteSessionMap: this.remoteSessionMap,
          remoteSessionMappings: this.storage.remoteSessionMappings,
          remotePatchCache: this.remotePatchCache,
          agentSessionManager: this.agentSessionManager,
          reverseConnectManager: this.reverseConnectManager,
        },
        { projectId, agentMode, remoteConfig, branch, permissionMode: "edit", agentType },
      );
    } catch (error) {
      return { success: false, message: `Remote server unreachable, could not start the coding agent: ${String(error)}` };
    }
    if (!created.ok) {
      return { success: false, message: `Failed to start the remote coding agent (status ${created.status}).` };
    }

    // Drop the stale mapping now that a fresh session exists on this branch.
    if (staleLocalId && staleLocalId !== created.localSessionId) {
      this.remoteSessionMap.delete(staleLocalId);
      this.storage.remoteSessionMappings.delete(staleLocalId);
    }

    // Deliver the first task.
    try {
      const msgRes = await proxyToRemoteAuto(
        agentMode, remoteConfig.server_url ?? "", remoteConfig.server_api_key || "",
        "POST", `/api/agent-sessions/${created.remoteSession.id}/message`, { content: prompt },
        { reverseConnectManager: this.reverseConnectManager ?? undefined },
      );
      if (!msgRes.ok) {
        return { success: false, message: `Remote agent started but the task could not be delivered (status ${msgRes.status}).` };
      }
    } catch (error) {
      return { success: false, message: `Remote agent started but the task could not be delivered: ${String(error)}` };
    }

    ensureRemoteAgentStream(created.localSessionId, {
      remoteSessionMap: this.remoteSessionMap,
      remotePatchCache: this.remotePatchCache,
      reverseConnectManager: this.reverseConnectManager,
      eventBus: this.eventBus,
      agentSessionManager: this.agentSessionManager,
    });
    this.registerChatInitiatedAgentTask(created.localSessionId);
    this.setEventListening(chatSessionId, true);

    return {
      success: true,
      agentSessionId: created.localSessionId,
      message: "Coding agent started on the remote server and given the task. It runs autonomously; you'll be woken with an '[Agent Event: Task Completed]' message when it finishes. Do not claim completion yet.",
    };
  }
```

- [ ] **Step 3: Branch the `spawnAgentSession` tool to the remote path**

In the `spawnAgentSession` tool's `execute`, immediately after `const project = storage.projects.getById(projectId);` and BEFORE the `if (!project?.path)` check, insert:

```ts
          const agentMode = project?.agent_mode;
          if (project && agentMode && agentMode !== "local") {
            return await this.spawnRemoteAgentSession({ projectId, branch, agentMode, prompt, agentType, chatSessionId: sessionId });
          }
```

(The existing local code — the `if (!project?.path)` guard, the dormant-aware existing check, `createNewSession`, etc. — stays unchanged below this branch and runs only for `agent_mode === "local"`.)

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json 2>&1`
Expected: no error referencing `chat-session-manager.ts`. Only the two pre-existing unrelated errors may remain.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: remote path for spawnAgentSession"
```

---

### Task 4: Remote branch in `sendToAgentSession`

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (new private method `sendToRemoteAgentSession`; branch in the `sendToAgentSession` tool's `execute`)

**Interfaces:**
- Consumes: same as Task 3 (`proxyToRemoteAuto`, `ensureRemoteAgentStream`, `this.findRemoteSessionForProject`, `this.registerChatInitiatedAgentTask`, `this.setEventListening`).
- Produces: `private async sendToRemoteAgentSession(params): Promise<{ success: boolean; message: string }>`.

- [ ] **Step 1: Add the `sendToRemoteAgentSession` private method**

Add to `ChatSessionManager` (next to `spawnRemoteAgentSession`):

```ts
  private async sendToRemoteAgentSession(params: {
    projectId: string;
    branch: string | null;
    message: string;
    chatSessionId: string;
  }): Promise<{ success: boolean; message: string }> {
    const { projectId, branch, message, chatSessionId } = params;

    const target = this.findRemoteSessionForProject(projectId, branch);
    if (!target) {
      return { success: false, message: "This workspace has no coding agent yet. Use spawnAgentSession to start one." };
    }

    // Busy check: if the remote session is actively running a turn, don't send.
    try {
      const statusRes = await proxyToRemoteAuto(
        target.info.remoteServerId, target.info.remoteUrl, target.info.remoteApiKey,
        "GET", `/api/agent-sessions/${target.info.remoteSessionId}`, undefined,
        { reverseConnectManager: this.reverseConnectManager ?? undefined },
      );
      const status = statusRes.ok ? (statusRes.data as { session?: { status?: string } }).session?.status : undefined;
      if (status === "running") {
        return { success: false, message: "The coding agent is busy mid-turn. You'll be woken with an '[Agent Event: Task Completed]' message when it finishes — send your message then." };
      }
    } catch {
      // Status unknown — proceed to attempt delivery.
    }

    try {
      const msgRes = await proxyToRemoteAuto(
        target.info.remoteServerId, target.info.remoteUrl, target.info.remoteApiKey,
        "POST", `/api/agent-sessions/${target.info.remoteSessionId}/message`, { content: message },
        { reverseConnectManager: this.reverseConnectManager ?? undefined },
      );
      if (!msgRes.ok) {
        return { success: false, message: `Failed to deliver the message to the remote coding agent (status ${msgRes.status}).` };
      }
    } catch (error) {
      return { success: false, message: `Failed to deliver the message to the remote coding agent: ${String(error)}` };
    }

    ensureRemoteAgentStream(target.localSessionId, {
      remoteSessionMap: this.remoteSessionMap,
      remotePatchCache: this.remotePatchCache,
      reverseConnectManager: this.reverseConnectManager,
      eventBus: this.eventBus,
      agentSessionManager: this.agentSessionManager,
    });
    this.registerChatInitiatedAgentTask(target.localSessionId);
    this.setEventListening(chatSessionId, true);

    return {
      success: true,
      message: "Message delivered to the remote coding agent. You'll be woken with an '[Agent Event: Task Completed]' message when it finishes. Do not claim completion yet.",
    };
  }
```

- [ ] **Step 2: Branch the `sendToAgentSession` tool to the remote path**

In the `sendToAgentSession` tool's `execute`, immediately after the `if (!sessionId)` guard, insert:

```ts
          const sendProject = storage.projects.getById(projectId);
          const sendAgentMode = sendProject?.agent_mode;
          if (sendProject && sendAgentMode && sendAgentMode !== "local") {
            return await this.sendToRemoteAgentSession({ projectId, branch, message, chatSessionId: sessionId });
          }
```

(The existing local code — `getSessionByBranch`, the running/busy check, `sendUserMessage` — stays unchanged below and runs only for `agent_mode === "local"`. Note the local branch already reads `project` via `storage.projects.getById(projectId)`; keep that as-is; the new `sendProject` is local to the remote branch.)

- [ ] **Step 3: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json 2>&1`
Expected: no error referencing `chat-session-manager.ts`. Only the two pre-existing unrelated errors may remain.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: remote path for sendToAgentSession"
```

---

### Task 5: End-to-end manual verification

**Files:** none (verification only). Requires a remote-only workspace with a reverse-connect tunnel online.

**Interfaces:** exercises Tasks 1-4 together.

- [ ] **Step 1: Build / run**

Run: `pnpm dev:all`
Expected: backend on 5173, frontend on 3000, no startup errors.

- [ ] **Step 2: Remote spawn, headless wake (the core case)**

In a remote-only workspace's Main Chat, ask the commander to make a small change. Confirm:
- It calls `spawnAgentSession` (label "Starting a coding agent...") and a session is created on the remote server.
- **Without opening any agent window**, the commander still receives an `[Agent Event: Task Completed]` message when the remote agent finishes, and reports a summary. (This verifies `ensureRemoteAgentStream` established the stream headlessly and the completion bridged back.)

- [ ] **Step 3: Remote send**

With that remote agent idle, ask the commander a follow-up. Confirm `sendToAgentSession` (label "Sending a message to the agent...") delivers it, the remote agent acts, and completion wakes the commander again.

- [ ] **Step 4: Boundary checks**

- Spawn while a remote agent is actively running → refused with the "already has an active coding agent" message.
- Send in a remote workspace with no session → errors with "no coding agent yet... use spawnAgentSession".
- Send while the remote agent is mid-turn → returns the "busy mid-turn" message.
- Disconnect the remote tunnel, then spawn/send → returns a clear "remote server unreachable / could not deliver" failure (not a silent success).

- [ ] **Step 5: Interop + regression**

- A remote session created via the normal UI ("New" + first message) is reachable by the commander's `sendToAgentSession` (same `findRemoteSessionForProject` mapping).
- A local workspace's `spawnAgentSession` / `sendToAgentSession` behave exactly as before (local path untouched).
- Creating a remote session via the UI still works (the route now calls the shared helper).

- [ ] **Step 6: Final type-check sweep**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json 2>&1`
Expected: only the two pre-existing unrelated errors (`file-routes.ts(993)`, `server.ts(5)`); nothing referencing the four files changed by this plan.
