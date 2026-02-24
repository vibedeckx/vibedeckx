# Routing Refactor & Global Event Stream — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor frontend to path-based project routing (`/projects/[projectId]`) and add a global SSE event stream for real-time cross-project notifications.

**Architecture:** Backend gets an EventBus (typed EventEmitter) that AgentSessionManager, ProcessManager, and task routes emit to. A new SSE endpoint streams these events to all connected clients. Frontend routing moves project identity from query params to path segments, with a global events hook replacing polling.

**Tech Stack:** Fastify (SSE via raw reply), Next.js App Router (dynamic segments), EventSource API, TypeScript

**Design doc:** `docs/plans/2026-02-24-routing-and-global-events-design.md`

---

## Task 1: Create EventBus

**Files:**
- Create: `packages/vibedeckx/src/event-bus.ts`

**Step 1: Create the EventBus class**

```typescript
// packages/vibedeckx/src/event-bus.ts
import { EventEmitter } from "events";

// Event payload types
export type GlobalEvent =
  | { type: "session:status"; projectId: string; branch: string | null; sessionId: string; status: "running" | "stopped" | "error" }
  | { type: "session:finished"; projectId: string; branch: string | null; sessionId: string; duration_ms?: number; cost_usd?: number }
  | { type: "task:created"; projectId: string; task: Record<string, unknown> }
  | { type: "task:updated"; projectId: string; task: Record<string, unknown> }
  | { type: "task:deleted"; projectId: string; taskId: string }
  | { type: "executor:started"; projectId: string; executorId: string; processId: string }
  | { type: "executor:stopped"; projectId: string; executorId: string; processId: string; exitCode: number };

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: GlobalEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: GlobalEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
```

**Step 2: Verify backend types compile**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors related to event-bus.ts

**Step 3: Commit**

```bash
git add packages/vibedeckx/src/event-bus.ts
git commit -m "feat: add typed EventBus for global event streaming"
```

---

## Task 2: Register EventBus as Fastify decoration

**Files:**
- Modify: `packages/vibedeckx/src/server-types.ts` (line 24 — add EventBus to FastifyInstance)
- Modify: `packages/vibedeckx/src/plugins/shared-services.ts` (line 23 — add eventBus decoration)

**Step 1: Add EventBus type to FastifyInstance**

In `server-types.ts`, add import and declaration:

```typescript
// Add import at top (after line 3)
import type { EventBus } from "./event-bus.js";

// Add to FastifyInstance interface (after line 23)
    eventBus: EventBus;
```

**Step 2: Create and decorate EventBus in shared-services**

In `plugins/shared-services.ts`:

```typescript
// Add import (after line 5)
import { EventBus } from "../event-bus.js";

// Add after line 17 (after remoteSessionMap creation)
  const eventBus = new EventBus();

// Add after line 23 (after remoteSessionMap decoration)
  fastify.decorate("eventBus", eventBus);
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/vibedeckx/src/server-types.ts packages/vibedeckx/src/plugins/shared-services.ts
git commit -m "feat: register EventBus as Fastify decoration"
```

---

## Task 3: Create SSE endpoint

**Files:**
- Create: `packages/vibedeckx/src/routes/event-routes.ts`
- Modify: `packages/vibedeckx/src/server.ts` (line 92 — register route)

**Step 1: Create the SSE route**

```typescript
// packages/vibedeckx/src/routes/event-routes.ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial keepalive
    reply.raw.write(":ok\n\n");

    // Subscribe to all events
    const unsubscribe = fastify.eventBus.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
      reply.raw.write(":keepalive\n\n");
    }, 15000);

    // Cleanup on client disconnect
    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(keepalive);
    });

    // Prevent Fastify from sending a response (we're handling it raw)
    await reply;
  });
};

export default fp(routes, { name: "event-routes" });
```

**Step 2: Register the route in server.ts**

In `server.ts`:

```typescript
// Add import (after line 18)
import eventRoutes from "./routes/event-routes.js";

// Add registration (after line 92, after taskRoutes)
  server.register(eventRoutes);
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/vibedeckx/src/routes/event-routes.ts packages/vibedeckx/src/server.ts
git commit -m "feat: add SSE endpoint GET /api/events"
```

---

## Task 4: Emit session events from AgentSessionManager

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts`

The AgentSessionManager does not currently have access to the EventBus. We need to inject it.

**Step 1: Add EventBus to constructor**

In `agent-session-manager.ts`:

```typescript
// Add import (after line 13)
import type { EventBus } from "./event-bus.js";

// Modify class fields (after line 46)
  private eventBus: EventBus | null = null;

// Add setter method (after constructor, around line 50)
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }
```

Using a setter instead of constructor injection avoids changing the constructor signature (which is called in shared-services.ts).

**Step 2: Emit events at each status broadcast point**

Add `this.eventBus?.emit(...)` after each `broadcastPatch(sessionId, ConversationPatch.updateStatus(...))` call:

**Line 184** (cwd error):
```typescript
this.broadcastPatch(session.id, ConversationPatch.updateStatus("error"));
this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "error" });
```

**Line 248-253** (process exit):
```typescript
this.broadcastPatch(session.id, ConversationPatch.updateStatus(session.status));
this.broadcastRaw(session.id, { finished: true });
this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: session.status });
```

**Line 602** (stop session):
```typescript
this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
```

**Line 656** (restart session):
```typescript
this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });
```

**Line 700** (switch mode):
```typescript
this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });
```

**Step 3: Wire up EventBus in shared-services.ts**

In `plugins/shared-services.ts`, after the eventBus creation and agentSessionManager creation:

```typescript
  agentSessionManager.setEventBus(eventBus);
```

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/plugins/shared-services.ts
git commit -m "feat: emit session status events to EventBus"
```

---

## Task 5: Emit executor events from ProcessManager

**Files:**
- Modify: `packages/vibedeckx/src/process-manager.ts`

**Step 1: Add EventBus to ProcessManager**

```typescript
// Add import (after line 4)
import type { EventBus } from "./event-bus.js";

// Add field (after line 32)
  private eventBus: EventBus | null = null;

// Add setter (after constructor)
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }
```

**Step 2: Emit executor:started in start() method**

In the `start()` method, after the process is successfully started (after line 71, before `return processId`):

```typescript
    this.eventBus?.emit({ type: "executor:started", projectId: executor.project_id, executorId: executor.id, processId });
```

Note: Check that `Executor` type has `project_id`. It should since it comes from the DB.

**Step 3: Emit executor:stopped in exit handlers**

In PTY exit handler (line 124, after `this.broadcast(processId, msg)` on line 136):

```typescript
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.executorId, executorId: runningProcess.executorId, processId, exitCode: code });
```

Wait — we need projectId but RunningProcess only has `executorId` and `projectPath`. We need to add `projectId` to RunningProcess.

**Step 3 (revised): Add projectId to RunningProcess**

Modify the `RunningProcess` interface (line 18):

```typescript
interface RunningProcess {
  process: ChildProcess | IPty;
  isPty: boolean;
  logs: LogMessage[];
  subscribers: Set<LogSubscriber>;
  executorId: string;
  projectId: string;  // NEW
  projectPath: string;
  skipDb: boolean;
}
```

Then in `start()` method, we need to get projectId from the executor. Check if `Executor` has `project_id`. Add it when creating the RunningProcess objects in `startPtyProcess` (line 103) and `startRegularProcess` (line 156). Pass it through from `start()`.

Modify `startPtyProcess` and `startRegularProcess` signatures to accept `projectId`:

```typescript
private startPtyProcess(processId: string, executor: Executor, cwd: string, skipDb = false): void {
    // ... existing code ...
    const runningProcess: RunningProcess = {
      process: ptyProcess,
      isPty: true,
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,  // NEW
      projectPath: cwd,
      skipDb,
    };
```

Same for `startRegularProcess`.

**Step 4: Emit in exit handlers**

PTY exit (after line 136):
```typescript
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: code });
```

Regular process exit (after line 196):
```typescript
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode });
```

Regular process error (after line 217):
```typescript
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: 1 });
```

Emit started in `start()` (before `return processId` on line 73):
```typescript
    this.eventBus?.emit({ type: "executor:started", projectId: executor.project_id, executorId: executor.id, processId });
```

**Step 5: Wire up in shared-services.ts**

```typescript
  processManager.setEventBus(eventBus);
```

**Step 6: Verify it compiles**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/process-manager.ts packages/vibedeckx/src/plugins/shared-services.ts
git commit -m "feat: emit executor process events to EventBus"
```

---

## Task 6: Emit task events from task routes

**Files:**
- Modify: `packages/vibedeckx/src/routes/task-routes.ts`

**Step 1: Emit after task mutations**

In `task-routes.ts`, add eventBus.emit calls after each mutation:

**After task create** (line 63, before `return reply`):
```typescript
    fastify.eventBus.emit({ type: "task:created", projectId: req.params.projectId, task: task as unknown as Record<string, unknown> });
```

**After task update** (line 84, before `return reply`):
```typescript
    fastify.eventBus.emit({ type: "task:updated", projectId: existing.project_id, task: task as unknown as Record<string, unknown> });
```

**After task delete** (line 94, before `return reply`):
```typescript
    fastify.eventBus.emit({ type: "task:deleted", projectId: existing.project_id, taskId: req.params.id });
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/vibedeckx/src/routes/task-routes.ts
git commit -m "feat: emit task events to EventBus"
```

---

## Task 7: Create useGlobalEvents frontend hook

**Files:**
- Create: `apps/vibedeckx-ui/hooks/use-global-events.ts`
- Modify: `apps/vibedeckx-ui/lib/api.ts` (export `getApiBase`)

**Step 1: Export getApiBase from api.ts**

In `lib/api.ts`, change line 11 from:
```typescript
function getApiBase(): string {
```
to:
```typescript
export function getApiBase(): string {
```

**Step 2: Create the hook**

```typescript
// apps/vibedeckx-ui/hooks/use-global-events.ts
"use client";

import { useEffect, useRef, useCallback } from "react";
import { getApiBase } from "@/lib/api";

export type GlobalEvent =
  | { type: "session:status"; projectId: string; branch: string | null; sessionId: string; status: "running" | "stopped" | "error" }
  | { type: "session:finished"; projectId: string; branch: string | null; sessionId: string; duration_ms?: number; cost_usd?: number }
  | { type: "task:created"; projectId: string; task: Record<string, unknown> }
  | { type: "task:updated"; projectId: string; task: Record<string, unknown> }
  | { type: "task:deleted"; projectId: string; taskId: string }
  | { type: "executor:started"; projectId: string; executorId: string; processId: string }
  | { type: "executor:stopped"; projectId: string; executorId: string; processId: string; exitCode: number };

type EventListener = (event: GlobalEvent) => void;

export function useGlobalEvents() {
  const listenersRef = useRef<Set<EventListener>>(new Set());
  const eventSourceRef = useRef<EventSource | null>(null);

  // Connect on mount, reconnect is handled by EventSource natively
  useEffect(() => {
    const url = `${getApiBase()}/api/events`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as GlobalEvent;
        for (const listener of listenersRef.current) {
          listener(parsed);
        }
      } catch {
        // Ignore parse errors (keepalive comments, etc.)
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
      console.log("[GlobalEvents] SSE connection error, will auto-reconnect");
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const subscribe = useCallback((listener: EventListener): (() => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return { subscribe };
}
```

**Step 3: Verify frontend types compile**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-global-events.ts apps/vibedeckx-ui/lib/api.ts
git commit -m "feat: add useGlobalEvents hook with SSE client"
```

---

## Task 8: Refactor routing — create project page

**Files:**
- Create: `apps/vibedeckx-ui/app/projects/[projectId]/page.tsx`
- Modify: `apps/vibedeckx-ui/app/page.tsx`

**Step 1: Create the project page**

Create `apps/vibedeckx-ui/app/projects/[projectId]/page.tsx`. This is essentially the current `HomeContent` from `app/page.tsx` but:

- Instead of reading `projectId` from `searchParams.get('project')`, read it from `params.projectId`
- Remove the `urlProject` search param, use `params` instead
- Keep `urlTab` and `urlBranch` from search params
- The URL sync effect (lines 168-176) should no longer write `project` to query params — it's now in the path
- `selectProject` in the page should call `router.push(`/projects/${project.id}`)` instead of just `selectProject(project)`
- The `useProjects` hook is still used for the project list + CRUD, but `currentProject` is derived from `params.projectId`

Key changes from current `page.tsx`:

```typescript
'use client';

import { use, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
// ... same imports as current page.tsx ...

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  return (
    <Suspense>
      <ProjectContent params={params} />
    </Suspense>
  );
}

function ProjectContent({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlTab = searchParams.get('tab');
  const urlBranch = searchParams.get('branch');

  // useProjects now receives projectId from path
  const {
    projects,
    currentProject,
    loading: projectsLoading,
    createProject,
    updateProject,
    deleteProject,
  } = useProjects(projectId);

  // selectProject navigates via router
  const handleSelectProject = useCallback((project: Project) => {
    router.push(`/projects/${project.id}`);
  }, [router]);

  // ... rest of HomeContent logic, replacing selectProject with handleSelectProject ...

  // URL sync effect — only tab and branch, no project
  useEffect(() => {
    if (projectsLoading) return;
    const params = new URLSearchParams();
    if (activeView !== 'tasks') params.set('tab', activeView);
    if (selectedBranch) params.set('branch', selectedBranch);
    const url = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [activeView, selectedBranch, projectsLoading]);

  // ... rest is same as current HomeContent ...
}
```

Also need to handle the "no projects" case: if `projectId` from URL doesn't match any project, redirect to `/` or show an error.

**Step 2: Convert app/page.tsx to redirect**

Replace the current `app/page.tsx` with a redirect page:

```typescript
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    api.getProjects().then((projects) => {
      if (projects.length > 0) {
        router.replace(`/projects/${projects[0].id}`);
      }
    });
  }, [router]);

  // Show nothing while redirecting, or a create-project UI if no projects
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold">Welcome to Vibedeckx</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}
```

Note: The "no projects" welcome screen with create button should also live here (or on the project page when project not found).

**Step 3: Update createProject to navigate**

In the project page, after `createProject` succeeds, navigate to the new project:

```typescript
const handleCreateProject = useCallback(async (opts: Parameters<typeof createProject>[0]) => {
  const project = await createProject(opts);
  router.push(`/projects/${project.id}`);
  return project;
}, [createProject, router]);
```

**Step 4: Verify frontend types compile**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add apps/vibedeckx-ui/app/projects/[projectId]/page.tsx apps/vibedeckx-ui/app/page.tsx
git commit -m "feat: refactor routing to use path variable for projects"
```

---

## Task 9: Wire useGlobalEvents into data hooks

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-tasks.ts`
- Modify: `apps/vibedeckx-ui/hooks/use-executors.ts`
- Delete: `apps/vibedeckx-ui/hooks/use-session-statuses.ts`

**Step 1: Add global events context**

We need the `subscribe` function from `useGlobalEvents` to be available throughout the component tree. The simplest way: call `useGlobalEvents()` at the app root (layout or project page) and pass `subscribe` via context.

Create a context provider in the project page:

```typescript
// In app/projects/[projectId]/page.tsx (or a new providers file)
import { createContext, useContext } from 'react';
import { useGlobalEvents } from '@/hooks/use-global-events';
import type { GlobalEvent } from '@/hooks/use-global-events';

type EventSubscriber = (listener: (event: GlobalEvent) => void) => () => void;

const GlobalEventsContext = createContext<EventSubscriber | null>(null);

export function useGlobalEventsSubscribe(): EventSubscriber {
  const subscribe = useContext(GlobalEventsContext);
  if (!subscribe) throw new Error("useGlobalEventsSubscribe must be used within GlobalEventsProvider");
  return subscribe;
}
```

Then wrap the project page content in `<GlobalEventsContext.Provider value={subscribe}>`.

Actually, simpler approach: put `useGlobalEvents` in the layout and pass subscribe via context. But since we're doing static export, let's keep it in the project page for now.

**Step 2: Update useTasks to accept subscribe**

Modify `hooks/use-tasks.ts` to accept an optional event subscriber and react to task events:

```typescript
// Add parameter
export function useTasks(projectId: string | null, subscribe?: (listener: (event: GlobalEvent) => void) => () => void) {
  // ... existing code ...

  // Subscribe to real-time task events
  useEffect(() => {
    if (!subscribe || !projectId) return;
    return subscribe((event) => {
      if (event.type === "task:created" && event.projectId === projectId) {
        setTasks((prev) => [...prev, event.task as unknown as Task]);
      } else if (event.type === "task:updated" && event.projectId === projectId) {
        const updated = event.task as unknown as Task;
        setTasks((prev) => prev.map((t) => t.id === updated.id ? updated : t));
      } else if (event.type === "task:deleted" && event.projectId === projectId) {
        setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
      }
    });
  }, [subscribe, projectId]);
```

**Step 3: Update useExecutors to accept subscribe**

Modify `hooks/use-executors.ts`:

```typescript
// In useExecutors, add subscribe parameter
// Subscribe to executor events:
useEffect(() => {
  if (!subscribe) return;
  return subscribe((event) => {
    if (event.type === "executor:started") {
      setRunningProcesses((prev) => {
        const newMap = new Map(prev);
        newMap.set(event.executorId, event.processId);
        return newMap;
      });
    } else if (event.type === "executor:stopped") {
      setRunningProcesses((prev) => {
        const newMap = new Map(prev);
        newMap.delete(event.executorId);
        return newMap;
      });
    }
  });
}, [subscribe]);
```

**Step 4: Delete use-session-statuses.ts**

Remove the file. The only import is in `app/page.tsx` (now `app/projects/[projectId]/page.tsx`). Replace its usage with the global events stream.

In the project page, replace `useSessionStatuses` with an effect that subscribes to `session:status` events and builds the same `Map<string, AgentSessionStatus>`:

```typescript
const [sessionStatuses, setSessionStatuses] = useState<Map<string, AgentSessionStatus>>(new Map());

useEffect(() => {
  if (!subscribe || !currentProject) return;
  return subscribe((event) => {
    if (event.projectId !== currentProject.id) return;
    if (event.type === "session:status") {
      setSessionStatuses((prev) => {
        const next = new Map(prev);
        next.set(event.branch ?? "", event.status);
        return next;
      });
    }
  });
}, [subscribe, currentProject?.id]);
```

Also need an initial fetch of session statuses on mount (the SSE stream only sends changes, not initial state). Keep a one-time fetch similar to the old hook's initial call, but no polling.

**Step 5: Update project page to pass subscribe to hooks**

Pass the `subscribe` function from `useGlobalEvents` to `useTasks` and `useExecutors`.

**Step 6: Verify frontend types compile**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-tasks.ts apps/vibedeckx-ui/hooks/use-executors.ts apps/vibedeckx-ui/app/projects/[projectId]/page.tsx
git rm apps/vibedeckx-ui/hooks/use-session-statuses.ts
git commit -m "feat: wire global events into data hooks, remove polling"
```

---

## Task 10: Update useProjects for path-based routing

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-projects.ts`

**Step 1: Remove selectProject, adjust currentProject derivation**

The hook no longer needs to manage `currentProject` selection state. The project page already knows its `projectId` from the URL. The hook should:

- Still fetch all projects (for the selector dropdown)
- Derive `currentProject` from `initialProjectId` (which now always comes from the URL path param)
- Remove `selectProject` from the return value

```typescript
export function useProjects(initialProjectId?: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // Derive currentProject from projects list + URL param
  const currentProject = useMemo(() => {
    if (!initialProjectId || projects.length === 0) return null;
    return projects.find((p) => p.id === initialProjectId) ?? null;
  }, [projects, initialProjectId]);

  // ... fetchProjects stays the same but simpler (no currentProject check) ...
  // ... createProject, updateProject, deleteProject stay the same but don't call setCurrentProject ...

  return {
    projects,
    currentProject,
    loading,
    createProject,
    updateProject,
    deleteProject,
    refresh: fetchProjects,
  };
}
```

**Step 2: Verify frontend types compile**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-projects.ts
git commit -m "refactor: simplify useProjects for path-based routing"
```

---

## Task 11: Update ProjectSelector for router navigation

**Files:**
- Modify: `apps/vibedeckx-ui/components/project/project-selector.tsx`

**Step 1: Change onSelectProject to navigate**

The `ProjectSelector` currently calls `onSelectProject(project)` which sets state. Now it should navigate. Two options:

A) Change `onSelectProject` prop to accept a project and let the parent handle navigation (already done in Task 8)
B) Use `useRouter` directly in ProjectSelector

Option A is cleaner — the parent already wraps it with `router.push`. Just verify the prop is wired correctly. The `ProjectSelector` component itself doesn't need to change if the parent provides a callback that does `router.push`.

**Step 2: Verify the wiring in project page**

In `app/projects/[projectId]/page.tsx`, ensure:

```tsx
<ProjectSelector
  projects={projects}
  currentProject={currentProject}
  onSelectProject={handleSelectProject}  // This does router.push
  onCreateProject={handleCreateProject}  // This creates + router.push
/>
```

**Step 3: Commit** (if any changes needed)

```bash
git add apps/vibedeckx-ui/components/project/project-selector.tsx
git commit -m "refactor: update ProjectSelector for router-based project switching"
```

---

## Task 12: Full build verification

**Step 1: Type-check backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors

**Step 2: Type-check frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

**Step 3: Build frontend**

Run: `pnpm build:ui`
Expected: Static export succeeds, `projects/[projectId]/` directory created in output

**Step 4: Build backend**

Run: `pnpm build:main`
Expected: No errors

**Step 5: Full build**

Run: `pnpm build`
Expected: Complete success

**Step 6: Commit any fixes**

If any build issues found, fix and commit.

---

## Task 13: Manual smoke test

**Step 1: Start dev servers**

Run: `pnpm dev:all`

**Step 2: Verify routing**

- Navigate to `http://localhost:3000` → should redirect to `/projects/<first-project-id>`
- URL should show `/projects/<id>?tab=tasks`
- Switching tabs → URL updates query param only
- Switching projects via selector → URL path changes to new project ID
- Browser back/forward works for project switches

**Step 3: Verify SSE**

- Open browser DevTools Network tab, filter for EventStream
- Should see a persistent connection to `/api/events`
- Create/update/delete a task → should see events in the stream
- Start an agent session → should see `session:status` event

**Step 4: Verify cross-project notifications**

- Have two projects with agent sessions
- While viewing project B, start an agent in project A (via API or another tab)
- Session status indicators should update for project A even while viewing project B

**Step 5: Commit any fixes**

```bash
git commit -m "fix: address smoke test issues"
```
