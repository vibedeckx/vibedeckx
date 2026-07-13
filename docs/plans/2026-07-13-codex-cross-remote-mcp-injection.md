# Codex Cross-Remote MCP Injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make each eligible Codex app-server session discover the session-scoped cross-remote HTTP MCP server without exposing its bearer token in process arguments.

**Architecture:** The existing minting and session-manager flow remains unchanged. The Codex provider forwards `CrossRemoteMcpConfig` into the Codex CLI builder, which adds a process-local `mcp_servers.cross-remote` config override and supplies the bearer token through a fixed environment-variable name.

**Tech Stack:** TypeScript, Codex app-server CLI, Vitest

---

### Task 1: Specify Codex CLI MCP injection

**Files:**
- Modify: `packages/vibedeckx/src/protocol/codex/cli.test.ts`
- Modify: `packages/vibedeckx/src/providers/codex-provider.test.ts`

**Step 1: Write the failing CLI tests**

Add native and `npx` cases that call:

```ts
buildCodexAppServerSpawnConfig(binary, {
  url: "https://app.example.com/api/cross-remote-mcp",
  token: "secret-token",
})
```

Assert that the args contain a `-c` override for `mcp_servers.cross-remote`, the
spawn environment contains the token, and serialized args do not contain the
token.

**Step 2: Write the failing provider test**

Call `CodexProvider.buildSpawnConfig()` with a cross-remote configuration and
assert that its returned args and environment contain the injected settings.

**Step 3: Run tests to verify they fail**

Run:

```bash
cd packages/vibedeckx
pnpm exec vitest run src/protocol/codex/cli.test.ts src/providers/codex-provider.test.ts
```

Expected: FAIL because the CLI builder accepts only one argument and the
provider discards `crossRemoteMcp`.

### Task 2: Implement process-local Codex MCP configuration

**Files:**
- Modify: `packages/vibedeckx/src/protocol/codex/cli.ts`
- Modify: `packages/vibedeckx/src/providers/codex-provider.ts`

**Step 1: Extend the CLI builder**

Add a fixed token environment-variable name and build the override:

```ts
mcp_servers.cross-remote={ url = "...", bearer_token_env_var = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN" }
```

Return the token through `SpawnConfig.env`, and append `-c` plus the override
after `app-server` for both native and `npx` invocations.

**Step 2: Forward the provider argument**

Rename `_crossRemoteMcp` to `crossRemoteMcp` and pass it to
`buildCodexAppServerSpawnConfig`.

**Step 3: Run the focused tests**

Run the Task 1 command. Expected: PASS.

### Task 3: Verify the complete change

**Files:**
- Verify only

**Step 1: Run related cross-remote and provider tests**

```bash
cd packages/vibedeckx
pnpm exec vitest run src/cross-remote-mcp-config.test.ts src/remote-agent-sessions.test.ts src/providers/claude-code-provider.test.ts src/providers/codex-provider.test.ts src/protocol/codex/cli.test.ts
```

Expected: PASS.

**Step 2: Run the complete package test suite**

```bash
pnpm --filter vibedeckx test
```

Expected: all tests pass.

**Step 3: Build the server package**

```bash
pnpm --filter vibedeckx build
```

Expected: exit code 0.

**Step 4: Review and commit**

Confirm that no bearer token is rendered into CLI args, review `git diff`, and
commit the implementation and tests.

