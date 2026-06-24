# Event-driven Outbound Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require user Approve/Deny before the Main Chat commander sends to / spawns a coding agent on an event-driven turn, using AI SDK v6 native `needsApproval`.

**Architecture:** Per-turn provenance flag (`wokenByEvent`) gates `needsApproval` on the `spawnAgentSession` / `sendToAgentSession` tools. When the model calls a gated tool on an event-driven turn, `streamText` pauses at a `tool-approval-request`; the backend surfaces an approval card entry over the existing WS, parks the turn in `session.pendingApproval`, and resumes the stream (running `execute`) only after the user POSTs a decision. Pure approve/deny — no input editing.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), Fastify, AI SDK `ai@^6` (`streamText`, `tool`, `needsApproval`), WebSocket + RFC6902 JSON patches (Immer on frontend), Next.js 16 / React 19 frontend.

## Global Constraints

- Backend ESM: every local import uses a `.js` extension.
- No test framework configured — verification is `tsc --noEmit` + explicit runtime checks (dev server + browser/log observation). Never claim a test exists.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
- Frontend typecheck: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Approve/deny only. `ToolApprovalResponse` is `{ type, approvalId, approved, reason? }`; `reason` is model-facing context, never overrides tool input.
- Gate must be backend-enforced; the frontend card is only a renderer + decision sender.
- Do NOT reuse `eventDrivenTurn` for gating (it is overloaded for dot-painting and is `false` for chat-initiated agent completions, which MUST be gated). Use a separate `wokenByEvent`.
- `wokenByEvent = isSystemEventMessage(content)` — pure content sniff, no `eventDriven` override.

---

### Task 1: Shared types — approval entry variant + session state

**Files:**
- Modify: `packages/vibedeckx/src/agent-types.ts:17-26` (AgentMessage union)
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:42-89` (ChatSession interface) and near top for `PendingApproval`
- Modify: `apps/vibedeckx-ui/hooks/use-chat-session.ts:11-18` (frontend AgentMessage union)

**Interfaces:**
- Produces: `AgentMessage` gains `{ type: 'tool_approval_request'; tool: string; input: unknown; approvalId: string; resolved?: 'approved' | 'denied'; timestamp: number }`
- Produces: `interface PendingApproval { baseMessages: ModelMessage[]; responseMessages: ModelMessage[]; approvalIds: string[]; decisions: Map<string, boolean>; entryIndexByApprovalId: Map<string, number> }`
- Produces: `ChatSession.wokenByEvent: boolean`, `ChatSession.pendingApproval: PendingApproval | null`

- [ ] **Step 1: Add the backend AgentMessage variant**

In `packages/vibedeckx/src/agent-types.ts`, append to the `AgentMessage` union (after the `approval_request` member at line 26, before the closing `;`):

```ts
  | { type: 'tool_approval_request'; tool: string; input: unknown; approvalId: string; resolved?: 'approved' | 'denied'; timestamp: number };
```

- [ ] **Step 2: Add `ModelMessage` import + `PendingApproval` + session fields**

In `packages/vibedeckx/src/chat-session-manager.ts`, ensure `ModelMessage` is imported from `ai` (add to the existing `import { ... } from "ai";`). Add above the `ChatSession` interface:

```ts
interface PendingApproval {
  /** The messages array passed into the paused streamText (conversation up to the tool call). */
  baseMessages: ModelMessage[];
  /** result.response.messages from the paused stream (assistant text + tool-call). */
  responseMessages: ModelMessage[];
  /** Every approvalId awaited this turn. Resume only fires once all are decided. */
  approvalIds: string[];
  /** approvalId -> approved. Populated as decisions arrive. */
  decisions: Map<string, boolean>;
  /** approvalId -> store entry index, for marking the card resolved. */
  entryIndexByApprovalId: Map<string, number>;
}
```

Add to the `ChatSession` interface (after `eventDrivenTurn: boolean;` at line 67):

```ts
  /**
   * True while the current turn was woken by a system/agent event (content
   * sniffed via isSystemEventMessage), independent of eventDrivenTurn's
   * dot-painting override. Gates needsApproval on the agent-delegation tools
   * so event-driven outbound sends require user confirmation.
   */
  wokenByEvent: boolean;
  /**
   * Set when the current turn paused on one or more tool-approval-requests.
   * Holds everything needed to resume the stream once the user decides.
   * Null whenever no approval is pending.
   */
  pendingApproval: PendingApproval | null;
```

- [ ] **Step 3: Initialize the new fields where sessions are created**

Find the session object literal that sets `eventDrivenTurn: false,` (around line 1171). Add alongside it:

```ts
      wokenByEvent: false,
      pendingApproval: null,
```

- [ ] **Step 4: Add the frontend AgentMessage variant**

In `apps/vibedeckx-ui/hooks/use-chat-session.ts`, in the `AgentMessage` union (lines 11-18), add after the `tool_result` member:

```ts
  | { type: "tool_approval_request"; tool: string; input: unknown; approvalId: string; resolved?: "approved" | "denied"; timestamp: number }
```

- [ ] **Step 5: Typecheck both packages**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS (no errors).
Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/agent-types.ts packages/vibedeckx/src/chat-session-manager.ts apps/vibedeckx-ui/hooks/use-chat-session.ts
git commit -m "feat: add tool_approval_request entry type and approval session state"
```

---

### Task 2: Provenance flag + `needsApproval` gating

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:2554` (sendMessage, set `wokenByEvent`)
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:1421-1430` (createTools, read `wokenByEvent`)
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:1607-1729` (the two tool definitions)

**Interfaces:**
- Consumes: `ChatSession.wokenByEvent` (Task 1)
- Produces: gated tools — when `wokenByEvent` is true, `spawnAgentSession`/`sendToAgentSession` carry `needsApproval: true` and do not execute until approved.

- [ ] **Step 1: Set `wokenByEvent` per turn**

In `sendMessage`, immediately after the existing line `session.eventDrivenTurn = eventDriven ?? isSystemEventMessage(content);` (line 2554), add:

```ts
    // Gate signal for outbound agent-delegation tools. Pure content sniff —
    // unlike eventDrivenTurn, NOT overridden by the eventDriven param, so
    // chat-initiated agent completions (eventDrivenTurn=false) are still gated.
    session.wokenByEvent = isSystemEventMessage(content);
```

- [ ] **Step 2: Read the flag inside createTools**

In `createTools` (line 1421), near the existing `turnStartedAt` capture (line 1427), add:

```ts
    const wokenByEvent = (sessionId ? this.sessions.get(sessionId)?.wokenByEvent : false) ?? false;
```

- [ ] **Step 3: Gate the two tools**

In the `spawnAgentSession` tool object (line 1607), add `needsApproval: wokenByEvent,` as a property of the `tool({...})` config (alongside `description`, `inputSchema`, before `execute`). Do the same in `sendToAgentSession` (line 1677).

```ts
      spawnAgentSession: tool({
        description: ...,
        inputSchema: ...,
        needsApproval: wokenByEvent,
        execute: async ({ prompt, agentType }) => { ... },
      }),
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Spike — confirm the SDK pause + part shape**

Temporarily add, in the `fullStream` loop's `switch (part.type)` (around line 2625), a default log to learn the real part shape:

```ts
          default: {
            console.log(`[ChatSession][spike] fullStream part:`, JSON.stringify(part).slice(0, 500));
            break;
          }
```

Run the dev server (`pnpm dev:all`), open a workspace, let the commander spawn an agent and wait for it to finish so an `[Agent Event: Task Completed]` turn fires and the model calls `sendToAgentSession`. In the backend logs confirm a `tool-approval-request` part appears (note its exact `type`, `approvalId`, and `toolCall`/`input` field names). Confirm the agent message is NOT delivered (execute did not run).

Record the observed part shape in a comment, then REMOVE the spike `default` block.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: gate agent-delegation tools with needsApproval on event-driven turns"
```

---

### Task 3: Extract `runStream` helper (pure refactor)

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts:2576-2780` (move the streaming body into a method)

**Interfaces:**
- Produces: `private async runStream(session: ChatSession, messages: ModelMessage[]): Promise<void>` — runs one `streamText` pass (the existing stream loop, finalize, watchdog) against a caller-supplied messages array. Reused by both `sendMessage` and the resume path.

- [ ] **Step 1: Add the `runStream` method**

Cut the body from `const abortController = new AbortController();` (line 2577) through the end of the watchdog/catch/finally block, and wrap it in a new method. Replace `session.projectId`/`session.branch`/`session.id` references as-is (they read from `session`). Signature:

```ts
  private async runStream(session: ChatSession, messages: ModelMessage[]): Promise<void> {
    const sessionId = session.id;
    const abortController = new AbortController();
    session.abortController = abortController;
    session.turnStartedAt = Date.now();
    // ... (existing streaming loop, finalize, watchdog, catch, finally) ...
  }
```

- [ ] **Step 2: Call it from sendMessage**

In `sendMessage`, after the `messages` array is built (lines 2566-2574), replace the removed inline streaming block with:

```ts
    await this.runStream(session, messages);
```

Keep the user-message push, status update, `eventDrivenTurn`/`wokenByEvent`/`taskCompleted` assignments, and `emitChatActivity` in `sendMessage` before the call.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Runtime smoke — behavior unchanged**

Run `pnpm dev:all`, send a normal user message in Main Chat, confirm streaming, tool calls, and completion still work exactly as before (this task changes no behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "refactor: extract runStream helper from sendMessage"
```

---

### Task 4: Detect approval requests, surface card, park the turn

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (inside `runStream`, after the `for await` loop, before the watchdog)

**Interfaces:**
- Consumes: `result.content` (`tool-approval-request` parts), `result.response.messages`, `PendingApproval`, the `tool_approval_request` entry type.
- Produces: when paused, `session.pendingApproval` is populated and one `tool_approval_request` entry per request is pushed + broadcast; `runStream` returns without running the watchdog.

- [ ] **Step 1: Add approval detection after the stream loop**

In `runStream`, immediately after the `for await (const part of result.fullStream) { ... }` loop closes (line 2718) and after the partial-assistant finalize block (lines 2720-2732), insert — using the exact field names confirmed in Task 2 Step 5:

```ts
      // Pause point: if the model called a needsApproval tool, the stream
      // stopped at the tool-approval-request boundary. Surface a card per
      // request and park the turn; the resume path (resolveToolApproval)
      // continues once the user decides. Skip the watchdog while paused.
      const finalContent = await result.content;
      const approvalRequests = finalContent.filter(
        (p): p is Extract<typeof p, { type: "tool-approval-request" }> =>
          p.type === "tool-approval-request",
      );
      if (approvalRequests.length > 0) {
        const responseMessages = (await result.response).messages;
        const pending: PendingApproval = {
          baseMessages: messages,
          responseMessages,
          approvalIds: [],
          decisions: new Map(),
          entryIndexByApprovalId: new Map(),
        };
        for (const req of approvalRequests) {
          const entry: AgentMessage = {
            type: "tool_approval_request",
            tool: req.toolCall.toolName,
            input: req.toolCall.input,
            approvalId: req.approvalId,
            timestamp: Date.now(),
          };
          const entryIndex = session.store.nextIndex;
          this.pushEntry(session, entry);
          pending.approvalIds.push(req.approvalId);
          pending.entryIndexByApprovalId.set(req.approvalId, entryIndex);
        }
        session.pendingApproval = pending;
        session.status = "waiting";
        this.broadcastPatch(session, ConversationPatch.updateStatus("waiting"));
        session.abortController = null;
        return; // parked — do not run the watchdog
      }
```

> Note: `pushEntry` already increments `session.store.nextIndex`; capture `entryIndex` BEFORE calling it (as shown). If the observed approval-request part nests fields differently than `req.toolCall.toolName` / `req.toolCall.input` / `req.approvalId`, adjust to the shape recorded in Task 2.

- [ ] **Step 2: Confirm `"waiting"` is a valid `AgentSessionStatus`**

Run: `grep -n "AgentSessionStatus" packages/vibedeckx/src/agent-types.ts`
If `"waiting"` is not part of the union, use the existing idle-ish status instead (e.g. `"completed"`); pick whatever the union allows and keep `updateStatus` consistent.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Runtime check — card entry appears**

Run `pnpm dev:all`, trigger an event-driven turn that calls a gated tool (as in Task 2 Step 5). Confirm a `tool_approval_request` entry is broadcast (visible in WS frames / a raw entry in the UI even before the card component exists), the status flips to waiting, and nothing is sent to the agent.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: surface tool-approval card and park the turn on event-driven sends"
```

---

### Task 5: Resume on decision (`resolveToolApproval`)

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (new method)

**Interfaces:**
- Consumes: `session.pendingApproval`, `runStream`, `ConversationPatch.replaceEntry`.
- Produces: `resolveToolApproval(sessionId: string, approvalId: string, approved: boolean): boolean` — idempotent first-wins; marks the card entry resolved; once all `approvalIds` are decided, builds the resume messages and re-runs the stream.

- [ ] **Step 1: Implement the method**

Add near `sendMessage`:

```ts
  /**
   * Record a user's decision on a parked tool-approval-request. Idempotent
   * first-wins per approvalId. When every approval awaited this turn has been
   * decided, append tool-approval-response messages and resume the stream so
   * approved tools execute and the model continues.
   */
  resolveToolApproval(sessionId: string, approvalId: string, approved: boolean): boolean {
    const session = this.sessions.get(sessionId);
    const pending = session?.pendingApproval;
    if (!session || !pending) return false;
    if (!pending.approvalIds.includes(approvalId)) return false;
    if (pending.decisions.has(approvalId)) return true; // first-wins: already decided

    pending.decisions.set(approvalId, approved);

    // Mark the card entry resolved so all clients render the final state.
    const entryIndex = pending.entryIndexByApprovalId.get(approvalId);
    if (entryIndex !== undefined) {
      const entry = session.store.entries[entryIndex];
      if (entry && entry.type === "tool_approval_request") {
        const resolved: AgentMessage = { ...entry, resolved: approved ? "approved" : "denied" };
        session.store.entries[entryIndex] = resolved;
        const patch = ConversationPatch.replaceEntry(entryIndex, resolved);
        session.store.patches.push(patch);
        this.broadcastPatch(session, patch);
      }
    }

    // Wait until every parked approval is decided before resuming.
    if (pending.decisions.size < pending.approvalIds.length) return true;

    const approvals = pending.approvalIds.map((id) => ({
      type: "tool-approval-response" as const,
      approvalId: id,
      approved: pending.decisions.get(id) ?? false,
    }));
    const resumeMessages: ModelMessage[] = [
      ...pending.baseMessages,
      ...pending.responseMessages,
      { role: "tool", content: approvals },
    ];
    session.pendingApproval = null;
    this.runStream(session, resumeMessages).catch((err) => {
      console.error(`[ChatSession] resume after approval failed for ${sessionId}:`, err);
    });
    return true;
  }
```

> If the `{ role: "tool", content: approvals }` literal fails typecheck, import and use `ToolApprovalResponse` from `ai` to type the `approvals` array, matching the SDK's `ModelMessage` tool-content shape.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: resume stream after tool-approval decision"
```

---

### Task 6: HTTP decision route

**Files:**
- Modify: `packages/vibedeckx/src/routes/chat-session-routes.ts` (new route after `/message`, ~line 87)

**Interfaces:**
- Consumes: `fastify.chatSessionManager.resolveToolApproval` (Task 5), `getAuthorizedSession` (existing, line 14).
- Produces: `POST /api/chat-sessions/:sessionId/tool-approval` body `{ approvalId: string; approved: boolean }`.

- [ ] **Step 1: Add the route**

After the `/message` route (line 87), insert:

```ts
  // Decide a parked tool-approval-request (event-driven outbound send)
  fastify.post<{
    Params: { sessionId: string };
    Body: { approvalId: string; approved: boolean };
  }>("/api/chat-sessions/:sessionId/tool-approval", async (req, reply) => {
    const { sessionId } = req.params;
    const { approvalId, approved } = req.body;

    const session = getAuthorizedSession(req, reply, sessionId);
    if (!session) return;

    if (typeof approvalId !== "string" || typeof approved !== "boolean") {
      return reply.code(400).send({ error: "approvalId (string) and approved (boolean) are required" });
    }

    const ok = fastify.chatSessionManager.resolveToolApproval(sessionId, approvalId, approved);
    if (!ok) {
      return reply.code(404).send({ error: "No matching pending approval" });
    }
    return reply.send({ ok: true });
  });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Runtime check — approve and deny end-to-end (via curl)**

Run `pnpm dev:all`, trigger a parked approval, copy its `approvalId` from logs/WS. Then:
- Approve: `curl -X POST localhost:5173/api/chat-sessions/<sid>/tool-approval -H 'content-type: application/json' -d '{"approvalId":"<id>","approved":true}'` → confirm the agent receives the message and the commander resumes.
- Repeat with a fresh parked approval and `"approved":false` → confirm the message is NOT sent and the model continues (output-denied).
- POST the same approvalId twice → second returns ok with no double-send (idempotent).

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/chat-session-routes.ts
git commit -m "feat: add tool-approval decision route for chat sessions"
```

---

### Task 7: Edge cases — cleanup + watchdog

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (`stopGeneration`, `resetSession`, session-close path, watchdog guard)

**Interfaces:**
- Consumes: `session.pendingApproval`.
- Produces: pending approvals are cleared on stop/reset/close; the watchdog never fires on a parked turn.

- [ ] **Step 1: Clear pending on stop and reset**

In `stopGeneration` and `resetSession`, add (before/after the existing abort/clear logic):

```ts
    session.pendingApproval = null;
```

Run `grep -n "stopGeneration\|resetSession\|abortController.abort" packages/vibedeckx/src/chat-session-manager.ts` to locate both methods.

- [ ] **Step 2: Clear pending where a session is removed/closed**

Find where sessions are deleted or sockets fully torn down (`grep -n "this.sessions.delete\|removeSession" packages/vibedeckx/src/chat-session-manager.ts`). If a session object is discarded there is nothing to clear; only add `session.pendingApproval = null;` if the session object survives a disconnect. (Document "no-op if session is discarded" in a comment.)

- [ ] **Step 3: Guard the watchdog against parked turns**

The watchdog (the `if (toolCallCountInStream === 0 && ...)` block) now lives inside `runStream` AFTER the approval-detection `return` (Task 4 Step 1), so a parked turn never reaches it — confirm by reading the method top-to-bottom. No code change needed if the early `return` precedes the watchdog. If the watchdog precedes the approval block, MOVE the approval block above it.

- [ ] **Step 4: Typecheck + read-through**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: PASS. Read `runStream` end-to-end to confirm the parked-turn early return is before the watchdog.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "fix: clear pending approvals on stop/reset; keep watchdog off parked turns"
```

---

### Task 8: Frontend API method

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (after the chat-session methods, ~line 1611)

**Interfaces:**
- Produces: `api.chatToolApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void>` → POST `/api/chat-sessions/:id/tool-approval`.

- [ ] **Step 1: Add the method**

Mirror the existing `setChatEventListening` / `resetChatSession` shape (lines 1595-1611). Add to the `api` object:

```ts
  async chatToolApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void> {
    const res = await authFetch(`${getApiBase()}/api/chat-sessions/${sessionId}/tool-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, approved }),
    });
    if (!res.ok) throw new Error("Tool approval failed");
  },
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat: add chatToolApproval api method"
```

---

### Task 9: Frontend approval card + renderer

**Files:**
- Create: `apps/vibedeckx-ui/components/conversation/tool-approval-card.tsx`
- Modify: `apps/vibedeckx-ui/components/conversation/main-conversation.tsx:298-312` (add renderer branch)

**Interfaces:**
- Consumes: `api.chatToolApproval` (Task 8), the `tool_approval_request` entry (`approvalId`, `tool`, `input`, `resolved`).
- Produces: `ToolApprovalCard` component rendering the proposed action + Approve/Deny; resolved state read from `msg.resolved`.

- [ ] **Step 1: Create the card component**

```tsx
"use client";

import { useState } from "react";
import { api } from "@/lib/api";

interface ToolApprovalCardProps {
  sessionId: string;
  approvalId: string;
  tool: string;
  input: unknown;
  resolved?: "approved" | "denied";
}

export function ToolApprovalCard({ sessionId, approvalId, tool, input, resolved }: ToolApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const label = tool === "spawnAgentSession" ? "Start a new coding agent" : "Send to the coding agent";
  const message =
    (input as { message?: string; prompt?: string })?.message ??
    (input as { prompt?: string })?.prompt ??
    JSON.stringify(input);

  const decide = async (approved: boolean) => {
    if (submitting || resolved) return;
    setSubmitting(true);
    try {
      await api.chatToolApproval(sessionId, approvalId, approved);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="font-medium text-amber-600">Approval needed · {label}</div>
      <pre className="mt-2 whitespace-pre-wrap break-words text-foreground/80">{message}</pre>
      {resolved ? (
        <div className="mt-2 text-xs text-muted-foreground">
          {resolved === "approved" ? "Approved — sent." : "Denied — not sent."}
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => decide(true)}
            disabled={submitting}
            className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => decide(false)}
            disabled={submitting}
            className="rounded bg-muted px-3 py-1 disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
```

> Match Tailwind tokens to the project's existing components if these class names differ; the structure is what matters.

- [ ] **Step 2: Render it in the message map**

In `main-conversation.tsx`, after the `tool_result` branch (line 298) and before `return null` (line 312), add. `session.id` is available from the `useChatSession` hook (line 96) — confirm the in-scope variable name and use it:

```tsx
            if (msg.type === "tool_approval_request") {
              return (
                <ToolApprovalCard
                  key={index}
                  sessionId={session!.id}
                  approvalId={msg.approvalId}
                  tool={msg.tool}
                  input={msg.input}
                  resolved={msg.resolved}
                />
              );
            }
```

Add the import at the top: `import { ToolApprovalCard } from "./tool-approval-card";`

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Full end-to-end runtime check**

Run `pnpm dev:all`. In a workspace: let the commander spawn an agent and wait for completion so an event-driven turn calls a gated tool. Confirm:
1. The approval card renders in Main Chat with the proposed message.
2. Approve → agent receives the message, card shows "Approved — sent.", commander resumes.
3. Repeat, Deny → card shows "Denied — not sent.", message not delivered.
4. Open the same chat in a second tab → both show the card; deciding in one resolves it in both.
5. Type a normal message yourself (user-driven turn) and confirm the commander's spawn/send happens WITHOUT a card (no gate on user turns).

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation/tool-approval-card.tsx apps/vibedeckx-ui/components/conversation/main-conversation.tsx
git commit -m "feat: render tool-approval card in Main Chat"
```

---

## Self-Review

**Spec coverage:**
- §4 provenance (`wokenByEvent`, not `eventDrivenTurn`) → Task 1 (field) + Task 2 (set + gate). ✓
- §5.1 needsApproval wiring → Task 2. ✓
- §5.2 fullStream detection + `response.messages` capture + resume → Task 4 (detect/park) + Task 5 (resume). ✓
- §5.3 WS/decision channel (realized as HTTP POST per existing `/message` pattern) → Task 6; idempotent first-wins → Task 5 Step 1. ✓
- §5.4 frontend card → Task 8 + Task 9. ✓
- §6 page-not-open (backend-driven, replay) → inherent (Task 4 pushes a persisted entry; existing replay surfaces it); restart-loses-pending → in-memory by design, documented; concurrent first-wins → Task 5; multi-approval bundling → Task 5 (resume only when all decided); abort/close cleanup → Task 7; watchdog → Task 7 Step 3. ✓
- §7 backend-enforced gate → Task 2/4/5 server-side; ownership via `getAuthorizedSession` → Task 6. ✓

**Placeholder scan:** No TBD/TODO. Two empirical-confirmation steps (Task 2 Step 5 part shape; Task 4 Step 2 status union) are explicit verification actions, not placeholders — required because the exact SDK part field names and the status union must be read from the live SDK/code, with concrete fallbacks given.

**Type consistency:** `wokenByEvent`, `pendingApproval`, `PendingApproval` fields, `resolveToolApproval(sessionId, approvalId, approved)`, `api.chatToolApproval(sessionId, approvalId, approved)`, and the `tool_approval_request` entry shape (`tool`/`input`/`approvalId`/`resolved`) are used identically across backend, route, API, and component.
