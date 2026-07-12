# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vibedeckx is an AI-powered app generator with project management. It's a pnpm monorepo with a Fastify backend (CLI tool) and a Next.js frontend that gets statically exported and bundled into the backend for distribution.

## Commands

```bash
# Development
pnpm dev              # Frontend dev server (port 3000)
pnpm dev:server       # Backend TypeScript watch mode
pnpm dev:all          # Both concurrently (backend on 5173, frontend on 3000)

# Build
pnpm build            # Full production build (backend + frontend + copy)
pnpm build:main       # Backend only (tsc)
pnpm build:ui         # Frontend only (next build → static export)

# Run production
pnpm start            # node packages/vibedeckx/dist/bin.js

# Type checking
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json    # Backend
cd apps/vibedeckx-ui && npx tsc --noEmit                 # Frontend

# Lint (frontend only)
pnpm --filter vibedeckx-ui lint
```

# Tests (vitest, colocated *.test.ts files in packages/vibedeckx/src/)
pnpm --filter vibedeckx test

## Monorepo Structure

- `packages/vibedeckx/` — Backend: Fastify server + CLI (`@stricli/core`), published as npm package
- `apps/vibedeckx-ui/` — Frontend: Next.js 16 with React 19, static export (`output: "export"`)
- Package manager: **pnpm** with workspaces (`pnpm-workspace.yaml`)

## Architecture

### Backend (`packages/vibedeckx/src/`)

**Server** (`server.ts`): Fastify with CORS, optional API key auth (`VIBEDECKX_API_KEY` env var), WebSocket support, and static file serving of the bundled UI. The cross-remote MCP gateway (letting an agent on one remote diagnose another) requires `VIBEDECKX_PUBLIC_URL` — the SaaS server's publicly reachable base URL (e.g. `https://app.example.com`). Without it no session-scoped token is minted and no `--mcp-config` is injected, so the feature stays off.

**Storage** (`storage/`): SQLite via `better-sqlite3` with WAL mode. Database at `~/.vibedeckx/data.sqlite`. Schema auto-created on startup. `Storage` interface in `types.ts`, implementation in `sqlite.ts`. Entities: projects, executor_groups, executors, executor_processes, agent_sessions, tasks.

**Agent Session Manager** (`agent-session-manager.ts`): Core of the app. Spawns Claude Code as a child process with `--permission-mode` flag. Each `RunningSession` tracks the process, a `MessageStore` (patches + entries), and a set of WebSocket subscribers. Detects native `claude` binary or falls back to `npx`. Max one active session per branch.

**Conversation Patch System** (`conversation-patch.ts`): Uses RFC 6902 JSON Patch operations to stream message updates over WebSocket. Patch types: `ENTRY` (add/update message), `STATUS` (session status change), `READY`, `FINISHED`. Frontend applies patches with Immer's `produce()`.

**Process Manager** (`process-manager.ts`): Spawns executor processes with PTY support (`node-pty`), manages stdout/stderr streaming.

**Remote Proxy** (`routes/remote-routes.ts`, `utils/remote-proxy.ts`): Proxies requests/WebSocket connections to remote servers. Remote sessions/executors use `remote-` prefix in IDs. Project config stored locally, execution happens remotely.

**Plugin** (`plugins/shared-services.ts`): Fastify plugin that decorates the instance with `storage`, `processManager`, `agentSessionManager`, `remoteExecutorMap`, `remoteSessionMap`.

### Frontend (`apps/vibedeckx-ui/`)

**API layer** (`lib/api.ts`): Central `api` object with all REST calls. Auto-detects dev mode (port 3000 → proxy to backend at 5173) vs production (relative paths). Also contains all shared TypeScript interfaces used by components.

**Agent session hook** (`hooks/use-agent-session.ts`): Core hook managing WebSocket connection, JSON Patch application via Immer, auto-reconnection with exponential backoff, and history replay on reconnect.

**Tool UIs** (`components/agent/`): `agent-message.tsx` renders tool-specific UIs for Claude Code tools (Bash, Edit, Glob, Grep, etc.). Interactive tools like `AskUserQuestion` and `ExitPlanMode` use `AgentConversationContext` to call `sendMessage`. The `messageIndex` check determines if a tool_use has been responded to (next message is user type).

**Permission mode switching**: Plan mode → Edit mode triggered by `ExitPlanMode` tool. Calls `/api/agent-sessions/:id/exit-plan-mode`. Message history preserved, only streaming state resets.

**UI framework**: Tailwind CSS v4, shadcn/ui components (`components/ui/`), Radix primitives, Lucide icons.

### Key Patterns

- Backend uses ESM (`"type": "module"`) with NodeNext module resolution — all local imports need `.js` extensions
- Frontend path alias: `@/*` maps to project root
- WebSocket messages are typed as `AgentWsMessage`: `{ JsonPatch }`, `{ Ready }`, `{ finished }`, `{ error }`, `{ taskCompleted }`
- `EntryIndexProvider` generates monotonic indices for message ordering
- Git worktree support: `resolveWorktreePath()` in `utils/worktree-paths.ts` resolves paths relative to project or parent directory
- Agent CLI protocol knowledge (stream-json / Codex JSON-RPC shapes, CLI flags, binary detection) lives in `packages/vibedeckx/src/protocol/` — providers and process-manager consume it; never re-implement parsing or arg-building inline. Offline contract tests validate recorded fixtures against the zod schemas there.

### Default Ports

- Frontend dev: **3000**
- Backend dev: **5173**
- Production: **3000** (configurable via `--port`)
