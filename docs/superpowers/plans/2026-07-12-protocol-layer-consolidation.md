# Protocol Layer Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all Claude Code / Codex CLI protocol knowledge into `packages/vibedeckx/src/protocol/` (schemas, codecs, CLI arg builders, binary detection) so the runtime and the compatibility tests share one source of truth, and eliminate the duplicate stream-json parser / binary detection in `process-manager.ts`.

**Spec:** `docs/superpowers/specs/2026-07-12-agent-protocol-compat-design.md` (this plan covers phases 1, 2, 3, 6 of the spec — the protocol layer + offline contract tests + version logging + PR CI. Phases 4–5, live probes + drift-watch CI, get a follow-up plan once this lands).

**Architecture:** Pure, stateless protocol modules per agent under `src/protocol/`. Providers keep all session state and domain translation (`ParsedAgentEvent`); they call into the protocol layer for framing, message construction, and CLI args. Zod schemas define the contract; runtime stays lenient by construction (defensive access, unknown types → warn), strict validation runs only in tests.

**Tech Stack:** TypeScript (NodeNext ESM), zod v4 (already a dependency), vitest v4 (already configured, 329 tests passing), pnpm monorepo.

## Global Constraints

- Backend is ESM with NodeNext resolution: **all local imports need `.js` extensions**.
- No new npm dependencies — zod `^4.3.6` and vitest `^4.0.18` are already in `packages/vibedeckx/package.json`.
- Test files are colocated: `foo.test.ts` next to `foo.ts` (existing convention). Run with `pnpm test` (= `vitest run`) inside `packages/vibedeckx/`.
- Typecheck command: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (run from repo root). Note: tsconfig excludes `*.test.ts` — tests are only checked by vitest's transform.
- **Behavioral equivalence is the bar for every refactor task**: the two existing provider test files (`src/providers/claude-code-provider.test.ts`, `src/providers/codex-provider.test.ts`) must pass **unchanged** — do not edit their assertions.
- All protocol builder functions that produce stdin payloads return strings **ending with `"\n"`** (newline-delimited protocols).
- Working directory for all commands below: `/var/tmp/vibedeckx/worktrees/vibedeckx-49e0cefb/dev1` unless a task says otherwise (test/typecheck commands that use `--filter` or `-p` paths run from repo root; bare `pnpm test` runs from `packages/vibedeckx/`).

---

### Task 1: Shared binary detection + version probe (`protocol/shared/binary.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/shared/binary.ts`
- Test: `packages/vibedeckx/src/protocol/shared/binary.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `detectBinary(name: string): string | null`, `getBinaryVersion(command: string): string | null`, `clearBinaryCaches(): void` — used by Tasks 4, 5, 7, 8, 9, 11.

- [ ] **Step 1: Write the failing test**

```ts
// packages/vibedeckx/src/protocol/shared/binary.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { clearBinaryCaches, detectBinary, getBinaryVersion } from "./binary.js";

describe("protocol/shared/binary", () => {
  beforeEach(() => clearBinaryCaches());

  it("finds a binary that exists on PATH", () => {
    // node is guaranteed present in the test environment
    const path = detectBinary("node");
    expect(path).toBeTruthy();
    expect(path).toContain("node");
  });

  it("returns null for a binary that does not exist", () => {
    expect(detectBinary("definitely-not-a-real-binary-x9z")).toBeNull();
  });

  it("caches results across calls", () => {
    const first = detectBinary("node");
    const second = detectBinary("node");
    expect(second).toBe(first);
  });

  it("probes a binary's --version output", () => {
    const version = getBinaryVersion(detectBinary("node")!);
    expect(version).toMatch(/^v\d+/);
  });

  it("returns null version for a broken command", () => {
    expect(getBinaryVersion("/nonexistent/binary")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/vibedeckx/`): `npx vitest run src/protocol/shared/binary.test.ts`
Expected: FAIL — "Failed to load ... binary.js" (module does not exist).

- [ ] **Step 3: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/shared/binary.ts
/**
 * Single implementation of CLI binary detection for all agent protocol
 * integrations. Replaces the three copies that previously lived in
 * claude-code-provider.ts, codex-provider.ts, and process-manager.ts.
 */
import { execFileSync } from "child_process";

const pathCache = new Map<string, string | null>();
const versionCache = new Map<string, string | null>();

/** Locate a binary on PATH via which/where. Returns absolute path or null. Cached. */
export function detectBinary(name: string): string | null {
  if (pathCache.has(name)) {
    return pathCache.get(name)!;
  }
  let found: string | null = null;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [name], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    found = result || null;
  } catch {
    found = null;
  }
  pathCache.set(name, found);
  console.log(
    found
      ? `[protocol] Native ${name} binary found: ${found}`
      : `[protocol] Native ${name} binary not found, will use npx`,
  );
  return found;
}

/**
 * Run `<command> --version` once and cache the trimmed output. Returns null
 * when the probe fails. Used to attribute protocol failures to an agent
 * version in session logs — never gates behavior.
 */
export function getBinaryVersion(command: string): string | null {
  if (versionCache.has(command)) {
    return versionCache.get(command)!;
  }
  let version: string | null = null;
  try {
    const result = execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    version = result || null;
  } catch {
    version = null;
  }
  versionCache.set(command, version);
  return version;
}

/** Test helper: reset module-level caches. */
export function clearBinaryCaches(): void {
  pathCache.clear();
  versionCache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/protocol/shared/binary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/shared/
git commit -m "feat(protocol): shared binary detection and version probe"
```

---

### Task 2: Codex protocol schemas (`protocol/codex/schema.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/codex/schema.ts`
- Create: `packages/vibedeckx/src/protocol/contracts.ts`
- Test: `packages/vibedeckx/src/protocol/codex/schema.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `ContractItem` (from `contracts.ts`); constants `CODEX_BINARY_NAME`, `CODEX_NPM_PACKAGE`, `CODEX_NOTIFICATIONS`, `CODEX_SERVER_REQUESTS`, `CODEX_CLIENT_METHODS`; schemas `SandboxModeSchema`, `AskForApprovalSchema`, `ThreadStartResultSchema`, `ItemCompletedParamsSchema`, `TurnCompletedParamsSchema`, `TokenUsageParamsSchema`, `CommandApprovalParamsSchema`, `FileChangeApprovalParamsSchema`, `UserInputParamsSchema`, `KnownThreadItemSchema`; registry `CODEX_CONTRACTS`. Used by Tasks 3, 5, 10.

- [ ] **Step 1: Write the contract-item type**

```ts
// packages/vibedeckx/src/protocol/contracts.ts
/**
 * A contract item ties a protocol schema to a stable ID and the code that
 * depends on it. Compat-test failures report the ID + consumers so a drift
 * report directly names the affected code.
 */
import type { z } from "zod";

export interface ContractItem {
  /** Stable ID, e.g. "CX-NOTIF-item_completed" or "CC-OUT-task_started". */
  id: string;
  schema: z.ZodType;
  /** Repo-relative pointers to the code that reads/writes this shape. */
  consumers: string[];
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/vibedeckx/src/protocol/codex/schema.test.ts
import { describe, expect, it } from "vitest";
import {
  AskForApprovalSchema,
  CODEX_CONTRACTS,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  SandboxModeSchema,
  ThreadStartResultSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
} from "./schema.js";

describe("protocol/codex schemas", () => {
  it("accepts a real commandExecution item/completed payload", () => {
    const params = {
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: '/bin/bash -lc "echo hi"',
        aggregatedOutput: "hi\n",
        status: "completed",
      },
    };
    expect(ItemCompletedParamsSchema.safeParse(params).success).toBe(true);
    expect(KnownThreadItemSchema.safeParse(params.item).success).toBe(true);
  });

  it("accepts a final agentMessage item", () => {
    const item = { type: "agentMessage", id: "msg-1", text: "Done.", phase: "final_answer" };
    expect(KnownThreadItemSchema.safeParse(item).success).toBe(true);
  });

  it("accepts a fileChange item with object kind", () => {
    const item = {
      type: "fileChange",
      id: "fc-1",
      changes: [{ path: "a.ts", diff: "+x", kind: { type: "edit" } }],
      status: "completed",
    };
    expect(KnownThreadItemSchema.safeParse(item).success).toBe(true);
  });

  it("tolerates unknown extra fields (loose objects)", () => {
    const params = {
      turn: { id: "turn-1", status: "completed", someNewField: 42 },
      anotherNewField: true,
    };
    expect(TurnCompletedParamsSchema.safeParse(params).success).toBe(true);
  });

  it("rejects a commandExecution item missing its command", () => {
    expect(KnownThreadItemSchema.safeParse({ type: "commandExecution", id: "x" }).success).toBe(false);
  });

  it("parses thread/start result and token usage", () => {
    expect(ThreadStartResultSchema.safeParse({ thread: { id: "t-1" } }).success).toBe(true);
    expect(
      TokenUsageParamsSchema.safeParse({ tokenUsage: { last: { inputTokens: 12, outputTokens: 34 } } }).success,
    ).toBe(true);
  });

  it("pins the enum values our thread/start params depend on", () => {
    expect(SandboxModeSchema.options).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(AskForApprovalSchema.options).toEqual(["untrusted", "on-failure", "on-request", "never"]);
  });

  it("every contract item has an ID and at least one consumer", () => {
    expect(CODEX_CONTRACTS.length).toBeGreaterThan(5);
    for (const c of CODEX_CONTRACTS) {
      expect(c.id).toMatch(/^CX-/);
      expect(c.consumers.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/protocol/codex/schema.test.ts`
Expected: FAIL — module `./schema.js` not found.

- [ ] **Step 4: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/codex/schema.ts
/**
 * Codex app-server protocol contract (JSON-RPC 2.0 over stdio, newline-
 * delimited). Single source of truth for every message shape and method
 * name vibedeckx depends on. Objects are loose (unknown fields pass) so the
 * runtime tolerates upstream additions; compat tests flag them as WARN.
 */
import { z } from "zod";
import type { ContractItem } from "../contracts.js";

export const CODEX_BINARY_NAME = "codex";
export const CODEX_NPM_PACKAGE = "@openai/codex";

// ---- Method names ----

export const CODEX_CLIENT_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  turnStart: "turn/start",
  cancelRequest: "$/cancelRequest",
} as const;

export const CODEX_NOTIFICATIONS = {
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed",
  tokenUsageUpdated: "thread/tokenUsage/updated",
} as const;

export const CODEX_SERVER_REQUESTS = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  userInput: "item/tool/requestUserInput",
} as const;

// ---- Enums used in thread/start params ----

export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export const AskForApprovalSchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type AskForApproval = z.infer<typeof AskForApprovalSchema>;

// ---- thread/start response ----

export const ThreadStartResultSchema = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
});

// ---- Thread items (item/completed) ----

const idish = z.union([z.string(), z.number()]);

export const AgentMessageItemSchema = z.looseObject({
  type: z.literal("agentMessage"),
  id: idish.optional(),
  text: z.string().optional(),
  phase: z.string().optional(),
});

export const ReasoningItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  summary: z.array(z.string()).optional(),
  content: z.array(z.string()).optional(),
});

export const UserMessageItemSchema = z.looseObject({
  type: z.literal("userMessage"),
});

export const CommandExecutionItemSchema = z.looseObject({
  type: z.literal("commandExecution"),
  id: idish.optional(),
  command: z.string(),
  aggregatedOutput: z.string().optional(),
  status: z.string().optional(),
});

export const FileChangeSchema = z.looseObject({
  path: z.string(),
  diff: z.string().optional(),
  kind: z.union([z.string(), z.looseObject({ type: z.string() })]).optional(),
});

export const FileChangeItemSchema = z.looseObject({
  type: z.literal("fileChange"),
  id: idish.optional(),
  changes: z.array(FileChangeSchema).optional(),
  status: z.string().optional(),
});

export const PlanItemSchema = z.looseObject({
  type: z.literal("plan"),
  text: z.string().optional(),
});

export const WebSearchItemSchema = z.looseObject({
  type: z.literal("webSearch"),
  id: idish.optional(),
  query: z.string().optional(),
});

export const McpToolCallItemSchema = z.looseObject({
  type: z.literal("mcpToolCall"),
  id: idish.optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

export const CollabAgentToolCallItemSchema = z.looseObject({
  type: z.literal("collabAgentToolCall"),
  id: idish.optional(),
  tool: z.string().optional(),
  prompt: z.string().optional(),
});

export const KnownThreadItemSchema = z.discriminatedUnion("type", [
  AgentMessageItemSchema,
  ReasoningItemSchema,
  UserMessageItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  PlanItemSchema,
  WebSearchItemSchema,
  McpToolCallItemSchema,
  CollabAgentToolCallItemSchema,
]);

// ---- Notification params ----

export const ItemCompletedParamsSchema = z.looseObject({
  turnId: idish.optional(),
  item: z.looseObject({ type: z.string() }),
});

export const TurnCompletedParamsSchema = z.looseObject({
  turn: z.looseObject({
    id: idish.optional(),
    status: z.string().optional(),
    error: z.looseObject({ message: z.string().optional() }).optional(),
  }),
});

export const TokenUsageParamsSchema = z.looseObject({
  tokenUsage: z.looseObject({
    last: z
      .looseObject({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .optional(),
  }),
});

// ---- Server request params (approvals) ----

export const CommandApprovalParamsSchema = z.looseObject({
  command: z.string().optional(),
  cwd: z.string().optional(),
});

export const FileChangeApprovalParamsSchema = z.looseObject({
  changes: z.array(FileChangeSchema).optional(),
});

export const UserInputParamsSchema = z.looseObject({
  questions: z.unknown().optional(),
});

// ---- Contract registry ----

export const CODEX_CONTRACTS: ContractItem[] = [
  { id: "CX-RESP-thread_start", schema: ThreadStartResultSchema, consumers: ["src/providers/codex-provider.ts parseStdoutLine"] },
  { id: "CX-NOTIF-item_completed", schema: ItemCompletedParamsSchema, consumers: ["src/providers/codex-provider.ts handleItemCompleted"] },
  { id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: ["src/providers/codex-provider.ts handleItemCompleted"] },
  { id: "CX-NOTIF-turn_completed", schema: TurnCompletedParamsSchema, consumers: ["src/providers/codex-provider.ts handleTurnCompleted"] },
  { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema, consumers: ["src/providers/codex-provider.ts handleTokenUsage"] },
  { id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest", "apps/vibedeckx-ui/components/agent/approval-request.tsx"] },
  { id: "CX-REQ-file_change_approval", schema: FileChangeApprovalParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest"] },
  { id: "CX-REQ-user_input", schema: UserInputParamsSchema, consumers: ["src/providers/codex-provider.ts handleServerRequest", "apps/vibedeckx-ui/components/agent/ask-user-question.tsx"] },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/protocol/codex/schema.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/
git commit -m "feat(protocol): codex app-server contract schemas"
```

---

### Task 3: Codex codec — framing and message builders (`protocol/codex/codec.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/codex/codec.ts`
- Test: `packages/vibedeckx/src/protocol/codex/codec.test.ts`

**Interfaces:**
- Consumes: `CODEX_CLIENT_METHODS`, `SandboxMode`, `AskForApproval` from Task 2; `ContentPart` from `../../agent-types.js`.
- Produces (used by Task 5):
  - `parseCodexLine(line: string): CodexIncoming` where `CodexIncoming = { kind: "error_response"; id: string | number; error: { code?: number; message?: string } } | { kind: "response"; id: string | number; result: unknown } | { kind: "server_request"; id: string | number; method: string; params: unknown } | { kind: "notification"; method: string; params: unknown } | { kind: "ignored"; raw: string }`
  - `buildInitialize(id: number): string`
  - `buildThreadStart(id: number, mode: "plan" | "edit"): string`
  - `threadStartParamsFor(mode: "plan" | "edit"): { sandbox: SandboxMode; approvalPolicy: AskForApproval }`
  - `buildTurnStart(id: number, threadId: string, content: string | ContentPart[]): string`
  - `buildCodexInput(content: string | ContentPart[]): unknown[]`
  - `buildCancelRequest(targetRequestId: number): string`
  - `buildApprovalResponse(requestId: string, decision: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/vibedeckx/src/protocol/codex/codec.test.ts
import { describe, expect, it } from "vitest";
import {
  buildApprovalResponse,
  buildCancelRequest,
  buildCodexInput,
  buildInitialize,
  buildThreadStart,
  buildTurnStart,
  parseCodexLine,
  threadStartParamsFor,
} from "./codec.js";

describe("parseCodexLine", () => {
  it("classifies an error response", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32600, message: "Not initialized" } });
    expect(parseCodexLine(line)).toEqual({
      kind: "error_response",
      id: 3,
      error: { code: -32600, message: "Not initialized" },
    });
  });

  it("classifies a success response", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "t-1" } } });
    expect(parseCodexLine(line)).toEqual({ kind: "response", id: 2, result: { thread: { id: "t-1" } } });
  });

  it("classifies a server request (id + method)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /tmp/x", cwd: "/tmp" },
    });
    expect(parseCodexLine(line)).toEqual({
      kind: "server_request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /tmp/x", cwd: "/tmp" },
    });
  });

  it("classifies a notification (method, no id)", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t" } } });
    expect(parseCodexLine(line)).toEqual({ kind: "notification", method: "turn/completed", params: { turn: { id: "t" } } });
  });

  it("returns ignored for non-JSON and unmatched shapes", () => {
    expect(parseCodexLine("not json").kind).toBe("ignored");
    expect(parseCodexLine(JSON.stringify({ jsonrpc: "2.0" })).kind).toBe("ignored");
  });
});

describe("codex message builders", () => {
  it("builds initialize with our client identity", () => {
    expect(JSON.parse(buildInitialize(1))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } },
    });
    expect(buildInitialize(1).endsWith("\n")).toBe(true);
  });

  it("maps permission modes to sandbox/approvalPolicy", () => {
    expect(threadStartParamsFor("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
    expect(threadStartParamsFor("edit")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(JSON.parse(buildThreadStart(2, "edit"))).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: { sandbox: "danger-full-access", approvalPolicy: "never" },
    });
  });

  it("builds turn/start with text and image input", () => {
    expect(JSON.parse(buildTurnStart(3, "t-1", "hello"))).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: { threadId: "t-1", input: [{ type: "text", text: "hello" }] },
    });
    expect(
      buildCodexInput([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ]),
    ).toEqual([
      { type: "text", text: "look" },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("builds $/cancelRequest and approval replies", () => {
    expect(JSON.parse(buildCancelRequest(5))).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 5 },
    });
    expect(JSON.parse(buildApprovalResponse("7", "accept"))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { decision: "accept" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/protocol/codex/codec.test.ts`
Expected: FAIL — module `./codec.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/codex/codec.ts
/**
 * Stateless framing + message construction for the Codex app-server JSON-RPC
 * protocol. All session state (rpc id counters, pending-request maps,
 * threadId) stays in CodexProvider — this module only knows shapes.
 */
import type { ContentPart } from "../../agent-types.js";
import { CODEX_CLIENT_METHODS, type AskForApproval, type SandboxMode } from "./schema.js";

export type CodexIncoming =
  | { kind: "error_response"; id: string | number; error: { code?: number; message?: string } }
  | { kind: "response"; id: string | number; result: unknown }
  | { kind: "server_request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "ignored"; raw: string };

export function parseCodexLine(line: string): CodexIncoming {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "ignored", raw: line };
  }
  const id = msg.id as string | number | null | undefined;
  const method = msg.method as string | undefined;
  if (id != null && !method && msg.error !== undefined) {
    return { kind: "error_response", id, error: (msg.error ?? {}) as { code?: number; message?: string } };
  }
  if (id != null && !method && msg.result !== undefined) {
    return { kind: "response", id, result: msg.result };
  }
  if (id != null && method) {
    return { kind: "server_request", id, method, params: msg.params };
  }
  if (method) {
    return { kind: "notification", method, params: msg.params };
  }
  return { kind: "ignored", raw: line };
}

// ---- Outbound builders (all newline-terminated) ----

function rpcLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
}

export function buildInitialize(id: number): string {
  return rpcLine({
    id,
    method: CODEX_CLIENT_METHODS.initialize,
    params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } },
  });
}

/**
 * Permission-mode mapping. We always set `approvalPolicy: "never"` so Codex
 * runs autonomously without emitting approval prompts — the equivalent of
 * Claude Code's --dangerously-skip-permissions. Edit mode uses
 * danger-full-access: with a confined sandbox + "never", any command that
 * needs to escape the sandbox is auto-denied and silently fails instead of
 * prompting (and on hosts where the Linux sandbox can't initialize, every
 * command would fail).
 */
export function threadStartParamsFor(mode: "plan" | "edit"): { sandbox: SandboxMode; approvalPolicy: AskForApproval } {
  if (mode === "plan") {
    return { sandbox: "read-only", approvalPolicy: "never" };
  }
  return { sandbox: "danger-full-access", approvalPolicy: "never" };
}

export function buildThreadStart(id: number, mode: "plan" | "edit"): string {
  return rpcLine({ id, method: CODEX_CLIENT_METHODS.threadStart, params: threadStartParamsFor(mode) });
}

export function buildCodexInput(content: string | ContentPart[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return { type: "image", url: `data:${part.mediaType};base64,${part.data}` };
  });
}

export function buildTurnStart(id: number, threadId: string, content: string | ContentPart[]): string {
  return rpcLine({
    id,
    method: CODEX_CLIENT_METHODS.turnStart,
    params: { threadId, input: buildCodexInput(content) },
  });
}

export function buildCancelRequest(targetRequestId: number): string {
  return rpcLine({ method: CODEX_CLIENT_METHODS.cancelRequest, params: { id: targetRequestId } });
}

export function buildApprovalResponse(requestId: string, decision: string): string {
  return rpcLine({ id: Number(requestId), result: { decision } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/protocol/codex/codec.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/codex/
git commit -m "feat(protocol): codex JSON-RPC codec and message builders"
```

---

### Task 4: Codex CLI arg builders (`protocol/codex/cli.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/codex/cli.ts`
- Test: `packages/vibedeckx/src/protocol/codex/cli.test.ts`

**Interfaces:**
- Consumes: `SpawnConfig` type from `../../agent-provider.js`; `CODEX_NPM_PACKAGE` from Task 2.
- Produces (used by Tasks 5 and 9):
  - `buildCodexAppServerSpawnConfig(nativeBinary: string | null): SpawnConfig`
  - `buildCodexExecCommand(nativeBinary: string | null, prompt: string, outputLastMessageFile?: string): string`

**Equivalence requirement:** the exec command string must be byte-identical to what `process-manager.ts` `buildPromptCommand()` produces today (see `packages/vibedeckx/src/process-manager.ts:114-126`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/vibedeckx/src/protocol/codex/cli.test.ts
import { describe, expect, it } from "vitest";
import { buildCodexAppServerSpawnConfig, buildCodexExecCommand } from "./cli.js";

describe("codex CLI builders", () => {
  it("builds app-server spawn config for a native binary", () => {
    expect(buildCodexAppServerSpawnConfig("/usr/local/bin/codex")).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server"],
      shell: false,
    });
  });

  it("falls back to npx for app-server", () => {
    expect(buildCodexAppServerSpawnConfig(null)).toEqual({
      command: "npx",
      args: ["-y", "@openai/codex", "app-server"],
      shell: false,
    });
  });

  it("builds the exec command exactly as process-manager did (native)", () => {
    expect(buildCodexExecCommand("/usr/local/bin/codex", "do the thing", "/tmp/last.txt")).toBe(
      `/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox exec 'do the thing' --output-last-message '/tmp/last.txt'`,
    );
  });

  it("builds the exec command exactly as process-manager did (npx, no result file)", () => {
    expect(buildCodexExecCommand(null, "hello")).toBe(
      `npx -y @openai/codex --dangerously-bypass-approvals-and-sandbox exec 'hello'`,
    );
  });

  it("escapes single quotes in the prompt", () => {
    expect(buildCodexExecCommand("/bin/codex", "it's fine")).toBe(
      `/bin/codex --dangerously-bypass-approvals-and-sandbox exec 'it'\\''s fine'`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/protocol/codex/cli.test.ts`
Expected: FAIL — module `./cli.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/codex/cli.ts
/**
 * CLI invocation contract for the codex binary: the exact flags vibedeckx
 * passes in app-server (interactive session) and exec (one-shot prompt
 * executor) modes.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import { CODEX_NPM_PACKAGE } from "./schema.js";

export function buildCodexAppServerSpawnConfig(nativeBinary: string | null): SpawnConfig {
  if (nativeBinary) {
    return { command: nativeBinary, args: ["app-server"], shell: false };
  }
  return { command: "npx", args: ["-y", CODEX_NPM_PACKAGE, "app-server"], shell: false };
}

/**
 * One-shot prompt executor command (run under a shell/PTY by process-manager).
 * --output-last-message makes codex write the agent's final message to a
 * file, read back on exit as the run's structured report.
 */
export function buildCodexExecCommand(
  nativeBinary: string | null,
  prompt: string,
  outputLastMessageFile?: string,
): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const lastMessageArg = outputLastMessageFile ? ` --output-last-message '${outputLastMessageFile}'` : "";
  const base = nativeBinary ?? `npx -y ${CODEX_NPM_PACKAGE}`;
  return `${base} --dangerously-bypass-approvals-and-sandbox exec '${escapedPrompt}'${lastMessageArg}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/protocol/codex/cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/codex/
git commit -m "feat(protocol): codex CLI invocation builders"
```

---

### Task 5: Refactor CodexProvider onto the protocol layer

**Files:**
- Modify: `packages/vibedeckx/src/providers/codex-provider.ts`
- Test (existing, must pass **unchanged**): `packages/vibedeckx/src/providers/codex-provider.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4 (`detectBinary`, codec builders, `parseCodexLine`, `buildCodexAppServerSpawnConfig`, method-name constants).
- Produces: `CodexProvider` public behavior — unchanged. All session state (`CodexSessionState`, `pendingRequests`, `rpcIdCounter`, `threadId`, buffering) stays in the provider.

- [ ] **Step 1: Run the existing tests to confirm the green baseline**

Run: `npx vitest run src/providers/codex-provider.test.ts`
Expected: PASS (5 tests). This is the regression gate for this task.

- [ ] **Step 2: Apply the refactor**

In `packages/vibedeckx/src/providers/codex-provider.ts`:

**2a.** Replace the imports at the top of the file:

```ts
import type { AgentType, ContentPart } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";
import type { CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { detectBinary } from "../protocol/shared/binary.js";
import {
  buildApprovalResponse,
  buildCancelRequest,
  buildInitialize,
  buildThreadStart,
  buildTurnStart,
  parseCodexLine,
} from "../protocol/codex/codec.js";
import { buildCodexAppServerSpawnConfig } from "../protocol/codex/cli.js";
import { CODEX_BINARY_NAME, CODEX_CLIENT_METHODS, CODEX_NOTIFICATIONS, CODEX_SERVER_REQUESTS } from "../protocol/codex/schema.js";
```

(The `execFileSync` import from `child_process` is removed.)

**2b.** Replace the `detectBinary()` method body (keep the method — routes/UI call it via the provider interface):

```ts
  detectBinary(): string | null {
    return detectBinary(CODEX_BINARY_NAME);
  }
```

Also delete the now-unused `private binaryPath` field.

**2c.** Replace `buildSpawnConfig()`:

```ts
  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit", _crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
    // Store permissionMode for use in formatUserInput's turn/start params
    this.lastPermissionMode = permissionMode;
    return buildCodexAppServerSpawnConfig(this.detectBinary());
  }
```

**2d.** Replace `parseStdoutLine()` — the framing moves to `parseCodexLine`; the per-kind handling keeps its existing behavior:

```ts
  parseStdoutLine(line: string, sessionId: string): ParsedAgentEvent[] {
    const incoming = parseCodexLine(line);
    const state = this.getSessionState(sessionId);

    switch (incoming.kind) {
      case "error_response": {
        // Every request we send (initialize / thread/start / turn/start) is
        // turn-fatal on failure, so surface it as an error result.
        const reqMethod = state.pendingRequests.get(Number(incoming.id));
        state.pendingRequests.delete(Number(incoming.id));
        console.error(
          `[CodexProvider] JSON-RPC error response for ${reqMethod ?? "unknown request"} (id=${incoming.id}, session=${sessionId}): ${JSON.stringify(incoming.error)}`,
        );
        if (reqMethod === CODEX_CLIENT_METHODS.threadStart) {
          // The buffered first turn can never be flushed without a threadId
          state.pendingTurnContent = null;
        }
        const errText = typeof incoming.error?.message === "string" ? incoming.error.message : JSON.stringify(incoming.error);
        return [{
          type: "result",
          subtype: "error",
          error: `Codex ${reqMethod ?? "request"} failed: ${errText}`,
        }];
      }

      case "response": {
        const reqMethod = state.pendingRequests.get(Number(incoming.id));
        state.pendingRequests.delete(Number(incoming.id));
        const result = incoming.result as { thread?: { id?: string } } | undefined;
        if (reqMethod === CODEX_CLIENT_METHODS.threadStart && result?.thread?.id) {
          state.threadId = result.thread.id;
          // Send buffered first turn now that we have threadId
          if (state.pendingTurnContent !== null) {
            const content = state.pendingTurnContent;
            state.pendingTurnContent = null;
            const id = state.rpcIdCounter++;
            state.pendingRequests.set(id, CODEX_CLIENT_METHODS.turnStart);
            return [{ type: "stdin_write", content: buildTurnStart(id, state.threadId, content) }];
          }
        }
        return [];
      }

      case "server_request":
        return this.handleServerRequest(incoming.id, incoming.method, incoming.params);

      case "notification":
        return this.handleNotification(incoming.method, incoming.params, sessionId);

      case "ignored":
        return [];
    }
  }
```

**2e.** Adjust `handleNotification` and `handleServerRequest` signatures to the destructured form, using the method-name constants (bodies of `handleItemCompleted`, `handleTurnCompleted`, `handleTokenUsage` are **unchanged**):

```ts
  private handleNotification(method: string, params: any, sessionId: string): ParsedAgentEvent[] {
    switch (method) {
      case CODEX_NOTIFICATIONS.itemCompleted:
        return this.handleItemCompleted(params, sessionId);
      case CODEX_NOTIFICATIONS.turnCompleted:
        return this.handleTurnCompleted(params, sessionId);
      case CODEX_NOTIFICATIONS.tokenUsageUpdated:
        return this.handleTokenUsage(params, sessionId);
      default:
        return [];
    }
  }

  private handleServerRequest(id: string | number, method: string, params: any): ParsedAgentEvent[] {
    switch (method) {
      case CODEX_SERVER_REQUESTS.commandApproval:
        return [{
          type: "approval_request",
          requestType: "command",
          requestId: String(id),
          command: params?.command ?? "",
          cwd: params?.cwd,
        }];

      case CODEX_SERVER_REQUESTS.fileChangeApproval:
        return [{
          type: "approval_request",
          requestType: "fileChange",
          requestId: String(id),
          changes: params?.changes ?? [],
        }];

      case CODEX_SERVER_REQUESTS.userInput:
        return [{
          type: "tool_use",
          tool: "AskUserQuestion",
          input: { questions: params?.questions },
          toolUseId: String(id),
        }];

      default:
        return [];
    }
  }
```

**2f.** Replace the inline `JSON.stringify` message construction in `getInitializationMessages()` and `formatUserInput()` with the builders (state bookkeeping unchanged):

```ts
  getInitializationMessages(sessionId: string): string | null {
    const state = this.getSessionState(sessionId);
    if (state.initialized) return null;

    const id1 = state.rpcIdCounter++;
    const id2 = state.rpcIdCounter++;
    state.pendingRequests.set(id1, CODEX_CLIENT_METHODS.initialize);
    state.pendingRequests.set(id2, CODEX_CLIENT_METHODS.threadStart);
    state.initialized = true;

    return buildInitialize(id1) + buildThreadStart(id2, state.permissionMode);
  }

  formatUserInput(content: string | ContentPart[], sessionId: string): string {
    const state = this.getSessionState(sessionId);
    // Sync permissionMode from last buildSpawnConfig call
    state.permissionMode = this.lastPermissionMode;

    // Fast path: threadId already available (pre-initialization completed)
    if (state.threadId) {
      const id = state.rpcIdCounter++;
      state.pendingRequests.set(id, CODEX_CLIENT_METHODS.turnStart);
      return buildTurnStart(id, state.threadId, content);
    }

    // Edge case: getInitializationMessages wasn't called (e.g. dormant session wake)
    if (!state.initialized) {
      const id1 = state.rpcIdCounter++;
      const id2 = state.rpcIdCounter++;
      state.pendingRequests.set(id1, CODEX_CLIENT_METHODS.initialize);
      state.pendingRequests.set(id2, CODEX_CLIENT_METHODS.threadStart);
      state.initialized = true;
      state.pendingTurnContent = content;
      return buildInitialize(id1) + buildThreadStart(id2, state.permissionMode);
    }

    // Initialized but threadId not yet available (race: user sent message before thread/start responded)
    // Buffer content — will be sent when parseStdoutLine receives thread/start response
    if (state.pendingTurnContent !== null) {
      console.warn(
        `[CodexProvider] formatUserInput: overwriting previously buffered turn content for session ${sessionId} — thread/start response still missing`,
      );
    } else {
      console.warn(
        `[CodexProvider] formatUserInput: no threadId yet for session ${sessionId} — buffering turn content until thread/start responds`,
      );
    }
    state.pendingTurnContent = content;
    return "";
  }
```

Note the newline join change in `getInitializationMessages`: the old code did `[msg1, msg2].join("\n") + "\n"`; the builders each end with `"\n"`, so simple concatenation produces the identical byte sequence.

**2g.** Replace `formatApprovalResponse()` and `formatInterrupt()` bodies:

```ts
  formatApprovalResponse(requestId: string, decision: string, _sessionId: string): string {
    return buildApprovalResponse(requestId, decision);
  }

  formatInterrupt(sessionId: string): string | null {
    const state = this.getSessionState(sessionId);
    for (const [id, method] of state.pendingRequests) {
      if (method === CODEX_CLIENT_METHODS.turnStart) {
        return buildCancelRequest(id);
      }
    }
    return null;
  }
```

**2h.** Delete the now-dead private members: `buildThreadStartParams()` (moved to codec as `threadStartParamsFor` with its doc comment) and `buildCodexInput()` (moved to codec). Keep `generateId()`, `getSessionState()`, `onSessionCreated()`, `onSessionDestroyed()`, and the three `handleItemCompleted`/`handleTurnCompleted`/`handleTokenUsage` methods exactly as they are.

- [ ] **Step 3: Run the full suite to verify equivalence**

Run: `pnpm test` (from `packages/vibedeckx/`)
Expected: PASS — all pre-existing tests including `codex-provider.test.ts` (5 tests, unmodified) plus the new protocol tests.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/providers/codex-provider.ts
git commit -m "refactor(codex): move protocol framing/builders into protocol layer"
```

---

### Task 6: Claude Code protocol schemas (`protocol/claude-code/schema.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/claude-code/schema.ts`
- Modify: `packages/vibedeckx/src/agent-types.ts` (replace hand-written `Claude*` interfaces with re-exports)
- Test: `packages/vibedeckx/src/protocol/claude-code/schema.test.ts`

**Interfaces:**
- Consumes: `zod`, `ContractItem`.
- Produces (used by Tasks 7, 8, 9, 10): constants `CLAUDE_BINARY_NAME`, `CLAUDE_NPM_PACKAGE`, `TASK_STARTED_SUBTYPE`, `TASK_NOTIFICATION_SUBTYPE`, `TASK_UPDATED_SUBTYPE`, `TERMINAL_TASK_STATUSES`, `FRONTEND_RENDERED_TOOLS`; schemas `ClaudeContentBlockSchema`, `ClaudeAssistantMessageSchema`, `ClaudeUserMessageSchema`, `ClaudeSystemMessageSchema`, `ClaudeResultMessageSchema`; TS types `ClaudeOutputMessage`, `ClaudeContentBlock`, `ClaudeAssistantMessage`, `ClaudeUserMessage`, `ClaudeSystemMessage`, `ClaudeResultMessage`, `ClaudeUnknownMessage`, `ClaudeImageBlock`, `ClaudeUserInput` (same names as today's `agent-types.ts` exports); registry `CLAUDE_CONTRACTS`.

- [ ] **Step 1: Write the failing test**

Real fixture lines below are copied from `src/providers/claude-code-provider.test.ts` (captured from Claude Code 2.1.198 with `--output-format stream-json --verbose`).

```ts
// packages/vibedeckx/src/protocol/claude-code/schema.test.ts
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CONTRACTS,
  ClaudeAssistantMessageSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
  FRONTEND_RENDERED_TOOLS,
  TERMINAL_TASK_STATUSES,
} from "./schema.js";

describe("protocol/claude-code schemas", () => {
  it("accepts a real captured task_started system message", () => {
    const msg = {
      type: "system",
      subtype: "task_started",
      task_id: "aa462d9841ec77a13",
      tool_use_id: "toolu_01M21wx2oyVzZSY4M3HWrHAv",
      description: "Sleep 15 then reply DONE",
      subagent_type: "claude",
      task_type: "local_agent",
      prompt: "Run the bash command 'sleep 15' and then reply with the single word DONE.",
      uuid: "85005f62-c256-416a-8ac9-927cf1e1afce",
      session_id: "c80619f4-511a-4dba-9a4d-4c1d499c40af",
    };
    const parsed = ClaudeSystemMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it("accepts an assistant message with text, tool_use, and thinking blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "Running it." },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo hi" } },
        ],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
      },
      session_id: "s-1",
    };
    expect(ClaudeAssistantMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an assistant message whose content is not an array", () => {
    const msg = { type: "assistant", message: { content: "oops" } };
    expect(ClaudeAssistantMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("accepts success and error result messages", () => {
    expect(
      ClaudeResultMessageSchema.safeParse({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        cost_usd: 0.003,
        result: "Done.",
        session_id: "s-1",
      }).success,
    ).toBe(true);
    expect(
      ClaudeResultMessageSchema.safeParse({ type: "result", subtype: "error", error: "boom" }).success,
    ).toBe(true);
  });

  it("pins the terminal task statuses the ledger clears on", () => {
    expect(TERMINAL_TASK_STATUSES).toEqual(["completed", "failed", "cancelled", "canceled", "killed", "error"]);
  });

  it("lists the tool names the frontend special-cases", () => {
    // Mirror of the switch in apps/vibedeckx-ui/components/agent/agent-message.tsx.
    // If you change one side, change the other.
    for (const tool of ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "TodoWrite", "ExitPlanMode", "AskUserQuestion", "Task", "WebFetch", "WebSearch", "Skill"]) {
      expect(FRONTEND_RENDERED_TOOLS).toContain(tool);
    }
  });

  it("every contract item has an ID and at least one consumer", () => {
    expect(CLAUDE_CONTRACTS.length).toBeGreaterThan(3);
    for (const c of CLAUDE_CONTRACTS) {
      expect(c.id).toMatch(/^CC-/);
      expect(c.consumers.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/protocol/claude-code/schema.test.ts`
Expected: FAIL — module `./schema.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/claude-code/schema.ts
/**
 * Claude Code stream-json protocol contract. Single source of truth for the
 * stdout message shapes, stdin input format, system-event subtypes, and tool
 * names vibedeckx depends on. Objects are loose (unknown fields pass) so the
 * runtime tolerates upstream additions; compat tests flag them as WARN.
 */
import { z } from "zod";
import type { ContractItem } from "../contracts.js";

export const CLAUDE_BINARY_NAME = "claude";
export const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

// ---- Background-task lifecycle (system subtypes; require --verbose) ----
// task_started fires when the agent launches background work (task_type
// "local_agent" for background subagents, "local_bash" for background
// commands); task_notification fires when it finishes — right before the
// harness auto-resumes the main agent. task_updated with a terminal
// patch.status is a redundant clear channel. These feed the session
// manager's pending-background-task ledger.

export const TASK_STARTED_SUBTYPE = "task_started";
export const TASK_NOTIFICATION_SUBTYPE = "task_notification";
export const TASK_UPDATED_SUBTYPE = "task_updated";
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "canceled", "killed", "error"] as const;

/**
 * Tool names the frontend renders with dedicated UIs
 * (apps/vibedeckx-ui/components/agent/agent-message.tsx). A rename upstream
 * degrades those tools to the generic JSON renderer — the live compat probes
 * assert emitted tool names stay within this list.
 */
export const FRONTEND_RENDERED_TOOLS = [
  "AskUserQuestion",
  "ExitPlanMode",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "TaskOutput",
  "WebFetch",
  "WebSearch",
  "Skill",
  "FileChange",
] as const;

// ---- Content blocks ----

export const ClaudeContentBlockSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.looseObject({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.unknown() }),
  z.looseObject({ type: z.literal("thinking"), thinking: z.string() }),
]);

// ---- Stdout messages ----

export const ClaudeAssistantMessageSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string() })),
  }),
  session_id: z.string().optional(),
});

export const ClaudeUserMessageSchema = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.unknown(),
  }),
  session_id: z.string().optional(),
});

export const ClaudeSystemMessageSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.string().optional(),
  message: z.string().optional(),
  task_id: z.string().optional(),
  task_type: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  patch: z.looseObject({ status: z.string().optional() }).optional(),
  session_id: z.string().optional(),
});

export const ClaudeResultMessageSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string().optional(),
  error: z.string().optional(),
  result: z.string().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  session_id: z.string().optional(),
});

// ---- Inferred TS types (keep the historical names from agent-types.ts) ----

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown }
  | { type: "thinking"; thinking: string };

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  session_id: string;
}

export interface ClaudeUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ClaudeContentBlock[];
  };
  session_id: string;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  message?: string;
  session_id?: string;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  duration_ms?: number;
  duration_api_ms?: number;
  cost_usd?: number;
  session_id?: string;
  error?: string;
}

export interface ClaudeUnknownMessage {
  type: string;
  [key: string]: unknown;
}

export type ClaudeOutputMessage =
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeSystemMessage
  | ClaudeResultMessage
  | ClaudeUnknownMessage;

export type ClaudeImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeUserInput {
  type: "user";
  message: {
    role: "user";
    content: string | (ClaudeContentBlock | ClaudeImageBlock)[];
  };
}

// ---- Contract registry ----

export const CLAUDE_CONTRACTS: ContractItem[] = [
  { id: "CC-OUT-assistant", schema: ClaudeAssistantMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/process-manager.ts startClaudeStreamProcess"] },
  { id: "CC-OUT-system", schema: ClaudeSystemMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/agent-session-manager.ts background-task ledger"] },
  { id: "CC-OUT-result", schema: ClaudeResultMessageSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "src/process-manager.ts startClaudeStreamProcess"] },
  { id: "CC-OUT-content_blocks", schema: ClaudeContentBlockSchema, consumers: ["src/providers/claude-code-provider.ts parseStdoutLine", "apps/vibedeckx-ui/components/agent/agent-message.tsx"] },
];
```

- [ ] **Step 4: Re-point `agent-types.ts` at the protocol layer**

In `packages/vibedeckx/src/agent-types.ts`, delete everything from the comment `// ============ Claude Code JSON Protocol Types ============` down to (and including) the `ClaudeUserInput` interface (the current lines 29–102), and replace with:

```ts
// ============ Claude Code JSON Protocol Types ============
// Moved to the protocol layer; re-exported here so existing imports keep working.
export type {
  ClaudeOutputMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeSystemMessage,
  ClaudeResultMessage,
  ClaudeUnknownMessage,
  ClaudeContentBlock,
  ClaudeImageBlock,
  ClaudeUserInput,
} from "./protocol/claude-code/schema.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test` and `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: all tests PASS (including the new 7), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vibedeckx/src/protocol/claude-code/ packages/vibedeckx/src/agent-types.ts
git commit -m "feat(protocol): claude-code stream-json contract schemas"
```

---

### Task 7: Claude Code codec + CLI builders (`protocol/claude-code/codec.ts`, `cli.ts`)

**Files:**
- Create: `packages/vibedeckx/src/protocol/claude-code/codec.ts`
- Create: `packages/vibedeckx/src/protocol/claude-code/cli.ts`
- Test: `packages/vibedeckx/src/protocol/claude-code/codec.test.ts`
- Test: `packages/vibedeckx/src/protocol/claude-code/cli.test.ts`

**Interfaces:**
- Consumes: types/constants from Task 6; `ContentPart` from `../../agent-types.js`; `SpawnConfig` from `../../agent-provider.js`.
- Produces (used by Tasks 8 and 9):
  - `parseClaudeLine(line: string): ClaudeOutputMessage | null` (null = not JSON)
  - `serializeUserInput(content: string | ContentPart[]): string`
  - `buildClaudeSessionSpawnConfig(nativeBinary: string | null, permissionMode: "plan" | "edit", mcpConfigArg?: string): SpawnConfig`
  - `buildClaudeStreamExecutorSpawn(nativeBinary: string | null): { command: string; args: string[] }`
  - `buildClaudePrintCommand(nativeBinary: string | null, prompt: string): string`

**Equivalence requirements:** spawn args must match today's `claude-code-provider.ts` `buildSpawnConfig()` exactly (order included); the stream-executor args must match `process-manager.ts:570-578`; the print command must match `process-manager.ts:128-133`.

- [ ] **Step 1: Write the failing codec test**

```ts
// packages/vibedeckx/src/protocol/claude-code/codec.test.ts
import { describe, expect, it } from "vitest";
import { parseClaudeLine, serializeUserInput } from "./codec.js";

describe("parseClaudeLine", () => {
  it("parses a JSON line into a typed message", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", duration_ms: 5 });
    expect(parseClaudeLine(line)).toEqual({ type: "result", subtype: "success", duration_ms: 5 });
  });

  it("returns null for non-JSON lines", () => {
    expect(parseClaudeLine("plain text progress line")).toBeNull();
  });
});

describe("serializeUserInput", () => {
  it("wraps a plain string in the stream-json user envelope", () => {
    expect(serializeUserInput("hello")).toBe(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n",
    );
  });

  it("maps ContentPart[] to text and base64 image blocks", () => {
    const out = serializeUserInput([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
    expect(JSON.parse(out)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    });
    expect(out.endsWith("\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing cli test**

```ts
// packages/vibedeckx/src/protocol/claude-code/cli.test.ts
import { describe, expect, it } from "vitest";
import {
  buildClaudePrintCommand,
  buildClaudeSessionSpawnConfig,
  buildClaudeStreamExecutorSpawn,
} from "./cli.js";

describe("claude CLI builders", () => {
  it("builds session args for edit mode (native)", () => {
    expect(buildClaudeSessionSpawnConfig("/usr/local/bin/claude", "edit")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--disallowedTools",
        "AskUserQuestion",
        "--verbose",
      ],
    });
  });

  it("builds session args for plan mode with mcp-config (npx)", () => {
    const config = buildClaudeSessionSpawnConfig(null, "plan", '{"mcpServers":{}}');
    expect(config.command).toBe("npx");
    expect(config.args).toEqual([
      "-y",
      "@anthropic-ai/claude-code",
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--permission-mode=plan",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });

  it("builds the one-shot stream executor spawn exactly as process-manager did", () => {
    expect(buildClaudeStreamExecutorSpawn("/usr/local/bin/claude")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--verbose",
      ],
    });
    expect(buildClaudeStreamExecutorSpawn(null)).toEqual({
      command: "npx",
      args: [
        "-y",
        "@anthropic-ai/claude-code",
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--verbose",
      ],
    });
  });

  it("builds the -p print command exactly as process-manager did", () => {
    expect(buildClaudePrintCommand("/usr/local/bin/claude", "it's a prompt")).toBe(
      `/usr/local/bin/claude -p 'it'\\''s a prompt' --dangerously-skip-permissions --verbose`,
    );
    expect(buildClaudePrintCommand(null, "hi")).toBe(
      `npx -y @anthropic-ai/claude-code -p 'hi' --dangerously-skip-permissions --verbose`,
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/protocol/claude-code/`
Expected: FAIL — `./codec.js` and `./cli.js` not found (schema tests from Task 6 still pass).

- [ ] **Step 4: Write the codec implementation**

```ts
// packages/vibedeckx/src/protocol/claude-code/codec.ts
/**
 * Stateless parse/serialize for the Claude Code stream-json protocol.
 */
import type { ContentPart } from "../../agent-types.js";
import type { ClaudeOutputMessage } from "./schema.js";

/** Parse one stdout line. Returns null when the line is not JSON. */
export function parseClaudeLine(line: string): ClaudeOutputMessage | null {
  try {
    return JSON.parse(line) as ClaudeOutputMessage;
  } catch {
    return null;
  }
}

/** Serialize user input into the stdin stream-json user envelope. */
export function serializeUserInput(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  }
  const blocks = content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } };
  });
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
}
```

- [ ] **Step 5: Write the cli implementation**

```ts
// packages/vibedeckx/src/protocol/claude-code/cli.ts
/**
 * CLI invocation contract for the claude binary: interactive session mode,
 * one-shot stream-json executor mode, and -p print mode.
 */
import type { SpawnConfig } from "../../agent-provider.js";
import { CLAUDE_NPM_PACKAGE } from "./schema.js";

const STREAM_JSON_ARGS = ["--output-format=stream-json", "--input-format=stream-json"] as const;

function withNpxFallback(nativeBinary: string | null, args: string[]): SpawnConfig {
  if (nativeBinary) {
    return { command: nativeBinary, args };
  }
  return { command: "npx", args: ["-y", CLAUDE_NPM_PACKAGE, ...args] };
}

/** Interactive agent session (agent-session-manager). */
export function buildClaudeSessionSpawnConfig(
  nativeBinary: string | null,
  permissionMode: "plan" | "edit",
  mcpConfigArg?: string,
): SpawnConfig {
  const permissionFlag = permissionMode === "plan"
    ? "--permission-mode=plan"
    : "--dangerously-skip-permissions";

  const args = [
    ...STREAM_JSON_ARGS,
    permissionFlag,
    // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
    // internally as "dismissed" before we can present a picker and wait for the
    // user. Disable it so the agent falls back to asking in plain text, which the
    // user answers through the normal conversation input.
    "--disallowedTools",
    "AskUserQuestion",
    "--verbose",
  ];

  if (mcpConfigArg) {
    args.push("--mcp-config", mcpConfigArg);
  }

  return withNpxFallback(nativeBinary, args);
}

/** One-shot prompt executor in stream-json mode (process-manager). */
export function buildClaudeStreamExecutorSpawn(nativeBinary: string | null): SpawnConfig {
  return withNpxFallback(nativeBinary, [...STREAM_JSON_ARGS, "--dangerously-skip-permissions", "--verbose"]);
}

/** One-shot -p print-mode shell command (process-manager PTY path). */
export function buildClaudePrintCommand(nativeBinary: string | null, prompt: string): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const base = nativeBinary ?? `npx -y ${CLAUDE_NPM_PACKAGE}`;
  return `${base} -p '${escapedPrompt}' --dangerously-skip-permissions --verbose`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/protocol/claude-code/`
Expected: PASS (codec 4 + cli 4 + schema 7 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/claude-code/
git commit -m "feat(protocol): claude-code codec and CLI invocation builders"
```

---

### Task 8: Refactor ClaudeCodeProvider onto the protocol layer

**Files:**
- Modify: `packages/vibedeckx/src/providers/claude-code-provider.ts`
- Test (existing, must pass **unchanged**): `packages/vibedeckx/src/providers/claude-code-provider.test.ts`

**Interfaces:**
- Consumes: `detectBinary` (Task 1), `parseClaudeLine`/`serializeUserInput` (Task 7), `buildClaudeSessionSpawnConfig` (Task 7), subtype/status constants (Task 6), `buildMcpConfigArg` (existing).
- Produces: `ClaudeCodeProvider` public behavior — unchanged.

- [ ] **Step 1: Confirm the green baseline**

Run: `npx vitest run src/providers/claude-code-provider.test.ts`
Expected: PASS (11 tests). Regression gate — do not modify this file.

- [ ] **Step 2: Apply the refactor**

**2a.** Replace the imports:

```ts
import type { AgentType, ContentPart } from "../agent-types.js";
import type { ClaudeOutputMessage, ClaudeContentBlock } from "../agent-types.js";
import type { AgentProvider, SpawnConfig, ParsedAgentEvent } from "../agent-provider.js";
import { buildMcpConfigArg, type CrossRemoteMcpConfig } from "../cross-remote-mcp-config.js";
import { detectBinary } from "../protocol/shared/binary.js";
import { parseClaudeLine, serializeUserInput } from "../protocol/claude-code/codec.js";
import { buildClaudeSessionSpawnConfig } from "../protocol/claude-code/cli.js";
import {
  CLAUDE_BINARY_NAME,
  TASK_NOTIFICATION_SUBTYPE,
  TASK_STARTED_SUBTYPE,
  TASK_UPDATED_SUBTYPE,
  TERMINAL_TASK_STATUSES,
} from "../protocol/claude-code/schema.js";
```

(Remove the `execFileSync` import.)

**2b.** Replace `detectBinary()` (keep the method; delete the `private binaryPath` field):

```ts
  detectBinary(): string | null {
    return detectBinary(CLAUDE_BINARY_NAME);
  }
```

**2c.** Replace `buildSpawnConfig()`:

```ts
  buildSpawnConfig(_cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig): SpawnConfig {
    return buildClaudeSessionSpawnConfig(
      this.detectBinary(),
      permissionMode,
      crossRemoteMcp ? buildMcpConfigArg(crossRemoteMcp) : undefined,
    );
  }
```

**2d.** In `parseStdoutLine()`, replace the JSON.parse prelude:

```ts
  parseStdoutLine(line: string, _sessionId: string): ParsedAgentEvent[] {
    const msg = parseClaudeLine(line);
    if (!msg) {
      return [];
    }
```

and in the `type === "system"` branch replace the three subtype string literals and the inline status array with the constants:

```ts
      if (systemMsg.subtype === TASK_STARTED_SUBTYPE && systemMsg.task_id) {
```
```ts
      if (systemMsg.subtype === TASK_NOTIFICATION_SUBTYPE && systemMsg.task_id) {
```
```ts
      if (systemMsg.subtype === TASK_UPDATED_SUBTYPE && systemMsg.task_id) {
        const patchStatus = (msg as { patch?: { status?: string } }).patch?.status;
        if (patchStatus && (TERMINAL_TASK_STATUSES as readonly string[]).includes(patchStatus)) {
          return [{ type: "task_finished", taskId: systemMsg.task_id, status: patchStatus }];
        }
        return [];
      }
```

Everything else in `parseStdoutLine` (assistant/result branches, the long ledger comment) stays as is.

**2e.** Replace `formatUserInput()`:

```ts
  formatUserInput(content: string | ContentPart[], _sessionId: string): string {
    return serializeUserInput(content);
  }
```

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS, `claude-code-provider.test.ts` unmodified.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/providers/claude-code-provider.ts
git commit -m "refactor(claude-code): move protocol parsing/args into protocol layer"
```

---

### Task 9: Unify process-manager's duplicate protocol code

**Highest-risk task in this plan.** `process-manager.ts` drives the terminal/scheduler executor paths. The equivalence tests written in Tasks 4 and 7 already pin the exact command strings/args; this task swaps the implementations and deletes the duplicates.

**Files:**
- Modify: `packages/vibedeckx/src/process-manager.ts`
- Test: `packages/vibedeckx/src/process-manager.test.ts` (new — covers `buildPromptCommand` routing through the protocol layer)

**Interfaces:**
- Consumes: `detectBinary` (Task 1), `buildCodexExecCommand` (Task 4), `buildClaudePrintCommand`, `buildClaudeStreamExecutorSpawn`, `serializeUserInput`, `parseClaudeLine` (Task 7).
- Produces: `ProcessManager` public behavior — unchanged.

- [ ] **Step 1: Write the failing test**

`buildPromptCommand` is private; test it through a minimal subclass exposure. Add:

```ts
// packages/vibedeckx/src/process-manager.test.ts
import { describe, expect, it } from "vitest";
import { clearBinaryCaches, detectBinary } from "./protocol/shared/binary.js";
import { ProcessManager } from "./process-manager.js";

// Access the private method for a contract check without spawning anything.
type WithBuildPromptCommand = {
  buildPromptCommand(prompt: string, provider: "claude" | "codex", finalResultFile?: string): string;
};

describe("ProcessManager prompt commands (protocol layer)", () => {
  const pm = new ProcessManager(null as never) as unknown as WithBuildPromptCommand;

  it("routes codex prompts through buildCodexExecCommand", () => {
    clearBinaryCaches();
    const nativeCodex = detectBinary("codex");
    const expectedBase = nativeCodex ?? "npx -y @openai/codex";
    expect(pm.buildPromptCommand("do it", "codex", "/tmp/last.txt")).toBe(
      `${expectedBase} --dangerously-bypass-approvals-and-sandbox exec 'do it' --output-last-message '/tmp/last.txt'`,
    );
  });

  it("routes claude prompts through buildClaudePrintCommand", () => {
    clearBinaryCaches();
    const nativeClaude = detectBinary("claude");
    const expectedBase = nativeClaude ?? "npx -y @anthropic-ai/claude-code";
    expect(pm.buildPromptCommand("hi", "claude")).toBe(
      `${expectedBase} -p 'hi' --dangerously-skip-permissions --verbose`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/process-manager.test.ts`
Expected: FAIL. (It may fail either on constructor/storage handling or on string mismatch against the old inline implementation depending on whether `codex`/`claude` are installed in the test environment — both count; the point is it goes green only after the swap. If it happens to pass pre-swap because the strings are already identical, that's the equivalence guarantee working — continue.)

- [ ] **Step 3: Apply the refactor**

**3a.** Add imports at the top of `process-manager.ts`:

```ts
import { detectBinary } from "./protocol/shared/binary.js";
import { buildCodexExecCommand } from "./protocol/codex/cli.js";
import {
  buildClaudePrintCommand,
  buildClaudeStreamExecutorSpawn,
} from "./protocol/claude-code/cli.js";
import { serializeUserInput } from "./protocol/claude-code/codec.js";
```

**3b.** Delete the private `detectBinary(name)` method (lines 86–108) and the `private binaryCache` field (line 80). Replace every `this.detectBinary(` call with the imported `detectBinary(`.

**3c.** Replace `buildPromptCommand()` (lines 110–134) with:

```ts
  /**
   * Build the shell command string for a prompt executor.
   * Supports claude and codex providers. Command shapes live in the
   * protocol layer (src/protocol/).
   */
  private buildPromptCommand(prompt: string, provider: PromptProvider, finalResultFile?: string): string {
    if (provider === 'codex') {
      return buildCodexExecCommand(detectBinary('codex'), prompt, finalResultFile);
    }
    return buildClaudePrintCommand(detectBinary('claude'), prompt);
  }
```

**3d.** In `startClaudeStreamProcess()` (lines 568–585), replace the inline args/command construction:

```ts
  private startClaudeStreamProcess(processId: string, executor: Executor, cwd: string, skipDb: boolean): void {
    const { command, args: fullArgs } = buildClaudeStreamExecutorSpawn(detectBinary('claude'));

    const childProcess = spawn(command, fullArgs, {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });
```

**3e.** Replace the inline stdin envelope (line 605):

```ts
    // Send prompt via stdin and close to signal single-turn
    const userMessage = serializeUserInput(executor.command);
    childProcess.stdin?.write(userMessage, () => {
      childProcess.stdin?.end();
    });
```

**3f.** The stdout rendering switch in `startClaudeStreamProcess` keeps its terminal-formatting logic, but the raw `JSON.parse` + catch is left as is (it needs the raw line for passthrough on parse failure, which it already handles). No change to lines 634–720.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, including the new `process-manager.test.ts`.

- [ ] **Step 5: Manual smoke check of the executor path**

Build and verify the terminal/scheduler paths still work end-to-end:

```bash
pnpm build:main
node packages/vibedeckx/dist/bin.js --help
```
Expected: build succeeds, CLI help prints (confirms the esbuild bundle resolves the new protocol modules). Full executor smoke (create a prompt executor and run it) happens in the dev environment before merge — note it in the PR description.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/process-manager.ts packages/vibedeckx/src/process-manager.test.ts
git commit -m "refactor(process-manager): use protocol layer, delete duplicate parser/detection"
```

---

### Task 10: Offline contract fixtures + strict validation tests

**Files:**
- Create: `packages/vibedeckx/src/protocol/claude-code/__fixtures__/stream-session.jsonl`
- Create: `packages/vibedeckx/src/protocol/codex/__fixtures__/app-server-session.jsonl`
- Create: `packages/vibedeckx/src/protocol/contract-check.ts`
- Test: `packages/vibedeckx/src/protocol/contract-check.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_CONTRACTS`, `CODEX_CONTRACTS`, all schemas.
- Produces: `checkContract(item: ContractItem, value: unknown): { ok: boolean; issues: string[]; unknownKeys: string[] }` — reused by the phase-2 live probe runner.

- [ ] **Step 1: Create the fixture corpora**

Seed with the real captured lines already used in tests (source noted per line block). Live-probe recordings will extend these files in phase 2.

`packages/vibedeckx/src/protocol/claude-code/__fixtures__/stream-session.jsonl` — one JSON object per line, in this order (these are the exact objects from `claude-code-provider.test.ts`, captured from Claude Code 2.1.198, plus representative assistant/result lines):

```jsonl
{"type":"system","subtype":"task_started","task_id":"aa462d9841ec77a13","tool_use_id":"toolu_01M21wx2oyVzZSY4M3HWrHAv","description":"Sleep 15 then reply DONE","subagent_type":"claude","task_type":"local_agent","prompt":"Run the bash command 'sleep 15' and then reply with the single word DONE.","uuid":"85005f62-c256-416a-8ac9-927cf1e1afce","session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
{"type":"system","subtype":"task_started","task_id":"bjpgos1hw","tool_use_id":"toolu_019pZw4sw7V3r8QMWJRrtQGX","description":"Sleep for 15 seconds","task_type":"local_bash","uuid":"3668156d-f0e7-450c-b25d-ace30f3fa8c6","session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
{"type":"system","subtype":"task_notification","task_id":"aa462d9841ec77a13","tool_use_id":"toolu_01M21wx2oyVzZSY4M3HWrHAv","status":"completed","output_file":"/tmp/tasks/aa462d9841ec77a13.output","summary":"DONE","usage":{"total_tokens":16233,"tool_uses":1,"duration_ms":25961},"uuid":"e96b54c7-b3fd-41ed-91e4-36084cc2a24f","session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
{"type":"system","subtype":"task_updated","task_id":"aa462d9841ec77a13","patch":{"status":"completed","end_time":1783126857624},"uuid":"37f09ecf-3516-4e4e-a886-43999351dcdb","session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"Running it."},{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"echo hi"}}],"model":"claude-sonnet-5","stop_reason":null,"stop_sequence":null},"session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
{"type":"result","subtype":"success","duration_ms":26100,"cost_usd":0.0031,"result":"DONE","session_id":"c80619f4-511a-4dba-9a4d-4c1d499c40af"}
```

`packages/vibedeckx/src/protocol/codex/__fixtures__/app-server-session.jsonl` (from `codex-provider.test.ts` helpers):

```jsonl
{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}
{"jsonrpc":"2.0","method":"item/completed","params":{"turnId":"turn-1","item":{"type":"commandExecution","id":"cmd-1","command":"/bin/bash -lc \"echo hi\"","aggregatedOutput":"hi\n","status":"completed"}}}
{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"turnId":"turn-1","tokenUsage":{"last":{"inputTokens":12,"outputTokens":34}}}}
{"jsonrpc":"2.0","method":"item/completed","params":{"turnId":"turn-1","item":{"type":"agentMessage","id":"msg-1","text":"Done.","phase":"final_answer"}}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}
{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{"command":"rm /tmp/x","cwd":"/tmp"}}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/vibedeckx/src/protocol/contract-check.test.ts
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { checkContract } from "./contract-check.js";
import { parseClaudeLine } from "./claude-code/codec.js";
import { parseCodexLine } from "./codex/codec.js";
import {
  CLAUDE_CONTRACTS,
  ClaudeAssistantMessageSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
} from "./claude-code/schema.js";
import {
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
  ThreadStartResultSchema,
  CommandApprovalParamsSchema,
} from "./codex/schema.js";

function fixtureLines(url: URL): string[] {
  return readFileSync(url, "utf-8").split("\n").filter((l) => l.trim());
}

describe("claude-code fixture corpus honors the contract", () => {
  const lines = fixtureLines(new URL("./claude-code/__fixtures__/stream-session.jsonl", import.meta.url));

  it("every fixture line parses", () => {
    for (const line of lines) {
      expect(parseClaudeLine(line), `unparseable: ${line}`).not.toBeNull();
    }
  });

  it("every fixture line validates against its message schema", () => {
    const byType = {
      assistant: ClaudeAssistantMessageSchema,
      system: ClaudeSystemMessageSchema,
      result: ClaudeResultMessageSchema,
    } as const;
    for (const line of lines) {
      const msg = parseClaudeLine(line)! as { type: keyof typeof byType };
      const schema = byType[msg.type];
      expect(schema, `no schema for type=${msg.type}`).toBeDefined();
      const report = checkContract({ id: `CC-OUT-${msg.type}`, schema, consumers: [] }, msg);
      expect(report.ok, `${report.issues.join("; ")} in: ${line}`).toBe(true);
    }
  });

  it("contract registry is wired", () => {
    expect(CLAUDE_CONTRACTS.map((c) => c.id)).toContain("CC-OUT-system");
  });
});

describe("codex fixture corpus honors the contract", () => {
  const lines = fixtureLines(new URL("./codex/__fixtures__/app-server-session.jsonl", import.meta.url));

  it("every fixture line classifies and validates", () => {
    for (const line of lines) {
      const incoming = parseCodexLine(line);
      expect(incoming.kind, `ignored: ${line}`).not.toBe("ignored");

      if (incoming.kind === "response") {
        expect(checkContract({ id: "CX-RESP-thread_start", schema: ThreadStartResultSchema, consumers: [] }, incoming.result).ok).toBe(true);
      } else if (incoming.kind === "notification") {
        const schema = {
          [CODEX_NOTIFICATIONS.itemCompleted]: ItemCompletedParamsSchema,
          [CODEX_NOTIFICATIONS.turnCompleted]: TurnCompletedParamsSchema,
          [CODEX_NOTIFICATIONS.tokenUsageUpdated]: TokenUsageParamsSchema,
        }[incoming.method];
        expect(schema, `no schema for ${incoming.method}`).toBeDefined();
        const report = checkContract({ id: incoming.method, schema: schema!, consumers: [] }, incoming.params);
        expect(report.ok, report.issues.join("; ")).toBe(true);
        if (incoming.method === CODEX_NOTIFICATIONS.itemCompleted) {
          const item = (incoming.params as { item: unknown }).item;
          expect(checkContract({ id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: [] }, item).ok).toBe(true);
        }
      } else if (incoming.kind === "server_request") {
        expect(incoming.method).toBe(CODEX_SERVER_REQUESTS.commandApproval);
        expect(checkContract({ id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema, consumers: [] }, incoming.params).ok).toBe(true);
      }
    }
  });
});

describe("checkContract", () => {
  it("fails with readable issues on a broken shape and reports unknown keys", () => {
    const report = checkContract(
      { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema, consumers: ["x.ts"] },
      { tokenUsage: { last: { inputTokens: "12" } }, brandNewField: 1 },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.join(" ")).toContain("inputTokens");
    expect(report.unknownKeys).toContain("brandNewField");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/protocol/contract-check.test.ts`
Expected: FAIL — `./contract-check.js` not found.

- [ ] **Step 4: Write the implementation**

```ts
// packages/vibedeckx/src/protocol/contract-check.ts
/**
 * Strict contract validation used by offline fixture tests and (phase 2)
 * the live compat probes. Failure semantics per the design spec:
 *   - a field we consume that is missing or type-changed -> ok: false (FAIL)
 *   - upstream-added fields we don't consume -> unknownKeys (WARN, never fails)
 */
import { z } from "zod";
import type { ContractItem } from "./contracts.js";

export interface ContractReport {
  ok: boolean;
  /** Human-readable schema violations: "<contract-id> <path>: <message>". */
  issues: string[];
  /** Top-level keys present in the value but absent from the schema shape. */
  unknownKeys: string[];
}

export function checkContract(item: ContractItem, value: unknown): ContractReport {
  const result = item.schema.safeParse(value);
  const issues = result.success
    ? []
    : result.error.issues.map((i) => `${item.id} ${i.path.join(".") || "(root)"}: ${i.message}`);

  const unknownKeys: string[] = [];
  const shape = shapeOf(item.schema);
  if (shape && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) unknownKeys.push(key);
    }
  }

  return { ok: result.success, issues, unknownKeys };
}

/** Extract the top-level shape of an object schema; null for unions etc. */
function shapeOf(schema: z.ZodType): Record<string, unknown> | null {
  const def = (schema as { def?: { shape?: Record<string, unknown> } }).def;
  return def?.shape ?? null;
}
```

Note: zod v4 exposes an object schema's shape at `schema.def.shape`. If `shapeOf` returns null in the unknown-keys test, check the running zod version's API (`schema.shape` also works on `ZodObject` instances) and adjust `shapeOf` accordingly — the test defines the required behavior.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/protocol/`
Expected: PASS — all protocol tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/
git commit -m "test(protocol): offline contract fixtures and strict validation"
```

---

### Task 11: Log agent CLI versions at spawn

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts:579` (after `buildSpawnConfig`)
- Modify: `packages/vibedeckx/src/process-manager.ts` (`buildPromptCommand` and `startClaudeStreamProcess`)

**Interfaces:**
- Consumes: `getBinaryVersion` (Task 1).
- Produces: log lines only — no behavior change.

- [ ] **Step 1: Add version logging to agent-session-manager**

In `spawnAgent()`, immediately after `const config = provider.buildSpawnConfig(...)` (currently line 579), insert:

```ts
    // Log the agent CLI version once per binary so protocol failures can be
    // attributed to an agent version. npx runs are logged as such (probing
    // `npx --version` would report npx itself, not the agent).
    if (config.command !== "npx") {
      const agentVersion = getBinaryVersion(config.command);
      console.log(`[AgentSession] ${provider.getDisplayName()} version: ${agentVersion ?? "unknown (--version probe failed)"}`);
    } else {
      console.log(`[AgentSession] ${provider.getDisplayName()} running via npx (version resolved at spawn by npm)`);
    }
```

Add the import at the top of the file:

```ts
import { getBinaryVersion } from "./protocol/shared/binary.js";
```

- [ ] **Step 2: Add version logging to process-manager**

In `startClaudeStreamProcess()` (Task 9's version), after the `buildClaudeStreamExecutorSpawn` call, insert:

```ts
    if (command !== 'npx') {
      console.log(`[ProcessManager] claude version: ${getBinaryVersion(command) ?? 'unknown'}`);
    }
```

Extend the Task 1 import in `process-manager.ts`:

```ts
import { detectBinary, getBinaryVersion } from "./protocol/shared/binary.js";
```

- [ ] **Step 3: Verify by observation**

```bash
pnpm test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```
Expected: all green (this task is log-only; the binary module's behavior is covered by Task 1's tests).

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts packages/vibedeckx/src/process-manager.ts
git commit -m "feat: log agent CLI version at spawn for drift attribution"
```

---

### Task 12: PR CI workflow + CLAUDE.md correction

**Files:**
- Create: `.github/workflows/test.yml`
- Modify: `CLAUDE.md` (the "No test framework is configured." line and the Architecture section)

- [ ] **Step 1: Determine the repo's pnpm major version**

Run: `pnpm --version`
Use the reported major version in the workflow's `version:` field below (shown as `10` — adjust to match).

- [ ] **Step 2: Create the workflow**

```yaml
# .github/workflows/test.yml
name: test

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Typecheck backend
        run: npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
      - name: Unit + offline contract tests
        run: pnpm --filter vibedeckx test
```

- [ ] **Step 3: Update CLAUDE.md**

Replace the line:

```
No test framework is configured.
```

with:

```
# Tests (vitest, colocated *.test.ts files in packages/vibedeckx/src/)
pnpm --filter vibedeckx test
```

And add to the end of the "Key Patterns" section:

```
- Agent CLI protocol knowledge (stream-json / Codex JSON-RPC shapes, CLI flags, binary detection) lives in `packages/vibedeckx/src/protocol/` — providers and process-manager consume it; never re-implement parsing or arg-building inline. Offline contract tests validate recorded fixtures against the zod schemas there.
```

- [ ] **Step 4: Validate the workflow syntax and commit**

```bash
npx --yes @action-validator/cli .github/workflows/test.yml || echo "validator unavailable — rely on GitHub's parse"
git add .github/workflows/test.yml CLAUDE.md
git commit -m "ci: run typecheck + unit/contract tests on PRs; update CLAUDE.md"
```

(If the validator npm package is unavailable, GitHub validates on push; the YAML above follows the standard actions setup.)

---

## Verification (whole plan)

After the final task:

```bash
pnpm test                                              # from packages/vibedeckx/ — all green
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json   # clean
cd apps/vibedeckx-ui && npx tsc --noEmit               # clean (frontend untouched — confirms no accidental type breakage via agent-types re-exports)
pnpm build                                             # full build incl. esbuild bundle succeeds
```

Manual smoke before merge (dev environment): start a Claude Code session and a Codex session, run one turn each; create a claude prompt executor and a codex prompt executor, run each once; open a terminal. All four paths exercise the refactored protocol code.

## Out of scope (follow-up plan)

- Live probe runner + CC-1…CC-8 / CX-1…CX-8 scenarios (spec §4.2)
- Drift-watch CI with version detection and pinned×latest matrix (spec §4.3)
- Frontend shared-constants package
