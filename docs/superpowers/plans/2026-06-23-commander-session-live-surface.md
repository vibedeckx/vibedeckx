# Commander Session Live-Surface (Req 2 Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Main Chat commander spawns a new agent session on a workspace the user is currently viewing, auto-surface that session into the already-open agent window (today only the workspace dot lights up; the window doesn't change).

**Architecture:** A pure-frontend reaction chain. A new single-purpose hook subscribes to the shared `/api/events` SSE stream and, on a `session:status` event naming a session for the current workspace that differs from the one loaded, calls back with that session id. `agent-conversation.tsx` wires the callback to the existing `setSessionUrlParam`, reusing the existing `explicitSessionId` → reset → load machinery (approach ①). No backend changes; no `use-agent-session.ts` internal changes.

**Tech Stack:** TypeScript, React (Next.js 16), the existing `useGlobalEventStream` shared-SSE hook.

## Global Constraints

- **Scope = frontend live-surface only.** No backend changes (the `session:status` event is already emitted, on the wire, and tenant-filtered). No `use-agent-session.ts` internal changes — drive it purely via its existing `explicitSessionId` input. (Spec `docs/superpowers/specs/2026-06-23-commander-session-live-surface-design.md` §6.)
- **Auto-swap is unconditional (semantics A).** The reaction does NOT special-case placeholder (New Conversation) or history-pinned (`explicitSessionId`) state — both get overridden by the new session id. "Respect history-pinned / don't-interrupt-when-busy" (approach B) is explicitly out of scope.
- **Mode-agnostic.** Do NOT branch on local vs remote. Remote `session:status` events already carry the local `remote-{mode}-{project}-{remoteId}` id, which the existing load path resolves identically to a local id. The reaction passes `event.sessionId` through verbatim.
- **Trigger event = `session:status`.** It carries `{ projectId, branch, sessionId, status, agentType }`. A spawned agent always runs after its prompt, so a `running` event with the new `sessionId` reliably fires.
- **NO test framework is configured** (per CLAUDE.md). Verification = frontend type-check passes: `cd apps/vibedeckx-ui && npx tsc --noEmit`. The whole-frontend tsc has ONE pre-existing unrelated error in `components/files/file-preview.tsx` (missing `rehype-slug` module) — that is NOT this work's concern and must remain untouched. No new error may reference the changed files.
- **No internal refs needed in the new hook.** `useGlobalEventStream` already stores the listener in a ref it refreshes every render, so the inline closure reads fresh `projectId` / `branch` / `currentSessionId` / `onSurface` each render (same pattern `use-branch-activity.ts` relies on). Adding extra refs would be redundant.

---

### Task 1: Create the `useSurfaceCommanderSession` hook

**Files:**
- Create: `apps/vibedeckx-ui/hooks/use-surface-commander-session.ts`

**Interfaces:**
- Consumes: `useGlobalEventStream(listener: (data: GlobalEvent) => void): void` from `@/hooks/global-event-stream`, where `GlobalEvent = { type?: string; [key: string]: unknown }`.
- Produces: `useSurfaceCommanderSession(projectId: string | null, branch: string | null, currentSessionId: string | null, onSurface: (sessionId: string) => void): void` — consumed by Task 2.

- [ ] **Step 1: Write the hook**

Create `apps/vibedeckx-ui/hooks/use-surface-commander-session.ts` with exactly:

```ts
import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Surface a commander-created agent session into an already-open agent window.
 *
 * The agent panel normally only (re)loads its session on mount / workspace
 * switch / manual history pick. When the Main Chat commander spawns a new agent
 * session on THIS workspace in the background, the panel would otherwise not
 * show it (only the workspace dot lights up). This hook listens to the shared
 * `/api/events` stream and, when a `session:status` event names a session for
 * this workspace that differs from the one currently loaded, calls
 * `onSurface(sessionId)` so the caller can navigate to it.
 *
 * Mode-agnostic: remote `session:status` events already carry the local
 * `remote-{mode}-{project}-{remoteId}` id, which the existing load path
 * resolves the same as a local id — so `event.sessionId` passes through verbatim.
 *
 * No internal refs are needed: `useGlobalEventStream` refreshes its listener
 * ref every render, so this inline closure always reads fresh argument values.
 */
export function useSurfaceCommanderSession(
  projectId: string | null,
  branch: string | null,
  currentSessionId: string | null,
  onSurface: (sessionId: string) => void,
): void {
  useGlobalEventStream((data) => {
    if (data.type !== "session:status") return;
    const evt = data as unknown as {
      type: "session:status";
      projectId: string;
      branch: string | null;
      sessionId: string;
    };
    // Only this workspace (normalize null branches before comparing).
    if (!projectId || evt.projectId !== projectId) return;
    if ((evt.branch ?? null) !== (branch ?? null)) return;
    // Dedup / loop-guard: ignore the session already loaded in the panel — its
    // own subsequent running/stopped events carry the same id.
    if (!evt.sessionId || evt.sessionId === currentSessionId) return;
    onSurface(evt.sessionId);
  });
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no error referencing `use-surface-commander-session.ts`. Only the pre-existing unrelated `file-preview.tsx` (`rehype-slug`) error may remain. Confirm with:

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit 2>&1 | grep -E "use-surface-commander-session" || echo "(clean)"`
Expected: `(clean)`

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-surface-commander-session.ts
git commit -m "feat: add useSurfaceCommanderSession hook for live session surfacing"
```

---

### Task 2: Wire the hook into `agent-conversation.tsx`

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` (add import near line 4; add hook call after the `useAgentSession(...)` block, ~line 184)

**Interfaces:**
- Consumes: `useSurfaceCommanderSession(projectId, branch, currentSessionId, onSurface)` from Task 1. In scope at the call site: `projectId: string | null` and `branch: string | null` (props), `session` (from the `useAgentSession` destructure — `session?.id` is the current loaded id), and `setSessionUrlParam?: (id: string | null) => void` (optional prop).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

In `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`, immediately after the existing line 4 import:

```ts
import { useAgentSession } from "@/hooks/use-agent-session";
```

add:

```ts
import { useSurfaceCommanderSession } from "@/hooks/use-surface-commander-session";
```

- [ ] **Step 2: Add the hook call**

The `useAgentSession(...)` destructure block ends with `});` (currently line 184), followed by a blank line and the comment `// Fetch available agent providers on mount` (currently line 186). Insert the hook call in that gap. Change:

```ts
  });

  // Fetch available agent providers on mount
```

to:

```ts
  });

  // Surface a commander-spawned session into this open window (auto-swap).
  useSurfaceCommanderSession(
    projectId,
    branch,
    session?.id ?? null,
    (id) => setSessionUrlParam?.(id),
  );

  // Fetch available agent providers on mount
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no error referencing `agent-conversation.tsx`. Only the pre-existing unrelated `file-preview.tsx` (`rehype-slug`) error may remain. Confirm with:

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit 2>&1 | grep -E "agent-conversation" || echo "(clean)"`
Expected: `(clean)`

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat: auto-surface commander-spawned sessions in the open agent window"
```

---

### Task 3: Manual end-to-end verification (interactive — requires running app + human)

**Files:** none (verification only).

No test framework exists, so runtime behavior is verified manually. This task is NOT auto-runnable: it needs the live app (`pnpm dev:all`) and human observation. Record results; do not block the branch on it if the app can't be run in this environment.

- [ ] **Step 1: Local workspace, three idle states**

Run `pnpm dev:all`. Open a LOCAL workspace's agent window. For each starting state — (a) empty/no session, (b) placeholder after clicking "New Conversation", (c) showing an old stopped session — have the Main Chat commander call `spawnAgentSession`. Expected each time: the new session auto-appears in the open window (messages + streaming), no manual switch needed.

- [ ] **Step 2: Remote workspace**

Repeat Step 1 against a REMOTE-only workspace (reverse-connect tunnel up). Expected: identical auto-surface behavior (the remote `session:status` event carries the local `remote-...` id and loads the same way).

- [ ] **Step 3: Loop / no-spurious-swap check**

With a session already loaded and running in the open window, send it a follow-up via `sendToAgentSession` (same session). Expected: NO swap/reload flicker — the WS stream updates in place (the event's `sessionId` equals the loaded id, so the dedup guard skips it).

- [ ] **Step 4: Cross-workspace isolation**

While viewing workspace A's agent window, have the commander spawn on workspace B. Expected: A's window does NOT change; B's dot lights up; switching to B loads the new session as before.
