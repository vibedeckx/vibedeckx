# Agent Protocol Compatibility Layer & Test Suite — Design

- **Date:** 2026-07-12
- **Branch:** dev1
- **Status:** Approved (design reviewed in session)

## 1. Problem

Vibedeckx spawns the Claude Code CLI (`claude`) and the OpenAI Codex CLI (`codex`) as child
processes and depends entirely on their external protocols (CLI flags, stream-json / JSON-RPC
wire formats, and behavioral conventions). Today:

- There is **no version detection or pinning**: the npx fallback is `npx -y @anthropic-ai/claude-code`
  / `npx -y @openai/codex` — always latest. A new upstream release can silently change the
  protocol and break sessions in production.
- Protocol knowledge is **scattered and duplicated**. Claude Code's stream-json is parsed in two
  independent places (`providers/claude-code-provider.ts` and `process-manager.ts`), binary
  detection is implemented twice, and protocol string literals (`task_started`, `--verbose`, …)
  are sprinkled across `agent-session-manager.ts`, `process-manager.ts`, and the providers.
- The only existing test is the isolated `codex-provider.test.ts`; no test framework is
  configured in the repo.

**Goal:** detect upstream protocol drift *before* it breaks users, and make the protocol surface
a single, explicit, testable module per agent.

**Non-goals:** changing the version-pinning strategy (npx latest stays); a shared frontend
constants package (optional follow-up); testing agent *intelligence* or output content — we
assert protocol *shape*, never text.

## 2. Dependency inventory (what the contracts must encode)

### 2.1 Claude Code (`claude`)

**CLI invocation** (`providers/claude-code-provider.ts`, `process-manager.ts`):
`--output-format=stream-json`, `--input-format=stream-json`, `--permission-mode=plan`,
`--dangerously-skip-permissions`, `--disallowedTools AskUserQuestion`, `--verbose`,
`--mcp-config <inline json>` (http server + `Authorization: Bearer` header), `-p '<prompt>'`
(one-shot executor mode). Binary detection: `which`/`where claude`, npx fallback.

**Output protocol** (stream-json, newline-delimited):
- `type: user | assistant | system | result`
- assistant `message.content[]` blocks: `text {text}`, `tool_use {id, name, input}`,
  `tool_result {tool_use_id, content}`, `thinking {thinking}`
- system subtypes: `task_started {task_id, task_type, description}`,
  `task_notification {task_id, status}`, `task_updated {task_id, patch.status}` — the
  background-task ledger in `agent-session-manager.ts` is built entirely on these
- result: `subtype (success|error)`, `error`, `duration_ms`, `cost_usd`, `result` (final text,
  read only by the process-manager path)
- Bash `tool_use.input.run_in_background === true` is read as a background-spawn hint

**Input protocol** (stdin NDJSON): `{"type":"user","message":{"role":"user","content":…}}`;
content blocks `text` and `image {source:{type:"base64",media_type,data}}`.

**Behavioral assumptions** (the easiest things for a new version to silently break):
1. The stream-json process **stays alive after `result`**, waiting on stdin for the next turn.
2. `--disallowedTools AskUserQuestion` is honored.
3. Task-lifecycle system events are emitted only with `--verbose`.
4. Plan files are written under `.claude/plans/` (frontend ExitPlanMode fallback parsing).
5. `--mcp-config` accepts an inline JSON blob with an `http`-type server and bearer header.

### 2.2 Codex (`codex`)

**app-server mode** (JSON-RPC 2.0 over stdio, newline-delimited), in
`providers/codex-provider.ts`:
- We send: `initialize {clientInfo}`, `thread/start {sandbox, approvalPolicy}`,
  `turn/start {threadId, input[]}` (items `text {text}` / `image {url: data-uri}`),
  `$/cancelRequest {id}` (interrupt), and JSON-RPC *result* replies to approval requests
  `{id, result: {decision}}` (decisions: `accept` / `decline` strings from the UI).
- We receive: `thread/start` response (`result.thread.id`); notifications
  `item/completed {turnId, item}` with item types `agentMessage {phase, text}`,
  `reasoning {summary|content}`, `userMessage`, `commandExecution {id, command,
  aggregatedOutput}`, `fileChange {changes[].{path,diff,kind}, status}`, `plan {text}`,
  `webSearch {query}`, `mcpToolCall {tool, arguments, result, error}`,
  `collabAgentToolCall {tool, prompt}`; `turn/completed {turn.{id,status,error}}`;
  `thread/tokenUsage/updated {tokenUsage.last.{inputTokens,outputTokens}}`; server requests
  `item/commandExecution/requestApproval {command, cwd}`,
  `item/fileChange/requestApproval {changes}`, `item/tool/requestUserInput {questions}`.
- Enums: `sandbox: read-only | workspace-write | danger-full-access`,
  `approvalPolicy: untrusted | on-failure | on-request | never` (prod uses `never`).
- Lifecycle: init+thread/start sent back-to-back at spawn; first turn buffered until
  `thread.id` arrives; dormant-wake resets provider state (else "Not initialized").

**exec mode** (`process-manager.ts`):
`codex --dangerously-bypass-approvals-and-sandbox exec '<prompt>' --output-last-message <file>`;
the last-message file is read back on exit (tolerates absence).

Note: `.dev/codex-protocol-schema/` does not exist in this worktree; all Codex protocol shapes
are currently hardcoded inline in `codex-provider.ts`. This design makes `protocol/codex/`
the canonical replacement for that missing schema reference.

## 3. Architecture

### 3.1 Runtime protocol layer = test contract (single source of truth)

New module tree in the backend package:

```
packages/vibedeckx/src/protocol/
  claude-code/
    schema.ts        # zod schemas for every stream-json message/block/subtype + enum constants
    codec.ts         # parseLine(raw) -> typed message | unknown; serializeUserInput(...)
    cli.ts           # arg builders: session mode, -p executor mode, --mcp-config injection
    index.ts
  codex/
    schema.ts        # zod schemas: JSON-RPC envelope, methods, item types, approval requests,
                     # sandbox/approvalPolicy enums
    codec.ts         # RPC framing; discriminate request/response/notification; id bookkeeping
    cli.ts           # app-server args, exec-mode args
    index.ts
  shared/
    binary.ts        # detectBinary (which/where + npx fallback) — single implementation
```

Contract metadata: each schema (or schema group) carries a stable contract ID
(e.g. `CC-OUT-task_started`, `CX-NOTIF-item_completed`) and a `consumers` list of
`file:line`-style references to the code that depends on it, so a compat failure directly
names the affected code.

### 3.2 Consumer refactors (protocol knowledge moves up; domain translation stays put)

- `providers/claude-code-provider.ts` / `providers/codex-provider.ts`: no more raw
  `JSON.parse` + field discrimination; they consume typed messages from `codec.ts` and only
  translate protocol messages → vibedeckx domain events (`ParsedAgentEvent`). Spawn config
  delegates to `cli.ts` + `shared/binary.ts`.
- `process-manager.ts`: delete its duplicate stream-json parser, duplicate `detectBinary`,
  and `buildPromptCommand`; use `protocol/*/cli.ts` + `codec.ts`. Its terminal-rendering
  logic keeps consuming typed messages.
- `agent-session-manager.ts`: task-ledger string literals (`task_started`,
  `task_notification`, `task_updated`, terminal statuses) become constants exported from
  `protocol/claude-code/schema.ts`.
- `agent-types.ts`: the hand-written `Claude*Message` interfaces are replaced by
  `z.infer` types re-exported from the protocol layer.
- **Frontend is NOT refactored** in this effort (bundling a backend package into the Next
  static export is risky). Instead, the contract layer exports the list of tool names the
  frontend special-cases (`agent-message.tsx`), and a live scenario asserts "tool names
  emitted by the CLI ⊆ known list". A shared constants package is a possible follow-up.

### 3.3 Lenient runtime, strict tests

From each schema we derive two validation modes:

- **Runtime (lenient):** unknown fields pass through; unknown message/item types produce a
  warn log (extending the existing "PROTOCOL DRIFT?" logging) and a generic fallback event —
  never a crash.
- **Tests (strict):** a field we consume that is missing or type-changed = **FAIL**; fields
  added upstream that we don't consume = **WARN**, recorded in the compat report.

## 4. Test layers

Test framework: **vitest** (first test framework in the repo; native ESM + TS). Tests live in
`packages/vibedeckx/test/`.

### 4.1 Offline contract tests (runs in PR CI — free, deterministic)

- Recorded raw transcripts (`test/protocol/fixtures/…`) replayed through `codec.ts` +
  strict schemas + the provider translation, asserting the emitted `ParsedAgentEvent`s.
- The existing `codex-provider.test.ts` assertions migrate here as the first fixtures.
- Fixtures are refreshed automatically from successful live-probe runs (raw transcripts are
  saved as artifacts and can be committed).

### 4.2 Live probe scenarios ("canary" — spawns the real CLI)

A probe runner (`test/protocol/live/runner.ts`) spawns the real CLI with our exact `cli.ts`
args, drives stdin, collects every raw line, validates each against the strict schemas, and
runs per-scenario assertions. Prompts are strongly constrained ("run exactly `echo probe`
using the Bash tool and nothing else"); assertions are structural, never textual. Each
scenario gets a timeout and one retry. Cheapest usable models (`--model` haiku-class for
claude; codex config equivalent) — a full run costs cents.

**Claude Code scenarios:**
| ID | Scenario | Guards |
|---|---|---|
| CC-1 | Basic turn: prompt → assistant text → result | core parse path |
| CC-2 | Forced tool call → tool_use/tool_result shapes | tool rendering, messageIndex logic |
| CC-3 | `run_in_background` → `task_started` + `task_notification` | background-task ledger |
| CC-4 | Multi-turn liveness: write stdin after `result`, get a reply | keep-alive session model |
| CC-5 | Plan mode → ExitPlanMode tool_use (+ `.claude/plans/` write if applicable) | plan/edit switch |
| CC-6 | `--disallowedTools AskUserQuestion` honored | headless stdin safety |
| CC-7 | `--mcp-config` against a local stub HTTP MCP server; assert bearer header received + tool listable | cross-remote MCP gateway |
| CC-8 | `-p` executor mode → result with final text | prompt executor / scheduler |

**Codex scenarios:**
| ID | Scenario | Guards |
|---|---|---|
| CX-1 | initialize → thread/start → `result.thread.id` | session handshake |
| CX-2 | turn/start → `item/completed agentMessage(final_answer)` + `turn/completed` | core turn loop |
| CX-3 | commandExecution item fields | terminal rendering |
| CX-4 | fileChange item fields | file-change rendering |
| CX-5 | `$/cancelRequest` interrupts an in-flight turn | stop button |
| CX-6 | `thread/tokenUsage/updated` fields | token display |
| CX-7 | exec mode + `--output-last-message` file written | prompt executor / scheduler |
| CX-8 | approval round-trip with `approvalPolicy: on-request` (accept + decline) | approval handlers (dormant in prod but wired end-to-end) |

### 4.3 CI workflow (`.github/workflows/protocol-compat.yml`)

- **Triggers:** manual `workflow_dispatch` first; a version-detection job
  (`npm view <pkg> version` vs last-seen, stored in-repo) runs on a daily cron and only
  launches the live matrix when a new upstream version appears. A daily full live run is
  enabled later, once flakiness is proven low.
- **Matrix:** `{claude-code, codex} × {pinned, latest}` — pinned = the version we last
  verified (recorded in-repo); pinned failing ⇒ our bug; latest failing ⇒ upstream drift.
- **On drift:** open a GitHub issue containing the failed contract IDs, the consumer
  `file:line` references, and the raw offending transcript lines.
- **Secrets:** `ANTHROPIC_API_KEY` + OpenAI credentials. Offline layer (4.1) runs in normal
  PR CI with no secrets.

## 5. Ancillary production change

At spawn time, run `claude --version` / `codex --version` once (cached per binary path) and
write it to the session log — today failures cannot be attributed to an agent version.

## 6. Implementation phases (each independently mergeable)

1. Introduce vitest; extract `protocol/codex/` from `codex-provider.ts`; migrate
   `codex-provider.test.ts` as the first offline tests.
2. Extract `protocol/claude-code/`; **unify the duplicate parser + binary detection in
   `process-manager.ts`** (highest-risk step — regression-test terminal/scheduler flows).
3. Strict-mode schemas + contract IDs/consumer metadata + recorded fixtures + offline
   contract tests wired into PR CI.
4. Live probe runner + all CC-*/CX-* scenarios (incl. local stub MCP server), runnable
   locally.
5. CI workflow: version detection, pinned×latest matrix, auto-issue on drift.
6. `--version` capture in session logs.

## 7. Risks

- **Process-manager parser unification** touches the terminal/scheduler paths; mitigated by
  fixture tests written *before* the refactor (record current behavior first) and phase
  isolation.
- **Live-test flakiness/cost:** structural-only assertions, constrained prompts, retries,
  cheap models, manual-dispatch-first rollout.
- **Upstream auth changes** (CLI login flows) can break CI independently of protocol drift;
  the runner distinguishes "spawn/auth failed" from "contract violated" in its report.
