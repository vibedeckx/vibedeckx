# Protocol Compat Phase 2: Live Probes & Drift-Watch CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live canary tests that spawn the real `claude`/`codex` CLIs through the production protocol layer, validate every line against the phase-1 contracts, plus a drift-watch CI workflow (version detection + pinned×latest matrix).

**Spec:** `docs/superpowers/specs/2026-07-12-protocol-compat-phase2-live-probes-design.md`

**Architecture:** A stateless probe runner (`src/protocol/live/runner.ts`) spawns via the production `protocol/*/cli.ts` builders and validates lines via `contract-check.ts`. Scenario files are vitest tests in a separate config so `pnpm test` stays free. CI installs specific CLI versions and calls the same `pnpm test:compat` entrypoint.

**Tech Stack:** TypeScript NodeNext ESM, vitest v4, zod v4 (all present). No new dependencies.

## Global Constraints

- Backend ESM NodeNext: all local imports need `.js` extensions.
- No new npm dependencies.
- `pnpm test` (default suite) must remain free, offline, deterministic — live tests run ONLY via `pnpm test:compat`.
- Live tests use filename suffix `.live.test.ts` and live in `packages/vibedeckx/src/protocol/live/`.
- Live scenarios: assertions are STRUCTURAL (message shapes, tool names, event ordering) — never assert on model-generated text content.
- **Prompt-tuning policy:** the scenario prompts in this plan are concrete first drafts. If a scenario flakes because the model doesn't follow the prompt, the implementer may strengthen the prompt wording — but must NOT weaken the plan's stated assertions. Each scenario allows `retry: 1` via vitest.
- Live runs cost real API usage (cents). The machine has authenticated `claude` (2.1.205) and `codex` (0.144.1, ChatGPT login). Claude scenarios append `--model claude-haiku-4-5-20251001` for cost control; codex uses its default model.
- Working directory: repo root `/var/tmp/vibedeckx/worktrees/vibedeckx-49e0cefb/dev1` (bare `pnpm test`/`pnpm test:compat` run from `packages/vibedeckx/`).
- Typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (tsconfig excludes `*.test.ts`; keep it that way — also exclude nothing new).

---

### Task 1: Vitest config split + `test:compat` entrypoint

**Files:**
- Create: `packages/vibedeckx/vitest.config.ts`
- Create: `packages/vibedeckx/vitest.live.config.ts`
- Modify: `packages/vibedeckx/package.json` (scripts)
- Modify: `packages/vibedeckx/.gitignore` (create if absent)

**Interfaces:**
- Produces: `pnpm test` (default suite, excludes live), `pnpm test:compat` (live suite only) — used by every later task and by CI (Task 11).

- [ ] **Step 1: Create the default config**

```ts
// packages/vibedeckx/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live compat probes spawn real agent CLIs and cost API usage — they run
    // only via `pnpm test:compat` (vitest.live.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
  },
});
```

- [ ] **Step 2: Create the live config**

```ts
// packages/vibedeckx/vitest.live.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/protocol/live/**/*.live.test.ts"],
    // One CLI at a time: keeps cost/auth behavior predictable and failures readable.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    retry: 1,
    passWithNoTests: true,
  },
});
```

- [ ] **Step 3: Add the script and gitignore**

In `packages/vibedeckx/package.json` scripts, after `"test:watch"`:

```jsonc
"test:compat": "vitest run --config vitest.live.config.ts",
```

Append to `packages/vibedeckx/.gitignore` (create the file if it does not exist):

```
src/protocol/live/recordings/
```

- [ ] **Step 4: Verify both entrypoints**

Run (from `packages/vibedeckx/`): `pnpm test`
Expected: 379 tests pass (config exclusion changes nothing yet).
Run: `pnpm test:compat`
Expected: exits 0 with "no test files found" (passWithNoTests).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/vitest.config.ts packages/vibedeckx/vitest.live.config.ts packages/vibedeckx/package.json packages/vibedeckx/.gitignore
git commit -m "test(compat): split live suite behind pnpm test:compat"
```

---

### Task 2: Phase-1 carry-ins — `which` timeout + two-way frontend tool-name check

**Files:**
- Modify: `packages/vibedeckx/src/protocol/shared/binary.ts` (one line)
- Test: `packages/vibedeckx/src/protocol/claude-code/frontend-tools.test.ts` (new, offline/default suite)

- [ ] **Step 1: Add the missing timeout**

In `binary.ts` `detectBinary`, add `timeout: 5000` to the `execFileSync` options (matching `getBinaryVersion`):

```ts
    const result = execFileSync(cmd, [name], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
```

- [ ] **Step 2: Write the two-way tool-name test**

The frontend special-cases tools in `apps/vibedeckx-ui/components/agent/agent-message.tsx` via two patterns: `tool === "Name"` comparisons and the `taskToolLabels` map keys. This test parses the source (the frontend package is not importable from backend tests) and checks both directions.

```ts
// packages/vibedeckx/src/protocol/claude-code/frontend-tools.test.ts
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { FRONTEND_RENDERED_TOOLS } from "./schema.js";

// packages/vibedeckx/src/protocol/claude-code/ -> repo root is five levels up
const AGENT_MESSAGE_TSX = new URL(
  "../../../../../apps/vibedeckx-ui/components/agent/agent-message.tsx",
  import.meta.url,
);

function extractFrontendToolNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/tool === "([A-Za-z]+)"/g)) {
    names.add(m[1]);
  }
  // taskToolLabels map keys: TodoWrite / TaskCreate / TaskUpdate / TaskList / TaskGet
  const mapBlock = source.match(/const taskToolLabels[\s\S]*?\n  \};/);
  if (mapBlock) {
    for (const m of mapBlock[0].matchAll(/^\s+([A-Za-z]+): \{ label:/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

describe("FRONTEND_RENDERED_TOOLS stays in sync with agent-message.tsx", () => {
  const source = readFileSync(AGENT_MESSAGE_TSX, "utf-8");
  const frontendNames = extractFrontendToolNames(source);

  it("extraction finds a plausible number of special-cased tools", () => {
    expect(frontendNames.size).toBeGreaterThanOrEqual(15);
  });

  it("every tool the frontend special-cases is in FRONTEND_RENDERED_TOOLS", () => {
    const known = new Set<string>(FRONTEND_RENDERED_TOOLS);
    const missing = [...frontendNames].filter((n) => !known.has(n));
    expect(missing, `add these to FRONTEND_RENDERED_TOOLS in schema.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every FRONTEND_RENDERED_TOOLS entry still exists in the frontend source", () => {
    const stale = FRONTEND_RENDERED_TOOLS.filter((n) => !frontendNames.has(n));
    expect(stale, `these constants no longer match agent-message.tsx: ${stale.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, reconcile, verify**

Run: `npx vitest run src/protocol/claude-code/frontend-tools.test.ts`
If direction A or B fails, reconcile by editing `FRONTEND_RENDERED_TOOLS` in `schema.ts` to match the frontend truth (the frontend file is the source of truth; do not edit it). Then re-run until green, and run the full suite: `pnpm test`.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/
git commit -m "test(protocol): two-way frontend tool-name sync check; which-probe timeout"
```

---

### Task 3: Live probe runner + fake-CLI offline tests

**Files:**
- Create: `packages/vibedeckx/src/protocol/live/runner.ts`
- Create: `packages/vibedeckx/src/protocol/live/fake-cli.mjs`
- Test: `packages/vibedeckx/src/protocol/live/runner.test.ts` (offline — default suite)

**Interfaces (consumed by Tasks 4–9):**
- `runClaudeSession(opts: ClaudeRunOptions): Promise<ClaudeRunResult>`
- `runCodexAppServer(opts: CodexRunOptions): Promise<CodexRunResult>`
- `runOneShot(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>`
- Types: `LiveOutcome = "ok" | "timeout" | "spawn_error" | "auth_error"`, `ContractIssue`, plus the option/result interfaces below.
- `claudeBinaryAvailable(): boolean`, `codexBinaryAvailable(): boolean`, `compatRequired(): boolean` — gating helpers for `describe.skipIf`.

- [ ] **Step 1: Write the failing offline test**

```ts
// packages/vibedeckx/src/protocol/live/runner.test.ts
import { describe, expect, it } from "vitest";
import { runClaudeSession, runCodexAppServer } from "./runner.js";

const FAKE = new URL("./fake-cli.mjs", import.meta.url).pathname;

function fakeSpawn(mode: string) {
  return { command: process.execPath, args: [FAKE, mode] };
}

describe("runner (offline, fake CLI)", () => {
  it("collects a claude session: text, tool_use, result", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("claude-basic"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const types = r.messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types[types.length - 1]).toBe("result");
    expect(r.contractFailures).toEqual([]);
  });

  it("multi-turn: sends the second turn after the first result", async () => {
    const r = await runClaudeSession({ turns: ["one", "two"], spawnOverride: fakeSpawn("claude-multiturn"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    const results = r.messages.filter((m) => (m as { type: string }).type === "result");
    expect(results.length).toBe(2);
  });

  it("flags a contract violation when a consumed field changes type", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("claude-drift"), timeoutMs: 10_000 });
    expect(r.contractFailures.length).toBeGreaterThan(0);
    expect(r.contractFailures[0].contractId).toContain("CC-OUT");
  });

  it("classifies auth failure from stderr before any protocol line", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("auth-fail"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("auth_error");
  });

  it("times out when the CLI hangs", async () => {
    const r = await runClaudeSession({ turns: ["hello"], spawnOverride: fakeSpawn("hang"), timeoutMs: 1_500 });
    expect(r.outcome).toBe("timeout");
  });

  it("drives a codex handshake and turn to completion", async () => {
    const r = await runCodexAppServer({ turns: ["hello"], spawnOverride: fakeSpawn("codex-basic"), timeoutMs: 10_000 });
    expect(r.outcome).toBe("ok");
    expect(r.threadId).toBe("t-fake");
    const methods = r.incoming.filter((i) => i.kind === "notification").map((i) => (i as { method: string }).method);
    expect(methods).toContain("item/completed");
    expect(methods).toContain("turn/completed");
    expect(r.contractFailures).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the fake CLI**

```js
// packages/vibedeckx/src/protocol/live/fake-cli.mjs
// Replays canned protocol lines for offline runner tests. Mode = argv[2].
const mode = process.argv[2];
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const CLAUDE_TURN = (n) => {
  out({ type: "assistant", message: { content: [{ type: "text", text: `reply ${n}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "echo hi" } }] }, session_id: "fake" });
  out({ type: "result", subtype: "success", duration_ms: 5, cost_usd: 0.0001, session_id: "fake" });
};

if (mode === "auth-fail") {
  process.stderr.write("Invalid API key. Please run /login\n");
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => {}, 1000); // never speak, never exit
}

let turns = 0;
let buffered = "";
process.stdin.on("data", (d) => {
  buffered += d.toString();
  let idx;
  while ((idx = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, idx);
    buffered = buffered.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (mode === "claude-basic" || mode === "claude-multiturn") {
      turns++;
      CLAUDE_TURN(turns);
    } else if (mode === "claude-drift") {
      out({ type: "assistant", message: { content: [{ type: "text", text: 42 }] }, session_id: "fake" }); // text is a number: consumed-field type change
      out({ type: "result", subtype: "success" });
    } else if (mode === "codex-basic") {
      if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: {} });
      if (msg.method === "thread/start") out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "t-fake" } } });
      if (msg.method === "turn/start") {
        out({ jsonrpc: "2.0", method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "done", phase: "final_answer" } } });
        out({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 1, outputTokens: 2 } } } });
        out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/protocol/live/runner.test.ts`
Expected: FAIL — `./runner.js` not found.

- [ ] **Step 4: Write the runner**

```ts
// packages/vibedeckx/src/protocol/live/runner.ts
/**
 * Live compat probe runner. Spawns the real agent CLIs via the PRODUCTION
 * protocol-layer builders, drives scenario turns, validates every received
 * line against the phase-1 contracts, and records raw transcripts.
 *
 * Failure taxonomy (spec §7): spawn_error / auth_error are distinguished from
 * contract violations so a CI red is immediately attributable.
 */
import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { detectBinary } from "../shared/binary.js";
import { checkContract } from "../contract-check.js";
import { buildClaudeSessionSpawnConfig } from "../claude-code/cli.js";
import { parseClaudeLine, serializeUserInput } from "../claude-code/codec.js";
import {
  CLAUDE_BINARY_NAME,
  ClaudeAssistantMessageSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
  ClaudeUserMessageSchema,
  type ClaudeOutputMessage,
} from "../claude-code/schema.js";
import { buildCodexAppServerSpawnConfig } from "../codex/cli.js";
import {
  buildCodexInput,
  parseCodexLine,
  threadStartParamsFor,
  type CodexIncoming,
} from "../codex/codec.js";
import {
  CODEX_BINARY_NAME,
  CODEX_CLIENT_METHODS,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  CommandApprovalParamsSchema,
  FileChangeApprovalParamsSchema,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  ThreadStartResultSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
  UserInputParamsSchema,
} from "../codex/schema.js";

export type LiveOutcome = "ok" | "timeout" | "spawn_error" | "auth_error";

export interface ContractIssue {
  contractId: string;
  issues: string[];
  line: string;
}

export interface SpawnOverride {
  command: string;
  args: string[];
}

const AUTH_STDERR = /invalid api key|not logged in|please run \/login|log in|authenticat|unauthorized|credential|expired/i;
const RECORDINGS_DIR = new URL("./recordings/", import.meta.url).pathname;

// ---- shared line pump ----

interface Pump {
  proc: ChildProcess;
  rawLines: string[];
  stderr: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
  /** Resolves "matched" when a new line satisfies pred, "exit" on process end, "timeout" after ms. */
  waitFor(pred: (line: string) => boolean, ms: number): Promise<"matched" | "exit" | "timeout">;
  kill(): void;
}

function startPump(proc: ChildProcess): Pump {
  const rawLines: string[] = [];
  let stderrBuf = "";
  let stdoutBuf = "";
  let exited = false;
  let exitCode: number | null = null;
  type Waiter = { pred: (line: string) => boolean; resolve: (r: "matched" | "exit") => void };
  const waiters: Set<Waiter> = new Set();

  proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
  proc.stdout?.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      rawLines.push(line);
      for (const w of [...waiters]) {
        if (w.pred(line)) { waiters.delete(w); w.resolve("matched"); }
      }
    }
  });
  proc.on("close", (code) => {
    exited = true;
    exitCode = code;
    for (const w of [...waiters]) { waiters.delete(w); w.resolve("exit"); }
  });
  proc.on("error", () => {
    exited = true;
    for (const w of [...waiters]) { waiters.delete(w); w.resolve("exit"); }
  });

  return {
    proc,
    rawLines,
    stderr: () => stderrBuf,
    exited: () => exited,
    exitCode: () => exitCode,
    waitFor(pred, ms) {
      // Check already-received lines first
      if (rawLines.some(pred)) return Promise.resolve("matched");
      if (exited) return Promise.resolve("exit");
      return new Promise((resolve) => {
        const w: Waiter = { pred, resolve: (r) => { clearTimeout(t); resolve(r); } };
        const t = setTimeout(() => { waiters.delete(w); resolve("timeout"); }, ms);
        waiters.add(w);
      });
    },
    kill() {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      } catch { proc.kill("SIGTERM"); }
    },
  };
}

function classifyFailure(pump: Pump, sawProtocol: boolean, timedOut: boolean): LiveOutcome {
  if (timedOut) return "timeout";
  if (!sawProtocol) {
    return AUTH_STDERR.test(pump.stderr()) ? "auth_error" : "spawn_error";
  }
  return "ok";
}

function record(recordAs: string | undefined, rawLines: string[]): void {
  if (!recordAs) return;
  try {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    writeFileSync(path.join(RECORDINGS_DIR, `${recordAs}.jsonl`), rawLines.join("\n") + "\n");
  } catch { /* recordings are best-effort */ }
}

function freshCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-"));
}

// ---- claude driver ----

export interface ClaudeRunOptions {
  turns: string[];
  permissionMode?: "plan" | "edit";
  extraArgs?: string[];
  mcpConfigArg?: string;
  cwd?: string;
  timeoutMs?: number;
  recordAs?: string;
  spawnOverride?: SpawnOverride;
}

export interface ClaudeRunResult {
  outcome: LiveOutcome;
  messages: ClaudeOutputMessage[];
  rawLines: string[];
  contractFailures: ContractIssue[];
  unknownKeys: Record<string, string[]>;
  stderr: string;
  exitCode: number | null;
}

const CLAUDE_SCHEMA_BY_TYPE: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
  assistant: { id: "CC-OUT-assistant", schema: ClaudeAssistantMessageSchema },
  user: { id: "CC-OUT-user", schema: ClaudeUserMessageSchema },
  system: { id: "CC-OUT-system", schema: ClaudeSystemMessageSchema },
  result: { id: "CC-OUT-result", schema: ClaudeResultMessageSchema },
};

export async function runClaudeSession(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const base = opts.spawnOverride
    ?? (() => {
      const c = buildClaudeSessionSpawnConfig(detectBinary(CLAUDE_BINARY_NAME), opts.permissionMode ?? "edit", opts.mcpConfigArg);
      return { command: c.command, args: c.args };
    })();
  const proc = spawn(base.command, [...base.args, ...(opts.extraArgs ?? [])], {
    cwd: opts.cwd ?? freshCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const pump = startPump(proc);

  const isResult = (line: string) => (parseClaudeLine(line) as { type?: string } | null)?.type === "result";
  let timedOut = false;

  for (const turn of opts.turns) {
    const already = pump.rawLines.filter(isResult).length;
    proc.stdin?.write(serializeUserInput(turn));
    const r = await pump.waitFor((l) => pump.rawLines.filter(isResult).length > already && isResult(l), timeoutMs);
    if (r === "timeout") { timedOut = true; break; }
    if (r === "exit") break;
  }
  pump.kill();
  // give the close event a beat so exitCode settles
  await new Promise((res) => setTimeout(res, 100));

  const messages: ClaudeOutputMessage[] = [];
  const contractFailures: ContractIssue[] = [];
  const unknownKeys: Record<string, string[]> = {};
  for (const line of pump.rawLines) {
    const msg = parseClaudeLine(line);
    if (!msg) continue; // non-JSON progress noise is legal
    messages.push(msg);
    const entry = CLAUDE_SCHEMA_BY_TYPE[(msg as { type: string }).type];
    if (!entry) {
      (unknownKeys["CC-unknown-message-type"] ??= []).push((msg as { type: string }).type);
      continue;
    }
    const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, msg);
    if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
    if (report.unknownKeys.length) {
      (unknownKeys[entry.id] ??= []).push(...report.unknownKeys.filter((k) => !(unknownKeys[entry.id] ?? []).includes(k)));
    }
  }

  const sawProtocol = messages.length > 0;
  record(opts.recordAs, pump.rawLines);
  return {
    outcome: classifyFailure(pump, sawProtocol, timedOut),
    messages,
    rawLines: pump.rawLines,
    contractFailures,
    unknownKeys,
    stderr: pump.stderr(),
    exitCode: pump.exitCode(),
  };
}

// ---- codex driver ----

export interface CodexControl {
  cancelTurn: () => void;
  reply: (rawLine: string) => void;
}

export interface CodexRunOptions {
  turns: string[];
  threadStartParams?: Record<string, unknown>;
  onIncoming?: (incoming: CodexIncoming, ctl: CodexControl) => void;
  cwd?: string;
  timeoutMs?: number;
  recordAs?: string;
  spawnOverride?: SpawnOverride;
}

export interface CodexRunResult {
  outcome: LiveOutcome;
  incoming: CodexIncoming[];
  threadId: string | null;
  rawLines: string[];
  contractFailures: ContractIssue[];
  unknownKeys: Record<string, string[]>;
  stderr: string;
  exitCode: number | null;
}

function rpc(payload: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
}

export async function runCodexAppServer(opts: CodexRunOptions): Promise<CodexRunResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const base = opts.spawnOverride
    ?? (() => {
      const c = buildCodexAppServerSpawnConfig(detectBinary(CODEX_BINARY_NAME));
      return { command: c.command, args: c.args };
    })();
  const proc = spawn(base.command, base.args, {
    cwd: opts.cwd ?? freshCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const pump = startPump(proc);

  let rpcId = 1;
  let currentTurnId: number | null = null;
  const ctl: CodexControl = {
    cancelTurn: () => {
      if (currentTurnId != null) {
        proc.stdin?.write(rpc({ method: CODEX_CLIENT_METHODS.cancelRequest, params: { id: currentTurnId } }));
      }
    },
    reply: (rawLine) => { proc.stdin?.write(rawLine); },
  };

  const incoming: CodexIncoming[] = [];
  const seen = new Set<string>();
  const drain = () => {
    for (const line of pump.rawLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      const inc = parseCodexLine(line);
      incoming.push(inc);
      opts.onIncoming?.(inc, ctl);
    }
  };
  // onIncoming must fire as lines arrive (CX-5 cancel, CX-8 approvals), so poll-drain on every wait.

  const initId = rpcId++;
  const threadStartId = rpcId++;
  proc.stdin?.write(rpc({ id: initId, method: CODEX_CLIENT_METHODS.initialize, params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } } }));
  proc.stdin?.write(rpc({ id: threadStartId, method: CODEX_CLIENT_METHODS.threadStart, params: opts.threadStartParams ?? threadStartParamsFor("edit") }));

  const matchesResponse = (id: number) => (line: string) => {
    const inc = parseCodexLine(line);
    return (inc.kind === "response" || inc.kind === "error_response") && Number(inc.id) === id;
  };

  let timedOut = false;
  let threadId: string | null = null;

  const tsWait = await pump.waitFor(matchesResponse(threadStartId), timeoutMs);
  drain();
  if (tsWait === "timeout") timedOut = true;
  const tsResp = incoming.find((i) => i.kind === "response" && Number(i.id) === threadStartId);
  if (tsResp?.kind === "response") {
    const parsed = ThreadStartResultSchema.safeParse(tsResp.result);
    if (parsed.success) threadId = parsed.data.thread.id;
  }

  if (threadId && !timedOut) {
    for (const turn of opts.turns) {
      const turnId = rpcId++;
      currentTurnId = turnId;
      proc.stdin?.write(rpc({ id: turnId, method: CODEX_CLIENT_METHODS.turnStart, params: { threadId, input: buildCodexInput(turn) } }));
      // Wait for turn/completed OR an error response for this turn id; drain
      // continuously so onIncoming can cancel/approve mid-turn.
      const done = (line: string) => {
        drain();
        const inc = parseCodexLine(line);
        if (inc.kind === "notification" && inc.method === CODEX_NOTIFICATIONS.turnCompleted) return true;
        if (inc.kind === "error_response" && Number(inc.id) === turnId) return true;
        return false;
      };
      const r = await pump.waitFor(done, timeoutMs);
      drain();
      if (r === "timeout") { timedOut = true; break; }
      if (r === "exit") break;
    }
  }
  pump.kill();
  await new Promise((res) => setTimeout(res, 100));
  drain();

  // ---- contract validation ----
  const contractFailures: ContractIssue[] = [];
  const unknownKeys: Record<string, string[]> = {};
  const note = (id: string, keys: string[]) => {
    if (keys.length) (unknownKeys[id] ??= []).push(...keys.filter((k) => !(unknownKeys[id] ?? []).includes(k)));
  };
  const NOTIF_SCHEMAS: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
    [CODEX_NOTIFICATIONS.itemCompleted]: { id: "CX-NOTIF-item_completed", schema: ItemCompletedParamsSchema },
    [CODEX_NOTIFICATIONS.turnCompleted]: { id: "CX-NOTIF-turn_completed", schema: TurnCompletedParamsSchema },
    [CODEX_NOTIFICATIONS.tokenUsageUpdated]: { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema },
  };
  const REQ_SCHEMAS: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
    [CODEX_SERVER_REQUESTS.commandApproval]: { id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema },
    [CODEX_SERVER_REQUESTS.fileChangeApproval]: { id: "CX-REQ-file_change_approval", schema: FileChangeApprovalParamsSchema },
    [CODEX_SERVER_REQUESTS.userInput]: { id: "CX-REQ-user_input", schema: UserInputParamsSchema },
  };
  for (let i = 0; i < incoming.length; i++) {
    const inc = incoming[i];
    const line = pump.rawLines[i] ?? "";
    if (inc.kind === "notification") {
      const entry = NOTIF_SCHEMAS[inc.method];
      if (!entry) { note("CX-unknown-notification", [inc.method]); continue; }
      const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, inc.params);
      if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
      note(entry.id, report.unknownKeys);
      if (inc.method === CODEX_NOTIFICATIONS.itemCompleted) {
        const item = (inc.params as { item?: { type?: string } })?.item;
        if (item && KnownThreadItemSchema.options.some((o) => o.shape.type.value === item.type)) {
          const ir = checkContract({ id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: [] }, item);
          if (!ir.ok) contractFailures.push({ contractId: "CX-ITEM-known_types", issues: ir.issues, line });
        } else if (item?.type) {
          note("CX-unknown-item-type", [item.type]);
        }
      }
    } else if (inc.kind === "server_request") {
      const entry = REQ_SCHEMAS[inc.method];
      if (!entry) { note("CX-unknown-server-request", [inc.method]); continue; }
      const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, inc.params);
      if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
      note(entry.id, report.unknownKeys);
    }
  }

  const sawProtocol = incoming.some((i) => i.kind !== "ignored");
  record(opts.recordAs, pump.rawLines);
  return {
    outcome: classifyFailure(pump, sawProtocol, timedOut),
    incoming,
    threadId,
    rawLines: pump.rawLines,
    contractFailures,
    unknownKeys,
    stderr: pump.stderr(),
    exitCode: pump.exitCode(),
  };
}

// ---- one-shot driver (CC-8 `-p`, CX-7 `exec`) ----

export async function runOneShot(
  command: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const proc = spawn(command, { shell: true, cwd: opts?.cwd ?? freshCwd(), detached: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (proc.pid) process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ exitCode: code, stdout, stderr, timedOut: false });
    });
  });
}

// ---- gating helpers ----

export function claudeBinaryAvailable(): boolean {
  return detectBinary(CLAUDE_BINARY_NAME) !== null;
}
export function codexBinaryAvailable(): boolean {
  return detectBinary(CODEX_BINARY_NAME) !== null;
}
/** When set (CI), a would-be skip must fail instead — no silent green. */
export function compatRequired(): boolean {
  return process.env.VIBEDECKX_COMPAT_REQUIRED === "1";
}
```

Note on `KnownThreadItemSchema.options.some((o) => o.shape.type.value === item.type)`: zod v4 discriminated-union member access — if the installed zod exposes this differently, fall back to a hardcoded known-type list derived from `KnownThreadItemSchema` at module load; the runner test's `codex-basic` mode (agentMessage item) defines the required behavior.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/protocol/live/runner.test.ts`
Expected: PASS (6 tests). Also confirm the default suite still excludes nothing wrongly: `pnpm test` → all green (runner.test.ts is offline and included; no `.live.test.ts` files exist yet).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/
git commit -m "feat(compat): live probe runner with fake-CLI offline tests"
```

---

### Task 4: Claude live scenarios CC-1, CC-2, CC-4, CC-8

**Files:**
- Create: `packages/vibedeckx/src/protocol/live/claude.live.test.ts`

**This task runs real `claude` sessions (cents of cost). Verify by actually running `pnpm test:compat`.**

- [ ] **Step 1: Write the scenarios**

```ts
// packages/vibedeckx/src/protocol/live/claude.live.test.ts
import { describe, expect, it } from "vitest";
import { buildClaudePrintCommand } from "../claude-code/cli.js";
import { detectBinary } from "../shared/binary.js";
import { claudeBinaryAvailable, compatRequired, runClaudeSession, runOneShot } from "./runner.js";

const MODEL_ARGS = ["--model", "claude-haiku-4-5-20251001"];
const available = claudeBinaryAvailable();

if (!available && compatRequired()) {
  throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no claude binary available");
}

describe.skipIf(!available)("claude live probes (core)", () => {
  it("CC-1: basic turn — assistant text then result", async () => {
    const r = await runClaudeSession({
      turns: ["Reply with a short greeting. Do not use any tools."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc1-basic",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const types = r.messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types).toContain("result");
    const assistantTexts = r.messages.filter((m) => (m as { type: string }).type === "assistant");
    expect(assistantTexts.length).toBeGreaterThan(0);
  });

  it("CC-2: forced tool call — tool_use and tool_result shapes", async () => {
    const r = await runClaudeSession({
      turns: ["Use the Bash tool to run exactly this command: echo vibedeckx-probe. Then stop. Do not run anything else."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc2-tool",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    // find a Bash tool_use block in an assistant message
    const toolUses = r.messages.flatMap((m) => {
      const content = (m as { type: string; message?: { content?: Array<{ type: string; name?: string; id?: string; input?: unknown }> } });
      if (content.type !== "assistant" || !Array.isArray(content.message?.content)) return [];
      return content.message.content.filter((b) => b.type === "tool_use");
    });
    expect(toolUses.length).toBeGreaterThan(0);
    const bash = toolUses.find((t) => t.name === "Bash");
    expect(bash, `expected a Bash tool_use, saw: ${toolUses.map((t) => t.name).join(", ")}`).toBeDefined();
    expect(typeof bash!.id).toBe("string");
    // and a matching tool_result in a user message
    const toolResults = r.messages.flatMap((m) => {
      const um = m as { type: string; message?: { content?: Array<{ type: string; tool_use_id?: string }> } };
      if (um.type !== "user" || !Array.isArray(um.message?.content)) return [];
      return um.message.content.filter((b) => b.type === "tool_result");
    });
    expect(toolResults.some((tr) => tr.tool_use_id === bash!.id)).toBe(true);
  });

  it("CC-4: multi-turn liveness — process answers a second stdin turn after result", async () => {
    const r = await runClaudeSession({
      turns: [
        "Reply with the word ONE and nothing else. No tools.",
        "Reply with the word TWO and nothing else. No tools.",
      ],
      extraArgs: MODEL_ARGS,
      recordAs: "cc4-multiturn",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const results = r.messages.filter((m) => (m as { type: string }).type === "result");
    expect(results.length, "process must stay alive after result and answer turn 2").toBe(2);
  });

  it("CC-8: -p print mode — one-shot run exits with a result", async () => {
    const cmd = buildClaudePrintCommand(detectBinary("claude"), "Reply with the word PONG and nothing else.") + " --output-format=stream-json --model claude-haiku-4-5-20251001";
    const r = await runOneShot(cmd);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const types = lines.map((l) => { try { return JSON.parse(l).type; } catch { return null; } });
    expect(types).toContain("result");
  });
});
```

- [ ] **Step 2: Run live and stabilize**

Run (from `packages/vibedeckx/`): `pnpm test:compat`
Expected: 4 tests pass against the real CLI. If a scenario flakes, strengthen its prompt (see Global Constraints prompt-tuning policy — assertions stay). Record how many attempts each needed in your report.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/claude.live.test.ts
git commit -m "test(compat): claude live scenarios CC-1/2/4/8"
```

---

### Task 5: Claude live scenarios CC-3, CC-5, CC-6

**Files:**
- Modify: `packages/vibedeckx/src/protocol/live/claude.live.test.ts` (append a describe block)

- [ ] **Step 1: Append the scenarios**

```ts
describe.skipIf(!available)("claude live probes (lifecycle & flags)", () => {
  it("CC-3: run_in_background emits task_started and task_notification", async () => {
    const r = await runClaudeSession({
      turns: ["Use the Bash tool with run_in_background set to true to run: sleep 3. Then wait for it to finish and reply DONE."],
      extraArgs: MODEL_ARGS,
      timeoutMs: 150_000,
      recordAs: "cc3-background",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const systems = r.messages.filter((m) => (m as { type: string }).type === "system") as Array<{ subtype?: string; task_id?: string }>;
    const started = systems.filter((s) => s.subtype === "task_started" && s.task_id);
    // The background-task ledger depends on these two events — this is the core drift tripwire.
    expect(started.length, "no task_started event — background-task ledger protocol drifted?").toBeGreaterThan(0);
    const finished = systems.filter(
      (s) => (s.subtype === "task_notification" && s.task_id) || (s.subtype === "task_updated" && s.task_id),
    );
    expect(finished.length, "no task_notification/task_updated terminal event").toBeGreaterThan(0);
  });

  it("CC-5: plan mode — ExitPlanMode tool_use appears", async () => {
    const r = await runClaudeSession({
      turns: ["Make a one-step plan to create a file named hello.txt, then immediately exit plan mode to present the plan."],
      permissionMode: "plan",
      extraArgs: MODEL_ARGS,
      recordAs: "cc5-planmode",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const toolNames = r.messages.flatMap((m) => {
      const am = m as { type: string; message?: { content?: Array<{ type: string; name?: string }> } };
      if (am.type !== "assistant" || !Array.isArray(am.message?.content)) return [];
      return am.message.content.filter((b) => b.type === "tool_use").map((b) => b.name);
    });
    expect(toolNames, `expected ExitPlanMode among: ${toolNames.join(", ")}`).toContain("ExitPlanMode");
  });

  it("CC-6: --disallowedTools AskUserQuestion is honored", async () => {
    const r = await runClaudeSession({
      turns: ["Ask me a multiple-choice question about my favorite color using the AskUserQuestion tool. If that tool is unavailable, ask in plain text instead."],
      extraArgs: MODEL_ARGS,
      recordAs: "cc6-disallowed",
    });
    expect(r.outcome).toBe("ok");
    const toolNames = r.messages.flatMap((m) => {
      const am = m as { type: string; message?: { content?: Array<{ type: string; name?: string }> } };
      if (am.type !== "assistant" || !Array.isArray(am.message?.content)) return [];
      return am.message.content.filter((b) => b.type === "tool_use").map((b) => b.name);
    });
    expect(toolNames, "AskUserQuestion must be blocked by --disallowedTools").not.toContain("AskUserQuestion");
  });
});
```

- [ ] **Step 2: Run live and stabilize**

Run: `pnpm test:compat` — all 7 claude scenarios green (CC-3 is the slowest; its timeout is 150s).

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/claude.live.test.ts
git commit -m "test(compat): claude live scenarios CC-3/5/6"
```

---

### Task 6: CC-7 — stub MCP server + `--mcp-config` probe

**Files:**
- Create: `packages/vibedeckx/src/protocol/live/stub-mcp-server.ts`
- Modify: `packages/vibedeckx/src/protocol/live/claude.live.test.ts` (append)
- Test (offline, default suite): `packages/vibedeckx/src/protocol/live/stub-mcp-server.test.ts`

- [ ] **Step 1: Write the stub server**

```ts
// packages/vibedeckx/src/protocol/live/stub-mcp-server.ts
/**
 * Minimal streamable-HTTP MCP server for the CC-7 probe. Serves one tool
 * (`compat_ping`) and records every request's Authorization header so the
 * test can assert the CLI presented the exact bearer token from
 * buildMcpConfigArg. Stateless: no session ids.
 */
import http from "http";
import type { AddressInfo } from "net";

export interface StubMcpServer {
  url: string;
  authHeaders: string[];
  requests: Array<{ method: string; rpcMethod?: string }>;
  toolCalls: number;
  close: () => Promise<void>;
}

export async function startStubMcpServer(): Promise<StubMcpServer> {
  const state: Omit<StubMcpServer, "url" | "close"> = { authHeaders: [], requests: [], toolCalls: 0 };

  const server = http.createServer((req, res) => {
    state.authHeaders.push(req.headers.authorization ?? "");
    if (req.method === "GET") {
      // Server-initiated SSE stream: not supported by this stub (allowed by spec).
      res.writeHead(405, { Allow: "POST" }).end();
      state.requests.push({ method: "GET" });
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      state.requests.push({ method: "DELETE" });
      return;
    }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string } };
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      state.requests.push({ method: "POST", rpcMethod: msg.method });
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      switch (msg.method) {
        case "initialize":
          reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "vibedeckx-compat-stub", version: "1.0.0" },
          });
          return;
        case "tools/list":
          reply({ tools: [{ name: "compat_ping", description: "Returns pong. Call this to verify MCP connectivity.", inputSchema: { type: "object", properties: {} } }] });
          return;
        case "tools/call":
          state.toolCalls++;
          reply({ content: [{ type: "text", text: "pong" }] });
          return;
        default:
          // notifications (no id) get 202; unknown requests get an empty result
          if (msg.id === undefined) { res.writeHead(202).end(); return; }
          reply({});
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...state,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Offline test for the stub itself**

```ts
// packages/vibedeckx/src/protocol/live/stub-mcp-server.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStubMcpServer, type StubMcpServer } from "./stub-mcp-server.js";

describe("stub MCP server", () => {
  let stub: StubMcpServer;
  beforeAll(async () => { stub = await startStubMcpServer(); });
  afterAll(async () => { await stub.close(); });

  async function rpc(method: string, params: unknown, id?: number) {
    const res = await fetch(stub.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    return res;
  }

  it("answers initialize, tools/list, tools/call and records auth", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, 1);
    expect((await init.json()).result.serverInfo.name).toBe("vibedeckx-compat-stub");
    expect((await rpc("notifications/initialized", {})).status).toBe(202);
    const list = await rpc("tools/list", {}, 2);
    expect((await list.json()).result.tools[0].name).toBe("compat_ping");
    const call = await rpc("tools/call", { name: "compat_ping", arguments: {} }, 3);
    expect((await call.json()).result.content[0].text).toBe("pong");
    expect(stub.toolCalls).toBe(1);
    expect(stub.authHeaders.every((h) => h === "Bearer test-token")).toBe(true);
  });
});
```

- [ ] **Step 3: Append the CC-7 live scenario**

```ts
// appended to claude.live.test.ts (add imports: buildMcpConfigArg from ../../cross-remote-mcp-config.js, startStubMcpServer from ./stub-mcp-server.js)
describe.skipIf(!available)("claude live probes (mcp-config)", () => {
  it("CC-7: --mcp-config http server with bearer auth — connects and can call the tool", async () => {
    const stub = await startStubMcpServer();
    try {
      const r = await runClaudeSession({
        turns: ["Call the MCP tool compat_ping from the cross-remote server exactly once, then reply with what it returned. Do not use any other tools."],
        mcpConfigArg: buildMcpConfigArg({ url: stub.url, token: "compat-probe-token" }),
        extraArgs: MODEL_ARGS,
        recordAs: "cc7-mcp",
      });
      expect(r.outcome).toBe("ok");
      // Transport-level assertion first — its failure message distinguishes
      // "CLI never connected" (transport drift) from "agent didn't call the tool".
      expect(stub.requests.length, "claude CLI never contacted the MCP stub — --mcp-config http transport drifted?").toBeGreaterThan(0);
      expect(
        stub.authHeaders.filter(Boolean).every((h) => h === "Bearer compat-probe-token"),
        `unexpected Authorization headers: ${JSON.stringify([...new Set(stub.authHeaders)])}`,
      ).toBe(true);
      expect(stub.toolCalls, "MCP transport connected but the tool was never invoked").toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });
});
```

- [ ] **Step 4: Run offline stub test, then live, stabilize**

Run: `npx vitest run src/protocol/live/stub-mcp-server.test.ts` → PASS.
Run: `pnpm test:compat` → all claude scenarios incl. CC-7 green. CC-7 is the most upstream-fragile scenario: if the CLI's MCP handshake needs more of the protocol than the stub implements (check stderr / `--verbose` output for MCP connection errors), extend the stub minimally rather than weakening assertions; document what was needed in your report.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/
git commit -m "test(compat): CC-7 mcp-config probe with stub MCP server"
```

---

### Task 7: Codex live scenarios CX-1, CX-2, CX-6

**Files:**
- Create: `packages/vibedeckx/src/protocol/live/codex.live.test.ts`

- [ ] **Step 1: Write the scenarios**

```ts
// packages/vibedeckx/src/protocol/live/codex.live.test.ts
import { describe, expect, it } from "vitest";
import type { CodexIncoming } from "../codex/codec.js";
import { codexBinaryAvailable, compatRequired, runCodexAppServer } from "./runner.js";

const available = codexBinaryAvailable();
if (!available && compatRequired()) {
  throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no codex binary available");
}

function notifications(incoming: CodexIncoming[], method: string) {
  return incoming.filter((i) => i.kind === "notification" && i.method === method) as Array<{ method: string; params: unknown }>;
}
function items(incoming: CodexIncoming[], type: string) {
  return notifications(incoming, "item/completed")
    .map((n) => (n.params as { item?: { type?: string } })?.item)
    .filter((it): it is Record<string, unknown> & { type: string } => !!it && it.type === type);
}

describe.skipIf(!available)("codex live probes (core)", () => {
  it("CX-1+CX-2: handshake yields thread id; turn yields final agentMessage and turn/completed", async () => {
    const r = await runCodexAppServer({
      turns: ["Reply with the word PONG and nothing else. Do not run any commands."],
      recordAs: "cx1-2-handshake-turn",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    expect(r.threadId, "thread/start response no longer carries result.thread.id").toBeTruthy();
    const finals = items(r.incoming, "agentMessage");
    expect(finals.length, "no agentMessage item/completed").toBeGreaterThan(0);
    expect(notifications(r.incoming, "turn/completed").length).toBeGreaterThan(0);
  });

  it("CX-6: thread/tokenUsage/updated carries last.inputTokens/outputTokens", async () => {
    const r = await runCodexAppServer({
      turns: ["Reply with the word HI and nothing else."],
      recordAs: "cx6-tokenusage",
    });
    expect(r.outcome).toBe("ok");
    const usages = notifications(r.incoming, "thread/tokenUsage/updated");
    expect(usages.length, "no tokenUsage notification").toBeGreaterThan(0);
    const last = (usages[usages.length - 1].params as { tokenUsage?: { last?: { inputTokens?: unknown; outputTokens?: unknown } } })?.tokenUsage?.last;
    expect(typeof last?.inputTokens).toBe("number");
    expect(typeof last?.outputTokens).toBe("number");
  });
});
```

- [ ] **Step 2: Run live and stabilize**

Run: `pnpm test:compat` (codex file only if preferred: `pnpm test:compat src/protocol/live/codex.live.test.ts`). All green. If codex auth fails, the runner's `auth_error` outcome makes it visible — report it rather than working around.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/codex.live.test.ts
git commit -m "test(compat): codex live scenarios CX-1/2/6"
```

---

### Task 8: Codex live scenarios CX-3, CX-4, CX-5, CX-7

**Files:**
- Modify: `packages/vibedeckx/src/protocol/live/codex.live.test.ts` (append; add imports as needed: `buildCodexExecCommand` from `../codex/cli.js`, `detectBinary` from `../shared/binary.js`, `runOneShot` from `./runner.js`, `mkdtempSync`/`readFileSync`/`writeFileSync` from `fs`, `tmpdir` from `os`, `path`)

- [ ] **Step 1: Append the scenarios**

```ts
describe.skipIf(!available)("codex live probes (items & exec)", () => {
  it("CX-3: commandExecution item carries command and aggregatedOutput", async () => {
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command and nothing else: echo vibedeckx-probe. Then reply DONE."],
      recordAs: "cx3-command",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const cmds = items(r.incoming, "commandExecution");
    expect(cmds.length, "no commandExecution item").toBeGreaterThan(0);
    expect(typeof cmds[0].command).toBe("string");
    expect(String(cmds[0].command)).toContain("vibedeckx-probe");
  });

  it("CX-4: fileChange item carries changes[].path", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-cx4-"));
    const r = await runCodexAppServer({
      turns: ["Create a file named probe.txt containing the single word hello. Then reply DONE."],
      cwd,
      recordAs: "cx4-filechange",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const changes = items(r.incoming, "fileChange");
    expect(changes.length, "no fileChange item — codex may have used commandExecution; strengthen the prompt (e.g. 'use your file editing capability, not shell commands')").toBeGreaterThan(0);
    const first = (changes[0].changes as Array<{ path?: unknown }> | undefined)?.[0];
    expect(typeof first?.path).toBe("string");
  });

  it("CX-5: $/cancelRequest interrupts an in-flight turn", async () => {
    let cancelled = false;
    const r = await runCodexAppServer({
      turns: ["Run this shell command: sleep 60. Then reply DONE."],
      timeoutMs: 60_000,
      recordAs: "cx5-cancel",
      onIncoming: (inc, ctl) => {
        // Cancel as soon as the turn shows activity (first item/completed or any item event)
        if (!cancelled && inc.kind === "notification" && inc.method === "item/completed") {
          cancelled = true;
          ctl.cancelTurn();
        }
      },
    });
    // Outcome must not be a 60s timeout: the cancel must terminate the turn,
    // via error response for the turn id or a non-completed turn/completed.
    expect(r.outcome, `cancel did not terminate the turn (stderr: ${r.stderr.slice(0, 300)})`).toBe("ok");
    const finals = items(r.incoming, "agentMessage").filter((i) => i.phase === "final_answer");
    const turnErrors = r.incoming.filter((i) => i.kind === "error_response");
    const completions = notifications(r.incoming, "turn/completed")
      .map((n) => (n.params as { turn?: { status?: string } })?.turn?.status);
    const terminatedAbnormally = turnErrors.length > 0 || completions.some((s) => s !== "completed") || finals.length === 0;
    expect(terminatedAbnormally, `expected interrupted turn; statuses=${completions.join(",")}`).toBe(true);
  });

  it("CX-7: exec mode writes --output-last-message file", async () => {
    const outFile = path.join(mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-cx7-")), "last.txt");
    const cmd = buildCodexExecCommand(detectBinary("codex"), "Reply with the word PONG and nothing else. Do not run any commands.", outFile);
    const r = await runOneShot(cmd, { timeoutMs: 180_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const lastMessage = readFileSync(outFile, "utf-8").trim();
    expect(lastMessage.length, "--output-last-message file empty or missing").toBeGreaterThan(0);
  });
});
```

Note for CX-5: if the real CLI responds to `$/cancelRequest` differently than anticipated (e.g. emits a distinct notification), capture the actual behavior in the recording, adjust ONLY the `terminatedAbnormally` disjunction to include the observed terminal signal, and document the observed shape in your report — the invariant "cancel terminates the turn without waiting for sleep 60" must hold.

- [ ] **Step 2: Run live and stabilize**

Run: `pnpm test:compat src/protocol/live/codex.live.test.ts` — all green.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/codex.live.test.ts
git commit -m "test(compat): codex live scenarios CX-3/4/5/7"
```

---

### Task 9: CX-8 — approval round-trip under `approvalPolicy: on-request`

**Files:**
- Modify: `packages/vibedeckx/src/protocol/live/codex.live.test.ts` (append; add import `buildApprovalResponse` from `../codex/codec.js`)

Production always uses `approvalPolicy: "never"`; this probe deliberately uses `on-request` to exercise the approval handlers that exist in `codex-provider.ts` (`item/commandExecution/requestApproval` → reply `{decision}`). Documented probe-only deviation.

- [ ] **Step 1: Append the scenario**

```ts
describe.skipIf(!available)("codex live probes (approval round-trip)", () => {
  it("CX-8: on-request approval — server request arrives, accept reply lets the command run", async () => {
    const approvalsSeen: Array<{ method: string; id: string | number }> = [];
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command: echo approval-probe. Then reply DONE."],
      threadStartParams: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      timeoutMs: 120_000,
      recordAs: "cx8-approval",
      onIncoming: (inc, ctl) => {
        if (inc.kind === "server_request" && inc.method.endsWith("requestApproval")) {
          approvalsSeen.push({ method: inc.method, id: inc.id });
          ctl.reply(buildApprovalResponse(String(inc.id), "accept"));
        }
      },
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    expect(approvalsSeen.length, "no requestApproval server request under approvalPolicy=on-request").toBeGreaterThan(0);
    expect(approvalsSeen[0].method).toBe("item/commandExecution/requestApproval");
    // accept reply must unblock the command: expect the commandExecution item afterwards
    const cmds = items(r.incoming, "commandExecution");
    expect(cmds.length, "approval accepted but command never executed — decision format drifted?").toBeGreaterThan(0);
  });

  it("CX-8b: decline reply prevents execution", async () => {
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command: echo should-not-run. Then reply DONE."],
      threadStartParams: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      timeoutMs: 120_000,
      recordAs: "cx8b-decline",
      onIncoming: (inc, ctl) => {
        if (inc.kind === "server_request" && inc.method.endsWith("requestApproval")) {
          ctl.reply(buildApprovalResponse(String(inc.id), "decline"));
        }
      },
    });
    expect(r.outcome).toBe("ok");
    const cmds = items(r.incoming, "commandExecution").filter((c) => String(c.aggregatedOutput ?? "").includes("should-not-run"));
    expect(cmds.length, "declined command still produced output").toBe(0);
  });
});
```

Note: the UI sends the literal decision strings `"accept"`/`"decline"` (`apps/vibedeckx-ui/components/agent/approval-request.tsx`) — this probe validates those exact strings against the real CLI. If the CLI rejects them (e.g. expects `"approved"`), that is a REAL FINDING about production code, not a test bug: report it prominently, do not change the strings to make the test pass.

- [ ] **Step 2: Run live and stabilize**

Run: `pnpm test:compat src/protocol/live/codex.live.test.ts` — all green (or the decision-string finding reported).

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/live/codex.live.test.ts
git commit -m "test(compat): CX-8 approval round-trip probes"
```

---

### Task 10: Grow offline fixtures from live recordings

**Files:**
- Modify: `packages/vibedeckx/src/protocol/codex/__fixtures__/app-server-session.jsonl`
- Modify: `packages/vibedeckx/src/protocol/claude-code/__fixtures__/stream-session.jsonl`
- Modify: `packages/vibedeckx/src/protocol/contract-check.test.ts` (only if new message kinds need schema-map entries)

- [ ] **Step 1: Curate recordings into fixtures**

From `src/protocol/live/recordings/` (produced by Tasks 4–9), append REAL captured lines to the fixture corpora:
- Codex: at least one `reasoning` item line and, if present in any recording, `plan` / `webSearch` / `mcpToolCall` item lines; one `item/commandExecution/requestApproval` server request from cx8; one real `thread/start` response. Target: KnownThreadItem coverage grows from 3 variants toward all that the real CLI actually emitted.
- Claude: one real assistant line with a `thinking` block if any recording contains one; one real `-p` mode result line with `result` text field.
Strip nothing; append lines verbatim (fixtures are real protocol samples — that is their value). Add a comment line? NO — JSONL must stay pure JSON lines; provenance goes in the commit message (`captured from claude 2.1.205 / codex-cli 0.144.1`).

- [ ] **Step 2: Run the offline contract tests**

Run: `npx vitest run src/protocol/contract-check.test.ts`
The corpus tests iterate every fixture line: new lines must classify and validate. If a new line's kind has no schema-map entry in the test (e.g. a codex `error_response`), extend the test's mapping the same way existing kinds are handled. If a new REAL line fails validation, that is a contract gap discovered by live data: fix the schema in `codex/schema.ts`/`claude-code/schema.ts` (loosen/extend to match reality), never delete the fixture line.

- [ ] **Step 3: Full suite, typecheck, commit**

```bash
pnpm test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
git add packages/vibedeckx/src/protocol/
git commit -m "test(protocol): grow fixture corpora from live recordings (claude 2.1.205, codex 0.144.1)"
```

---

### Task 11: Drift-watch CI — `agent-versions.json` + `protocol-compat.yml`

**Files:**
- Create: `.github/agent-versions.json`
- Create: `.github/workflows/protocol-compat.yml`

- [ ] **Step 1: Seed the version registry**

Determine current versions: `claude --version` and `codex --version` (expected 2.1.205 / 0.144.1 — use actual output), then:

```json
{
  "claude-code": { "package": "@anthropic-ai/claude-code", "pinned": "2.1.205", "lastSeen": "2.1.205" },
  "codex": { "package": "@openai/codex", "pinned": "0.144.1", "lastSeen": "0.144.1" }
}
```

- [ ] **Step 2: Research codex headless auth**

Run `codex login --help` and check for API-key auth (`codex login --api-key` / `OPENAI_API_KEY` env / `preferred_auth_method` config). Record findings in your report. Wire the workflow accordingly; if headless codex auth is NOT supported, set `continue-on-error: true` on codex matrix cells and add a workflow-summary note (spec §5 fallback).

- [ ] **Step 3: Create the workflow**

```yaml
# .github/workflows/protocol-compat.yml
name: protocol-compat

on:
  workflow_dispatch:
    inputs:
      force_matrix:
        description: "Run the live matrix even if no new version detected"
        type: boolean
        default: true
  schedule:
    - cron: "17 3 * * *" # daily; version-check only — matrix runs when a new version appears

jobs:
  version-check:
    runs-on: ubuntu-latest
    outputs:
      run_matrix: ${{ steps.check.outputs.run_matrix }}
      claude_latest: ${{ steps.check.outputs.claude_latest }}
      codex_latest: ${{ steps.check.outputs.codex_latest }}
    steps:
      - uses: actions/checkout@v4
      - id: check
        run: |
          CLAUDE_LATEST=$(npm view @anthropic-ai/claude-code version)
          CODEX_LATEST=$(npm view @openai/codex version)
          CLAUDE_SEEN=$(jq -r '."claude-code".lastSeen' .github/agent-versions.json)
          CODEX_SEEN=$(jq -r '.codex.lastSeen' .github/agent-versions.json)
          echo "claude_latest=$CLAUDE_LATEST" >> "$GITHUB_OUTPUT"
          echo "codex_latest=$CODEX_LATEST" >> "$GITHUB_OUTPUT"
          if [ "${{ inputs.force_matrix }}" = "true" ] || [ "$CLAUDE_LATEST" != "$CLAUDE_SEEN" ] || [ "$CODEX_LATEST" != "$CODEX_SEEN" ]; then
            echo "run_matrix=true" >> "$GITHUB_OUTPUT"
          else
            echo "run_matrix=false" >> "$GITHUB_OUTPUT"
          fi

  live-matrix:
    needs: version-check
    if: needs.version-check.outputs.run_matrix == 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - agent: claude-code
            package: "@anthropic-ai/claude-code"
            file: claude.live.test.ts
            channel: pinned
          - agent: claude-code
            package: "@anthropic-ai/claude-code"
            file: claude.live.test.ts
            channel: latest
          - agent: codex
            package: "@openai/codex"
            file: codex.live.test.ts
            channel: pinned
          - agent: codex
            package: "@openai/codex"
            file: codex.live.test.ts
            channel: latest
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      VIBEDECKX_COMPAT_REQUIRED: "1"
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
      - name: Resolve agent version
        id: ver
        run: |
          if [ "${{ matrix.channel }}" = "pinned" ]; then
            V=$(jq -r '."${{ matrix.agent }}".pinned' .github/agent-versions.json)
          else
            V=$(npm view ${{ matrix.package }} version)
          fi
          echo "version=$V" >> "$GITHUB_OUTPUT"
      - name: Install agent CLI
        run: npm install -g ${{ matrix.package }}@${{ steps.ver.outputs.version }}
      - name: Live probes (${{ matrix.agent }} @ ${{ steps.ver.outputs.version }})
        run: pnpm --filter vibedeckx test:compat src/protocol/live/${{ matrix.file }}

  report-drift:
    needs: [version-check, live-matrix]
    if: always() && needs.live-matrix.result == 'failure'
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const title = `protocol-compat: live matrix failure (claude latest ${{ needs.version-check.outputs.claude_latest }}, codex latest ${{ needs.version-check.outputs.codex_latest }})`;
            const existing = await github.rest.search.issuesAndPullRequests({
              q: `repo:${context.repo.owner}/${context.repo.repo} is:issue is:open in:title "protocol-compat: live matrix failure"`,
            });
            if (existing.data.total_count > 0) {
              core.info("open drift issue already exists; skipping");
              return;
            }
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title,
              body: [
                "The protocol-compat live matrix failed.",
                "",
                `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
                "",
                "- `pinned` cell failing ⇒ likely our bug (or CI env).",
                "- `latest` cell failing ⇒ likely upstream protocol drift — check the job log for contract IDs (CC-*/CX-*) and consumer pointers.",
                "",
                "Contracts live in `packages/vibedeckx/src/protocol/*/schema.ts`; the failing scenario names the guarded behavior.",
              ].join("\n"),
              labels: ["protocol-compat"],
            });
```

Apply Step 2's findings: if codex headless auth is unsupported, add `continue-on-error: true` to the two codex matrix cells (via an `include` field `experimental: true` + `continue-on-error: ${{ matrix.experimental || false }}`).

- [ ] **Step 4: Validate and commit**

```bash
npx --yes @action-validator/cli .github/workflows/protocol-compat.yml || echo "validator unavailable — YAML reviewed manually"
git add .github/agent-versions.json .github/workflows/protocol-compat.yml
git commit -m "ci: protocol drift-watch — version detection + pinned/latest live matrix"
```

Note: the workflow cannot be exercised from this environment (needs GitHub runners + secrets). The report must state this residual explicitly: first `workflow_dispatch` run validates it; secrets `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` must be configured by the repo owner.

---

## Verification (whole plan)

```bash
pnpm test            # offline suite green (includes runner + stub + frontend-tools tests)
pnpm test:compat     # full live sweep green on local claude 2.1.205 + codex 0.144.1
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Residuals to state in the final report: CI workflow unproven until first dispatch (secrets required); codex headless auth per Task 11 Step 2 findings.

## Out of scope

Nested unknown-key detection; async version probe; auto-bump-pinned PRs; shared frontend constants package.
