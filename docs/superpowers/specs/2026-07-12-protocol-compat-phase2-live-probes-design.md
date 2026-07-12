# Agent Protocol Compat — Phase 2: Live Probes & Drift-Watch CI — Design

- **Date:** 2026-07-12
- **Branch:** dev1
- **Status:** Approved (design reviewed in session)
- **Builds on:** `docs/superpowers/specs/2026-07-12-agent-protocol-compat-design.md` (phases 1–3+6 implemented at commits a1f9f55..2183851: `src/protocol/` layer, offline contract tests, version logging, PR CI)

## 1. Goal

Implement spec phases 4–5: canary tests that spawn the **real** `claude` / `codex` CLIs,
drive the CC-1..8 / CX-1..8 scenarios, validate every protocol line against the phase-1
contracts, and a CI workflow that detects new upstream releases and runs a
pinned×latest matrix — so upstream protocol drift is caught before it breaks users.

**Environment facts (verified on this machine):** codex is authenticated (ChatGPT
login, `~/.codex/auth.json`); claude CLI 2.1.205 is authenticated and supports
`--model`; codex-cli is 0.144.1. Live probes are runnable locally today.

**Non-goals:** asserting agent output *content* (structure only); nested unknown-key
drift detection (top-level WARN stays, documented); async version probe; shared
frontend constants package.

## 2. Test-suite split & entrypoints

`pnpm test` must stay free and deterministic. Vitest currently runs with no config
file, so introduce two:

- `packages/vibedeckx/vitest.config.ts` — default suite; excludes `**/*.live.test.ts`.
- `packages/vibedeckx/vitest.live.config.ts` — includes only `src/protocol/live/**/*.live.test.ts`;
  `fileParallelism: false` (serial — one CLI at a time for cost/auth sanity),
  `testTimeout: 120_000`.

Scripts in `packages/vibedeckx/package.json`:

```jsonc
"test":        "vitest run",                                  // uses vitest.config.ts
"test:compat": "vitest run --config vitest.live.config.ts"    // the live entrypoint
```

`pnpm test:compat` is the single entrypoint shared by local runs and CI. The CI
workflow controls *which CLI version* is installed; the script only controls *how to
probe it*. This also enables manual pre-checks: `npm i -g @anthropic-ai/claude-code@next && pnpm test:compat`.

**Gating:** each live describe-block skips with an explanatory message when its binary
or auth is unavailable (`describe.skipIf`). When `VIBEDECKX_COMPAT_REQUIRED=1` (set in
CI), a would-be skip becomes a failure — no silent green.

## 3. Live probe runner (`src/protocol/live/runner.ts`)

A non-test harness module. Both drivers spawn via the **production builders**
(`protocol/*/cli.ts`) — probing the exact invocation vibedeckx uses — with
probe-only extra args appended after the production args (e.g. `--model haiku` for
claude cost control; appending does not alter the contract args under test).

- `runClaudeSession(opts)` — spawn `buildClaudeSessionSpawnConfig(...)` + extras;
  write turns via `serializeUserInput`; collect stdout lines until a `result` message
  (or timeout); supports multi-turn (write again after `result`, CC-4) and plan mode.
- `runCodexAppServer(opts)` — spawn `buildCodexAppServerSpawnConfig(...)`; drive
  `initialize`/`thread/start`/`turn/start` via the codec builders; collect until
  `turn/completed` (or timeout); supports `$/cancelRequest` (CX-5) and replying to
  server requests (CX-8). Accepts an optional `threadStartParams` override — CX-8
  needs `approvalPolicy: "on-request"`, a documented probe-only deviation from the
  production `"never"`.
- `runOneShot(cmd)` — shell-run the exec/`-p` commands (CC-8, CX-7).

**Per-line validation:** every received line is classified by the production codecs
and validated against the matching phase-1 contract schema via `checkContract`.
A FAIL carries the contract ID + consumers; unknown keys accumulate into a WARN
summary printed at suite end.

**Failure taxonomy** (spec §7 requirement): the runner distinguishes
`spawn_error` / `auth_error` (process exits or emits auth-pattern stderr before the
first valid protocol line) / `contract_violation` / scenario assertion failure —
so a CI red is immediately attributable.

**Recordings:** every run writes the raw transcript to
`src/protocol/live/recordings/<scenario>-<n>.jsonl` (gitignored). Curated recordings
are copied into `__fixtures__/` to grow the offline corpus — closing the phase-1
carry-in that only 3/9 codex item variants have fixtures.

**Harness self-test:** the runner's own logic (line collection, timeout, failure
taxonomy, validation wiring) is unit-tested offline against a fake-CLI node script
that replays canned stream-json/JSON-RPC — the harness must not itself be testable
only with money.

## 4. Scenarios

As specified in the phase-1 design §4.2 (same tables, same guards): CC-1 basic turn,
CC-2 forced tool call, CC-3 `run_in_background` → task lifecycle events, CC-4
multi-turn liveness, CC-5 plan mode → ExitPlanMode, CC-6 `--disallowedTools` honored,
CC-7 `--mcp-config` against a local stub, CC-8 `-p` mode; CX-1 handshake → thread id,
CX-2 turn → final agentMessage + turn/completed, CX-3 commandExecution fields, CX-4
fileChange fields, CX-5 cancel, CX-6 tokenUsage, CX-7 exec + `--output-last-message`,
CX-8 approval round-trip (accept + decline) under `on-request`.

Prompts are strongly constrained; assertions structural; one retry per scenario.
Scenario files: `src/protocol/live/claude.live.test.ts`, `codex.live.test.ts`
(split further only if a file grows unwieldy).

**CC-7 stub MCP server** (`src/protocol/live/stub-mcp-server.ts`): a minimal
streamable-HTTP MCP server on `127.0.0.1:<random>` implementing `initialize`,
`notifications/initialized`, `tools/list` (one tool `compat_ping`), `tools/call`.
It records every request's `Authorization` header. Assertions: claude connected with
the exact `Bearer <token>` we injected via `buildMcpConfigArg`, and the scenario
prompt gets the agent to call `compat_ping` (tool_use observed). This is the most
upstream-fragile scenario; its failure message must say whether the transport
connected at all vs. the tool never being called.

## 5. Drift-watch CI (`.github/workflows/protocol-compat.yml`)

- **Version registry:** `.github/agent-versions.json` —
  `{ "claude-code": { "pinned": "<verified>", "lastSeen": "<latest observed>" }, "codex": {...} }`.
  Seed `pinned`/`lastSeen` with the versions verified on this branch (2.1.205 / 0.144.1).
- **Jobs:**
  1. `version-check` (daily cron + on dispatch): `npm view <pkg> version`, compare to
     `lastSeen`. Unchanged → stop. Changed → update lastSeen (commit to a branch or
     artifact) and trigger `live-matrix`.
  2. `live-matrix` (also directly runnable via `workflow_dispatch`):
     matrix `{claude-code, codex} × {pinned, latest}`; each cell
     `npm i -g <pkg>@<version>` then `VIBEDECKX_COMPAT_REQUIRED=1 pnpm test:compat`
     (filtered to that agent's file). `pinned` failing ⇒ our bug; `latest` failing ⇒
     upstream drift.
  3. `on-failure`: `actions/github-script` opens an issue titled with the agent +
     version, containing the failed contract IDs, consumer `file:line` pointers, and
     offending raw lines (from the runner's report output).
- **Secrets:** `ANTHROPIC_API_KEY` (claude CLI headless auth) and `OPENAI_API_KEY`
  (codex API-key auth mode). The implementation must verify codex's headless
  API-key auth flag/config on the pinned version; if headless codex auth proves
  infeasible in CI, the codex cells are marked `continue-on-error` with an issue
  noting the limitation, and codex coverage stays local-manual.
- **Rollout:** `workflow_dispatch` only at first; enable the cron after the matrix
  has run clean a few times. Auto-bump-pinned PRs are a later nicety, not in scope.

## 6. Phase-1 carry-ins folded into this phase

1. **Two-way `FRONTEND_RENDERED_TOOLS` check** — an offline unit test parses
   `apps/vibedeckx-ui/components/agent/agent-message.tsx` (regex over the source; the
   frontend is not importable from backend tests) and asserts the special-cased tool
   names ⊆ `FRONTEND_RENDERED_TOOLS`, so a one-sided edit fails CI.
2. **`which`/`where` timeout** — add the missing `timeout: 5000` in
   `protocol/shared/binary.ts` `detectBinary`.
3. **Codex fixture variants** — grow `__fixtures__/app-server-session.jsonl` from live
   recordings (reasoning, plan, webSearch, mcpToolCall at minimum).

Deferred (unchanged): nested unknown-key detection, async version probe.

## 7. Risks

- **Flakiness:** serial execution, constrained prompts, structural assertions, one
  retry, generous timeouts. First rollout is manual-dispatch so flakes don't page.
- **Cost:** claude scenarios pinned to a haiku-class model via appended `--model`;
  codex model selection is attempted via thread/start param or config flag during
  implementation — if unsupported, default-model cost is accepted (prompts are tiny).
- **Auth drift:** CLIs change login flows; the runner's `auth_error` class keeps that
  distinguishable from protocol drift.
- **CC-7 / CX-8 fragility:** both exercise deliberately less-traveled paths (stub MCP
  transport; non-production approval policy). Their failures must be well-labeled and
  must not mask the core scenarios.
