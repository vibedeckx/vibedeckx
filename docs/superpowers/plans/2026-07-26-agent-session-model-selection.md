# Agent Session Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user choose which model a spawned agent session (Claude Code / Codex CLI) runs on, fixed for the lifetime of that session.

**Architecture:** The model is a per-session string stored on the `agent_sessions` row and turned into a spawn argument at process launch (`claude --model <X>`, `codex app-server -c model="<X>"`). It is chosen before the session exists (sessions are created lazily on first message send) and is immutable afterwards — changing model means branching a new session, which inherits the parent's model. There is no validation anywhere: the picker offers suggestions, free text is allowed, and a bad model name surfaces as the CLI's own error inside the conversation.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify, better-sqlite3 + Kysely, vitest (backend and frontend), Next.js 16 + React 19, Tailwind v4, shadcn/ui, Radix (unified `radix-ui` package), cmdk.

## Global Constraints

- Backend is ESM with NodeNext resolution — **every local import needs a `.js` extension**, even from `.ts` files.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`. Frontend typecheck: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Backend tests: `pnpm --filter vibedeckx test`. Frontend tests: `pnpm --filter vibedeckx-ui test`. Frontend lint: `pnpm --filter vibedeckx-ui lint`.
- **The model is never validated.** No whitelist, no availability probe, no pre-flight check on any layer. A model string the CLI rejects must reach the CLI and fail there. This is the project's established stance for agent binaries and is a deliberate decision, not an oversight.
- **The model must never be stored on a provider instance.** `ClaudeCodeProvider` and `CodexProvider` are module-scope singletons shared by every session (`packages/vibedeckx/src/providers/index.ts:8-9`). `CodexProvider.lastPermissionMode` (`codex-provider.ts:46`) is an existing instance field written per-spawn — do not copy that pattern. The model travels as a function parameter into `argv` and is never retained.
- `model` is nullable everywhere. `null` / `undefined` means "pass no flag; let the CLI use its default". The UI label for that state is the literal string `Default`.
- The model column is a plain nullable `TEXT` column, deliberately not modelled as create-time-immutable, so a future mid-session switch needs no migration. Do **not** add an `updateModel` repository method: nothing calls it, and the column is already updatable by virtue of being a column. Whoever builds mid-session switching adds the method then.
- Existing exact-match assertions in `packages/vibedeckx/src/protocol/claude-code/cli.test.ts` and `packages/vibedeckx/src/protocol/codex/cli.test.ts` use `toEqual` on full arg arrays. New optional parameters must leave those arrays byte-identical when no model is given.

---

## File Structure

**Backend — protocol layer (arg building)**
- `packages/vibedeckx/src/protocol/claude-code/cli.ts` — add optional `model` to `buildClaudeSessionSpawnConfig`
- `packages/vibedeckx/src/protocol/codex/cli.ts` — add optional `model` to `buildCodexAppServerSpawnConfig`

**Backend — provider layer (interface)**
- `packages/vibedeckx/src/agent-provider.ts` — `buildSpawnConfig` signature
- `packages/vibedeckx/src/providers/claude-code-provider.ts` — pass through
- `packages/vibedeckx/src/providers/codex-provider.ts` — pass through

**Backend — storage**
- `packages/vibedeckx/src/storage/sqlite.ts` — `model` column migration + fresh-DDL column
- `packages/vibedeckx/src/storage/schema.ts` — `AgentSessionsTable.model`
- `packages/vibedeckx/src/storage/types.ts` — `AgentSession.model`, `agentSessions.create` opts
- `packages/vibedeckx/src/storage/repositories/agent-sessions.ts` — row mapping, create

**Backend — session manager**
- `packages/vibedeckx/src/agent-session-manager.ts` — `RunningSession.model`, `createNewSession` param, `spawnAgent` wiring, respawn paths (`restoreSessionsFromDb`, `branchSession`), and the stdout-tail startup-failure fix

**Backend — routes**
- `packages/vibedeckx/src/routes/agent-session-routes.ts` — request bodies + response fields
- `packages/vibedeckx/src/remote-agent-sessions.ts` — forward `model` to the remote worker

**Frontend**
- `apps/vibedeckx-ui/lib/api.ts` — types + `createNewAgentSession` body
- `apps/vibedeckx-ui/hooks/use-agent-session.ts` — thread `model` through `ensureSession`
- `apps/vibedeckx-ui/components/ui/popover.tsx` — **new**, shadcn Popover over the unified `radix-ui` package
- `apps/vibedeckx-ui/components/agent/model-picker.tsx` — **new**, the two-form chip (editable combobox / static text)
- `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — header integration + connection-status collapse
- `apps/vibedeckx-ui/components/agent/session-history-dropdown.tsx` — model in the existing row tooltip

**Suggestion lists (new, shared shape)**
- `packages/vibedeckx/src/protocol/model-suggestions.ts` — **new**, the per-agent suggestion arrays, served by `/api/agent-providers`

---

### Task 1: Protocol layer — model flags for both CLIs

**Files:**
- Create: `packages/vibedeckx/src/protocol/model-suggestions.ts`
- Modify: `packages/vibedeckx/src/protocol/claude-code/cli.ts:18-44`
- Modify: `packages/vibedeckx/src/protocol/codex/cli.ts:12-32`
- Test: `packages/vibedeckx/src/protocol/claude-code/cli.test.ts`
- Test: `packages/vibedeckx/src/protocol/codex/cli.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `buildClaudeSessionSpawnConfig(nativeBinary: string | null, permissionMode: "plan" | "edit", mcpConfigArg?: string, model?: string | null): SpawnConfig`
  - `buildCodexAppServerSpawnConfig(nativeBinary: string | null, crossRemoteMcp?: CrossRemoteMcpConfig, model?: string | null): SpawnConfig`
  - `MODEL_SUGGESTIONS: Record<"claude-code" | "codex", readonly string[]>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/vibedeckx/src/protocol/claude-code/cli.test.ts`, inside the existing `describe("claude CLI builders", ...)` block:

```typescript
  it("appends --model after the permission flag when a model is given", () => {
    expect(buildClaudeSessionSpawnConfig("/usr/local/bin/claude", "edit", undefined, "opus")).toEqual({
      command: "/usr/local/bin/claude",
      args: [
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--disallowedTools",
        "AskUserQuestion",
        "--verbose",
      ],
    });
  });

  it("omits --model for null, undefined, and blank model strings", () => {
    const base = [
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
    ];
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, null).args).toEqual(base);
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, undefined).args).toEqual(base);
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, "   ").args).toEqual(base);
  });

  it("passes an unknown model name through verbatim (no validation)", () => {
    expect(buildClaudeSessionSpawnConfig("/bin/claude", "edit", undefined, "totally-made-up").args).toContain(
      "totally-made-up",
    );
  });

  it("combines --model with --mcp-config", () => {
    expect(buildClaudeSessionSpawnConfig(null, "plan", '{"mcpServers":{}}', "sonnet").args).toEqual([
      "-y",
      "@anthropic-ai/claude-code",
      "--output-format=stream-json",
      "--input-format=stream-json",
      "--permission-mode=plan",
      "--model",
      "sonnet",
      "--disallowedTools",
      "AskUserQuestion",
      "--verbose",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });
```

Append to `packages/vibedeckx/src/protocol/codex/cli.test.ts`, inside the existing `describe("codex CLI builders", ...)` block:

```typescript
  it("injects the model as a TOML-quoted -c override", () => {
    expect(buildCodexAppServerSpawnConfig("/usr/local/bin/codex", undefined, "gpt-5.6-sol")).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server", "-c", 'model="gpt-5.6-sol"'],
      shell: false,
    });
  });

  it("omits the model override for null, undefined, and blank model strings", () => {
    expect(buildCodexAppServerSpawnConfig("/bin/codex", undefined, null).args).toEqual(["app-server"]);
    expect(buildCodexAppServerSpawnConfig("/bin/codex", undefined, undefined).args).toEqual(["app-server"]);
    expect(buildCodexAppServerSpawnConfig("/bin/codex", undefined, "  ").args).toEqual(["app-server"]);
  });

  it("puts the model override before the cross-remote MCP override", () => {
    const config = buildCodexAppServerSpawnConfig(
      "/bin/codex",
      { url: "https://app.example.com/api/cross-remote-mcp", token: "secret-token" },
      "opus",
    );
    expect(config.args).toEqual([
      "app-server",
      "-c",
      'model="opus"',
      "-c",
      'mcp_servers.cross-remote={ url = "https://app.example.com/api/cross-remote-mcp", bearer_token_env_var = "VIBEDECKX_CROSS_REMOTE_MCP_TOKEN" }',
    ]);
    expect(config.env).toEqual({ VIBEDECKX_CROSS_REMOTE_MCP_TOKEN: "secret-token" });
  });

  it("quotes a model name containing a double quote so the TOML value stays well-formed", () => {
    expect(buildCodexAppServerSpawnConfig("/bin/codex", undefined, 'we"ird').args).toEqual([
      "app-server",
      "-c",
      'model="we\\"ird"',
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter vibedeckx test -- src/protocol/claude-code/cli.test.ts src/protocol/codex/cli.test.ts`
Expected: FAIL — the new cases fail because the 4th/3rd argument is ignored (arrays come back without `--model` / `-c model=...`). The pre-existing cases in both files must still PASS.

- [ ] **Step 3: Create the suggestion list module**

Create `packages/vibedeckx/src/protocol/model-suggestions.ts`:

```typescript
/**
 * Suggested model names per agent CLI.
 *
 * These are SUGGESTIONS, not a whitelist — the picker also accepts free text
 * and nothing validates against this list. Whether a name works depends on the
 * installed CLI version, the machine's account tier, and the provider's
 * server-side availability; none of that is knowable here, so a bad name is
 * allowed through and fails with the CLI's own error message.
 *
 * Claude entries are deliberately ALIASES, not dated model ids: an alias always
 * points at the current model in its tier, so this list cannot rot. A dated id
 * like "claude-opus-4-5-20251101" would be stale within months.
 */
export const MODEL_SUGGESTIONS: Record<"claude-code" | "codex", readonly string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol", "gpt-5.6-codex", "o3"],
} as const;
```

- [ ] **Step 4: Add the model flag to the claude builder**

In `packages/vibedeckx/src/protocol/claude-code/cli.ts`, replace `buildClaudeSessionSpawnConfig` (lines 17-44) with:

```typescript
/** Interactive agent session (agent-session-manager). */
export function buildClaudeSessionSpawnConfig(
  nativeBinary: string | null,
  permissionMode: "plan" | "edit",
  mcpConfigArg?: string,
  model?: string | null,
): SpawnConfig {
  const permissionFlag = permissionMode === "plan"
    ? "--permission-mode=plan"
    : "--dangerously-skip-permissions";

  const args = [
    ...STREAM_JSON_ARGS,
    permissionFlag,
  ];

  // Unvalidated by design: an alias ("opus"), a full id, or a typo all get
  // passed straight through. claude exits 1 with its own message on stdout if
  // it doesn't recognize the name — see the startup-failure path in
  // agent-session-manager.
  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  args.push(
    // AskUserQuestion can't work over piped (non-TTY) stdin: claude resolves it
    // internally as "dismissed" before we can present a picker and wait for the
    // user. Disable it so the agent falls back to asking in plain text, which the
    // user answers through the normal conversation input.
    "--disallowedTools",
    "AskUserQuestion",
    "--verbose",
  );

  if (mcpConfigArg) {
    args.push("--mcp-config", mcpConfigArg);
  }

  return withNpxFallback(nativeBinary, args);
}
```

- [ ] **Step 5: Add the model override to the codex builder**

In `packages/vibedeckx/src/protocol/codex/cli.ts`, replace `buildCodexAppServerSpawnConfig` (lines 12-32) with:

```typescript
export function buildCodexAppServerSpawnConfig(
  nativeBinary: string | null,
  crossRemoteMcp?: CrossRemoteMcpConfig,
  model?: string | null,
): SpawnConfig {
  const args = ["app-server"];

  // codex app-server has no --model flag; the model is set through the same
  // generic `-c <toml-assignment>` override used for MCP servers below.
  // JSON.stringify produces a valid TOML basic string (double-quoted, with
  // inner quotes and backslashes escaped). One app-server process serves
  // exactly one session, so a process-wide override cannot leak across
  // sessions.
  if (model && model.trim()) {
    args.push("-c", `model=${JSON.stringify(model.trim())}`);
  }

  if (crossRemoteMcp) {
    args.push(
      "-c",
      `mcp_servers.cross-remote={ url = ${JSON.stringify(crossRemoteMcp.url)}, bearer_token_env_var = ${JSON.stringify(CROSS_REMOTE_MCP_TOKEN_ENV)} }`,
    );
  }

  const env = crossRemoteMcp
    ? { [CROSS_REMOTE_MCP_TOKEN_ENV]: crossRemoteMcp.token }
    : undefined;

  if (nativeBinary) {
    return { command: nativeBinary, args, ...(env ? { env } : {}), shell: false };
  }
  return { command: "npx", args: ["-y", CODEX_NPM_PACKAGE, ...args], ...(env ? { env } : {}), shell: false };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter vibedeckx test -- src/protocol/claude-code/cli.test.ts src/protocol/codex/cli.test.ts`
Expected: PASS — all cases, old and new.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/vibedeckx/src/protocol/model-suggestions.ts \
        packages/vibedeckx/src/protocol/claude-code/cli.ts \
        packages/vibedeckx/src/protocol/claude-code/cli.test.ts \
        packages/vibedeckx/src/protocol/codex/cli.ts \
        packages/vibedeckx/src/protocol/codex/cli.test.ts
git commit -m "feat(protocol): accept an optional model in both agent spawn builders"
```

---

### Task 2: Provider layer — thread the model to the arg builders

**Files:**
- Modify: `packages/vibedeckx/src/agent-provider.ts:66`
- Modify: `packages/vibedeckx/src/providers/claude-code-provider.ts:41`
- Modify: `packages/vibedeckx/src/providers/codex-provider.ts:70-73`
- Test: `packages/vibedeckx/src/providers/model-spawn.test.ts` (create)

**Interfaces:**
- Consumes: `buildClaudeSessionSpawnConfig(..., model?)` and `buildCodexAppServerSpawnConfig(..., model?)` from Task 1.
- Produces: `AgentProvider.buildSpawnConfig(cwd: string, permissionMode: "plan" | "edit", crossRemoteMcp?: CrossRemoteMcpConfig, model?: string | null): SpawnConfig`

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/providers/model-spawn.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import { CodexProvider } from "./codex-provider.js";

describe("provider buildSpawnConfig model passthrough", () => {
  it("claude puts the model into argv", () => {
    const config = new ClaudeCodeProvider().buildSpawnConfig("/tmp/wt", "edit", undefined, "opus");
    expect(config.args).toContain("--model");
    expect(config.args).toContain("opus");
  });

  it("codex puts the model into a -c override", () => {
    const config = new CodexProvider().buildSpawnConfig("/tmp/wt", "edit", undefined, "o3");
    expect(config.args).toContain('model="o3"');
  });

  it("omits the model when none is given", () => {
    expect(new ClaudeCodeProvider().buildSpawnConfig("/tmp/wt", "edit").args).not.toContain("--model");
    expect(
      new CodexProvider().buildSpawnConfig("/tmp/wt", "edit").args.some((a) => a.startsWith("model=")),
    ).toBe(false);
  });

  it("does not retain the model on the provider instance between spawns", () => {
    // Providers are module-scope singletons shared by every session. A model
    // stored on the instance would leak from one session's spawn into the next.
    const provider = new CodexProvider();
    provider.buildSpawnConfig("/tmp/a", "edit", undefined, "o3");
    const second = provider.buildSpawnConfig("/tmp/b", "edit");
    expect(second.args.some((a) => a.startsWith("model="))).toBe(false);

    const claude = new ClaudeCodeProvider();
    claude.buildSpawnConfig("/tmp/a", "edit", undefined, "opus");
    expect(claude.buildSpawnConfig("/tmp/b", "edit").args).not.toContain("--model");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/providers/model-spawn.test.ts`
Expected: FAIL — TypeScript rejects the 4th argument / the model never reaches argv.

- [ ] **Step 3: Widen the interface**

In `packages/vibedeckx/src/agent-provider.ts`, replace line 65-66:

```typescript
  /**
   * Build the spawn configuration for launching the agent process.
   *
   * `model` is an optional, UNVALIDATED model name for this session only.
   * Implementations must pass it straight into the spawn arguments and must
   * NOT store it on the provider instance — providers are singletons shared
   * by every session.
   */
  buildSpawnConfig(
    cwd: string,
    permissionMode: "plan" | "edit",
    crossRemoteMcp?: CrossRemoteMcpConfig,
    model?: string | null,
  ): SpawnConfig;
```

- [ ] **Step 4: Update both implementations**

In `packages/vibedeckx/src/providers/claude-code-provider.ts`, change the `buildSpawnConfig` method (line 41) so its signature and body read:

```typescript
  buildSpawnConfig(
    _cwd: string,
    permissionMode: "plan" | "edit",
    crossRemoteMcp?: CrossRemoteMcpConfig,
    model?: string | null,
  ): SpawnConfig {
```

and pass `model` as the 4th argument of the `buildClaudeSessionSpawnConfig(...)` call inside it (the call currently ends with the mcp-config argument; append `, model`).

In `packages/vibedeckx/src/providers/codex-provider.ts`, replace lines 70-74 with:

```typescript
  buildSpawnConfig(
    _cwd: string,
    permissionMode: "plan" | "edit",
    crossRemoteMcp?: CrossRemoteMcpConfig,
    model?: string | null,
  ): SpawnConfig {
    // Store permissionMode for use in formatUserInput's turn/start params
    this.lastPermissionMode = permissionMode;
    // NOTE: `model` is deliberately NOT stored on `this`. It only affects the
    // process being spawned right now; this provider instance is shared by
    // every session in the server.
    return buildCodexAppServerSpawnConfig(this.detectBinary(), crossRemoteMcp, model);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter vibedeckx test -- src/providers/model-spawn.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and run the full backend suite**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/vibedeckx/src/agent-provider.ts \
        packages/vibedeckx/src/providers/claude-code-provider.ts \
        packages/vibedeckx/src/providers/codex-provider.ts \
        packages/vibedeckx/src/providers/model-spawn.test.ts
git commit -m "feat(providers): thread an optional per-spawn model through buildSpawnConfig"
```

---

### Task 3: Storage — `model` column and type

**Files:**
- Modify: `packages/vibedeckx/src/storage/sqlite.ts:101-119` (fresh DDL) and `:423-427` (migration block)
- Modify: `packages/vibedeckx/src/storage/schema.ts:97-110`
- Modify: `packages/vibedeckx/src/storage/types.ts:336-352` and `:619-620`
- Modify: `packages/vibedeckx/src/storage/repositories/agent-sessions.ts:31-36, 56-64`
- Test: `packages/vibedeckx/src/storage/agent-session-model.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AgentSession.model?: string | null`
  - `storage.agentSessions.create({ id, project_id, branch, permission_mode?, agent_type?, model? })`

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/storage/agent-session-model.test.ts`, following the temp-SQLite pattern used by `packages/vibedeckx/src/storage/agent-sessions.test.ts:1-22`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("agent_sessions.model", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-model-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to null when not supplied", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    expect((await storage.agentSessions.getById("s1"))?.model ?? null).toBeNull();
  });

  it("round-trips a model string", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "", model: "opus" });
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("opus");
  });

  it("stores an arbitrary unvalidated string", async () => {
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "", model: "not-a-real-model" });
    expect((await storage.agentSessions.getById("s1"))?.model).toBe("not-a-real-model");
  });

  it("listByBranch carries the model through to session summaries", async () => {
    // The two list routes serialize DB rows with `...s`, so this mapping is
    // what makes the model appear in the session-history dropdown (Task 9).
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev", model: "opus" });
    const rows = await storage.agentSessions.listByBranch("p1", "dev");
    expect(rows.find((r) => r.id === "s1")?.model).toBe("opus");
  });
});
```

If `listByBranch`'s parameter order differs, adjust that last case to match the signature in `packages/vibedeckx/src/storage/types.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/storage/agent-session-model.test.ts`
Expected: FAIL — `model` is not a known property on the create options or the returned row.

- [ ] **Step 3: Add the column to the fresh-DDL table**

In `packages/vibedeckx/src/storage/sqlite.ts`, inside `CREATE TABLE IF NOT EXISTS agent_sessions (...)`, add after the `title` line (line 106):

```sql
      -- Per-session agent model, e.g. 'opus' or 'gpt-5.6-sol'. NULL = use the
      -- CLI's own default (no flag is passed). Never validated: an unknown
      -- name is passed to the CLI and fails there.
      model TEXT DEFAULT NULL,
```

- [ ] **Step 4: Add the migration for existing databases**

In `packages/vibedeckx/src/storage/sqlite.ts`, immediately after the `favorited_at` migration block (which ends at line 427), add:

```typescript
  // Migration: add model column to agent_sessions (per-session agent model;
  // NULL = CLI default).
  const sessionInfoV7 = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
  if (!sessionInfoV7.some(col => col.name === "model")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN model TEXT DEFAULT NULL");
  }
```

- [ ] **Step 5: Add the column to the Kysely table type**

In `packages/vibedeckx/src/storage/schema.ts`, add to `AgentSessionsTable` (after `title` on line 104):

```typescript
  model: string | null;
```

- [ ] **Step 6: Add the field to the domain type and repository interface**

In `packages/vibedeckx/src/storage/types.ts`, add to `interface AgentSession` (after `title` on line 343):

```typescript
  /** Per-session agent model, or null/undefined to use the CLI's default. */
  model?: string | null;
```

and in the `agentSessions` repository interface, replace the `create` signature on line 620:

```typescript
    create: (opts: { id: string; project_id: string; branch: string; permission_mode?: string; agent_type?: string; model?: string | null }) => Promise<AgentSession>;
```

Do not add an update method — see Global Constraints.

- [ ] **Step 7: Wire the repository**

In `packages/vibedeckx/src/storage/repositories/agent-sessions.ts`:

Add to the row mapper next to line 36 (`agent_type: row.agent_type ?? undefined,`):

```typescript
  model: row.model ?? null,
```

Change `create` (line 56) to destructure and insert `model`:

```typescript
    create: async ({ id, project_id, branch, permission_mode, agent_type, model }) => {
```

and add to the `.values({ ... })` object, alongside `permission_mode` and `agent_type`:

```typescript
        model: model ?? null,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter vibedeckx test -- src/storage/agent-session-model.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Verify the migration works on a pre-existing database**

⚠️ **This machine may be a live worker.** Always pass `--data-dir` so you touch a throwaway database, never `~/.vibedeckx/data.sqlite`. Use port 5199 (3000 and 5173 are in use). Never run a daemon-stopping command.

The seed must be a schema that has been through **every prior migration but not this one** — `--data-dir <dir>` resolves to `<dir>/data.sqlite`, so seed exactly that path. A minimal 4-column table is not a realistic historical shape: no shipped version had `branch` without `created_at`, and seeding one trips an unrelated pre-existing failure in the drop-UNIQUE rebuild block (`sqlite.ts:386-409` does `SELECT ..., created_at, created_at FROM agent_sessions`) before the `model` migration is ever reached.

```bash
mkdir -p /tmp/model-migration-check-dir
node -e "
const Database = require('better-sqlite3');
const db = new Database('/tmp/model-migration-check-dir/data.sqlite');
db.exec(\`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running', permission_mode TEXT DEFAULT 'edit',
    agent_type TEXT DEFAULT 'claude-code', title TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    last_user_message_at INTEGER DEFAULT NULL, last_completed_at INTEGER DEFAULT NULL,
    favorited_at INTEGER DEFAULT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
\`);
db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p1', 'p', '/tmp/p');
db.prepare('INSERT INTO agent_sessions (id, project_id) VALUES (?, ?)').run('legacy-1', 'p1');
db.close();
"
```

Boot once so migrations run (run `pnpm build:main` first if `dist/` is stale):

```bash
node packages/vibedeckx/dist/bin.js --data-dir /tmp/model-migration-check-dir --no-ui --port 5199 &
sleep 5 && kill %1
```

Confirm the column exists and the legacy row is NULL:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/tmp/model-migration-check-dir/data.sqlite');
console.log(db.prepare('PRAGMA table_info(agent_sessions)').all().map(c => c.name));
console.log(db.prepare('SELECT id, model FROM agent_sessions WHERE id = ?').get('legacy-1'));
db.close();
"
rm -rf /tmp/model-migration-check-dir
```

Expected: the column list contains `model`, and the legacy row reads `{ id: 'legacy-1', model: null }`.

- [ ] **Step 10: Run the full backend suite and typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: no type errors; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/vibedeckx/src/storage/sqlite.ts \
        packages/vibedeckx/src/storage/schema.ts \
        packages/vibedeckx/src/storage/types.ts \
        packages/vibedeckx/src/storage/repositories/agent-sessions.ts \
        packages/vibedeckx/src/storage/agent-session-model.test.ts
git commit -m "feat(storage): add a nullable per-session model column to agent_sessions"
```

---

### Task 4: Session manager — carry the model from creation through spawn and every respawn

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts:88-140` (`RunningSession`), `:516-590` (`createNewSession`), `:708` (`spawnAgent`), `:2449-2510` (`restoreSessionsFromDb`), `:2530-2620` (`branchSession`)
- Test: `packages/vibedeckx/src/agent-session-manager.model.test.ts` (create)

**Interfaces:**
- Consumes: `buildSpawnConfig(..., model?)` (Task 2); `storage.agentSessions.create({ ..., model })` (Task 3).
- Produces:
  - `RunningSession.model: string | null`
  - `createNewSession(projectId, branch, projectPath, skipDb?, permissionMode?, agentType?, announceRunning?, force?, opts?)` where `opts` gains `model?: string | null`
  - Behavioural guarantee: a session's model survives server restart and dormancy/wake, is untouched by an agent switch, and is inherited by branches.

**Design notes:**

- `createNewSession` already takes eight positional parameters. Do **not** add a ninth — put `model` on the existing trailing `opts` object, which already carries `sessionId` and `crossRemoteMcp`.
- A single session respawns through several paths, and `RunningSession.model` is a required field, so **all** of its construction sites must land in this one task or the file will not compile. `wakeDormantSession` and `switchAgentType` mutate the existing `RunningSession` and then call `spawnAgent`, so they inherit `session.model` for free — no edit needed, but the tests below lock that in. `restoreSessionsFromDb` and `branchSession` build **new** `RunningSession` objects and must read the model explicitly. Missing one produces a session that silently drops to the default model partway through its life, with no UI signal.

- [ ] **Step 1: Write the failing tests**

Create `packages/vibedeckx/src/agent-session-manager.model.test.ts`, following the fake-storage harness style of `packages/vibedeckx/src/agent-session-manager.branch.test.ts:27-52`.

`createNewSession` really spawns a child process, so `buildSpawnConfig` is stubbed to return a command that exits immediately — that keeps the test hermetic while still capturing the arguments the manager passed:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getProvider } from "./providers/index.js";
import type { AgentSession, Storage } from "./storage/types.js";

function makeStorage() {
  const rows = new Map<string, AgentSession>();
  const storage = {
    agentSessions: {
      create: async (row: Partial<AgentSession> & { id: string }) => {
        const full = {
          status: "running",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          ...row,
        } as AgentSession;
        rows.set(row.id, full);
        return full;
      },
      getById: async (id: string) => rows.get(id) ?? null,
      getAll: async () => [...rows.values()],
      getEntries: async () => [],
      upsertEntry: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => [...rows.values()],
    },
  } as unknown as Storage;
  return { storage, rows };
}

/** Capture buildSpawnConfig args while spawning a process that exits at once. */
function stubSpawn() {
  const calls: unknown[][] = [];
  const spy = vi
    .spyOn(getProvider("claude-code"), "buildSpawnConfig")
    .mockImplementation((...args: unknown[]) => {
      calls.push(args);
      return { command: "true", args: [] };
    });
  return { calls, spy };
}

describe("session manager model wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists the model on create and hands it to the spawn builder", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "opus" },
    );

    expect(rows.get(sessionId)?.model).toBe("opus");
    expect(manager.getSession(sessionId)?.model).toBe("opus");
    expect(calls[0]?.[3]).toBe("opus");
  });

  it("passes null through when no model was chosen", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession("p1", null, "/tmp/p1", false, "edit", "claude-code");

    expect(rows.get(sessionId)?.model ?? null).toBeNull();
    expect(calls[0]?.[3] ?? null).toBeNull();
  });

  it("normalizes a whitespace-only model to null", async () => {
    const { storage, rows } = makeStorage();
    const { calls } = stubSpawn();
    const manager = new AgentSessionManager(storage);

    const sessionId = await manager.createNewSession(
      "p1", null, "/tmp/p1", false, "edit", "claude-code", false, false, { model: "   " },
    );

    expect(rows.get(sessionId)?.model ?? null).toBeNull();
    expect(calls[0]?.[3] ?? null).toBeNull();
  });
});
```

If `AgentSessionManager`'s constructor needs more than `storage` in this repo's current shape, copy the exact construction from `agent-session-manager.branch.test.ts` rather than guessing.

Append the respawn-path cases to the same file. These paths never spawn (restore and branch both produce dormant sessions), so no spawn stub is needed:

```typescript
const HISTORY = [
  { session_id: "s-src", entry_index: 0, data: JSON.stringify({ type: "user", content: "hi", timestamp: 1 }) },
  { session_id: "s-src", entry_index: 1, data: JSON.stringify({ type: "turn_end", timestamp: 2, durationMs: 1, outcome: "completed" }) },
];

/** Storage seeded with one persisted source session that has history. */
function makeSeededStorage(sourceRow: Partial<AgentSession>) {
  const source = {
    id: "s-src",
    project_id: "p1",
    branch: "feat",
    status: "stopped",
    permission_mode: "edit",
    agent_type: "claude-code",
    title: "Original",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...sourceRow,
  } as AgentSession;

  const created: AgentSession[] = [];
  const storage = {
    agentSessions: {
      getAll: async () => [source],
      getById: async (id: string) => (id === "s-src" ? source : created.find((r) => r.id === id) ?? null),
      getEntries: async () => HISTORY,
      create: async (row: Partial<AgentSession>) => { created.push({ ...source, ...row } as AgentSession); },
      updateStatusPreservingTimestamp: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      updateAgentType: vi.fn(async () => undefined),
      upsertEntry: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      listByBranch: async () => created,
    },
  } as unknown as Storage;

  return { storage, created };
}

describe("model survives every respawn path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restoreSessionsFromDb rehydrates the model from the row", async () => {
    const { storage } = makeSeededStorage({ model: "sonnet" });
    const manager = new AgentSessionManager(storage);

    await manager.restoreSessionsFromDb();

    expect(manager.getSession("s-src")?.model).toBe("sonnet");
  });

  it("restoreSessionsFromDb yields null for legacy rows with no model", async () => {
    const { storage } = makeSeededStorage({});
    const manager = new AgentSessionManager(storage);

    await manager.restoreSessionsFromDb();

    expect(manager.getSession("s-src")?.model ?? null).toBeNull();
  });

  it("branchSession inherits the source session's model", async () => {
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", undefined, { upToEntryIndex: 1 });
    expect(result.ok).toBe(true);
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    expect(created.find((r) => r.id === newId)?.model).toBe("opus");
    expect(manager.getSession(newId)?.model).toBe("opus");
  });

  it("branchSession keeps the model when the agent type is overridden", async () => {
    const { storage, created } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    const result = await manager.branchSession("s-src", "codex", { upToEntryIndex: 1 });
    const newId = (result as { ok: true; sessionId: string }).sessionId;

    // The model is copied verbatim even across agents — it is never validated,
    // so a claude alias landing on a codex session simply fails at the CLI.
    expect(created.find((r) => r.id === newId)?.model).toBe("opus");
  });

  it("switchAgentType leaves the model untouched", async () => {
    // switchAgentType mutates the existing RunningSession rather than building
    // a new one, so it inherits session.model for free — this locks that in
    // against a future refactor that rebuilds the object.
    const { storage } = makeSeededStorage({ model: "opus" });
    const manager = new AgentSessionManager(storage);
    await manager.restoreSessionsFromDb();

    expect(await manager.switchAgentType("s-src", "codex")).toBe("ok");
    expect(manager.getSession("s-src")?.model).toBe("opus");
  });
});
```

The `BranchResult` success shape is asserted as `{ ok: true, sessionId }` — confirm the actual field name against `agent-session-manager.branch.test.ts` and adjust if it differs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.model.test.ts`
Expected: FAIL — `opts.model` is not accepted, `buildSpawnConfig` is called with 3 arguments, and `session.model` is undefined on restored and branched sessions.

- [ ] **Step 3: Add the field to `RunningSession`**

In `packages/vibedeckx/src/agent-session-manager.ts`, add to the `RunningSession` interface right after `agentType` (line 99):

```typescript
  /**
   * Per-session agent model, or null for the CLI default. Fixed for the life
   * of the session (a different model means branching a new session) and
   * re-read from the DB on every respawn path.
   */
  model: string | null;
```

- [ ] **Step 4: Accept and persist the model in `createNewSession`**

In `packages/vibedeckx/src/agent-session-manager.ts`, change the `opts` parameter of `createNewSession` (line 524) to:

```typescript
    opts: { sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; model?: string | null } = {},
```

Immediately after `const branchKey = branch ?? "";` (line 531), add:

```typescript
    const model = opts.model?.trim() ? opts.model.trim() : null;
```

Add `model,` to the `storage.agentSessions.create({ ... })` call (after `agent_type: agentType,`), and add `model,` to the `RunningSession` object literal (after `agentType,`).

- [ ] **Step 5: Forward the model at spawn time**

In `packages/vibedeckx/src/agent-session-manager.ts`, replace line 708:

```typescript
    const config = provider.buildSpawnConfig(cwd, session.permissionMode, session.crossRemoteMcp, session.model);
```

- [ ] **Step 6: Rehydrate the model in `restoreSessionsFromDb`**

In `packages/vibedeckx/src/agent-session-manager.ts`, add to the `runningSession` literal in `restoreSessionsFromDb` (~line 2471), next to `agentType`:

```typescript
        model: dbSession.model ?? null,
```

- [ ] **Step 7: Inherit the model in `branchSession`**

Add a resolution line next to the existing `permissionMode` / `agentType` resolutions in `branchSession` (after line 2560):

```typescript
    // A branch continues the same conversation, so it continues on the same
    // model. This is also how a user "changes model mid-session": branch from
    // a stop point and pick a new model on the branch.
    const model = source?.model ?? sourceRow?.model ?? null;
```

Add `model,` to the `storage.agentSessions.create({ ... })` call in `branchSession`, and `model,` to the `branched` `RunningSession` literal (~line 2612).

- [ ] **Step 8: Confirm no `RunningSession` literal was missed**

`RunningSession.model` is required, so any literal still lacking it is a compile error.

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: clean. If it names another construction site, give it the model value appropriate to that path — never `null` just to silence the compiler.

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter vibedeckx test -- src/agent-session-manager.model.test.ts`
Expected: PASS (8 tests — 3 creation, 5 respawn).

- [ ] **Step 10: Full suite**

Run: `pnpm --filter vibedeckx test`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts \
        packages/vibedeckx/src/agent-session-manager.model.test.ts
git commit -m "feat(sessions): carry a per-session model from creation through spawn and respawn"
```

---

### Task 5: Surface CLI startup errors that arrive on stdout

**Files:**
- Modify: `packages/vibedeckx/src/agent-session-manager.ts:726` (tail state), `:1000-1018` (`handleStdout`), `:798-812` (close handler), `:1370-1379` (`buildStartupFailureMessage`)
- Test: `packages/vibedeckx/src/startup-failure-message.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildStartupFailureMessage(agentType: AgentType, stderrTail: string, stdoutTail: string): string`

**Why this is defense-in-depth, not a live bug fix — corrected 2026-07-26 after measurement.**

The original justification for this task was wrong, and the correction is worth recording because it changes how the change should be judged.

The premise came from `claude --model bogus -p hi`, which exits 1 and prints `There's an issue with the selected model (bogus). It may not exist or you may not have access to it.` on **stdout** with stderr empty. Reasoning from there: the text is not stream-json, so `parseStdoutLine` returns no events, `producedOutput` stays false, the close handler's startup-failure branch fires, and with an empty `stderrTail` the user is told to install a CLI that is already installed.

**That path is not what the app runs.** Session spawns always carry `--output-format=stream-json --input-format=stream-json`. Driven through `AgentSessionManager` with those args against claude 2.1.220, a bad `--model` is delivered as a **valid JSON `assistant` message** followed by a `result` line, and the process stays alive. `producedOutput` becomes true, the startup-failure branch is never reached, and the user already sees the CLI's own explanation as a normal message. Print mode (`-p`) and session mode disagree, and only print mode produces the plain-text failure.

So this task does not fix a reachable bug on the current CLI. Keep it as defense-in-depth for cases where a process really does die with plain text before reaching JSON-output mode — argv-parse failures, licensing errors, or an older CLI that doesn't wrap model errors in stream-json. It strictly widens what gets surfaced and weakens nothing. **Judge it on that basis; do not expect an end-to-end reproduction of the install-hint bug via a mistyped model.**

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/startup-failure-message.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildStartupFailureMessage } from "./agent-session-manager.js";

describe("buildStartupFailureMessage", () => {
  const CLAUDE_MODEL_ERROR =
    "There's an issue with the selected model (bogus). It may not exist or you may not have access to it.";

  it("includes an unparseable stdout tail in the details", () => {
    const msg = buildStartupFailureMessage("claude-code", "", CLAUDE_MODEL_ERROR);
    expect(msg).toContain(CLAUDE_MODEL_ERROR);
  });

  it("omits the install hint when the CLI explained itself", () => {
    // The CLI is clearly installed — it ran and printed a diagnosis. Telling
    // the user it "doesn't seem to be installed" is actively misleading.
    const msg = buildStartupFailureMessage("claude-code", "", CLAUDE_MODEL_ERROR);
    expect(msg).not.toContain("doesn't seem to be installed");
  });

  it("keeps the install hint when the process said nothing at all", () => {
    const msg = buildStartupFailureMessage("claude-code", "", "");
    expect(msg).toContain("Couldn't start");
    expect(msg).toContain("doesn't seem to be installed");
  });

  it("includes both streams when both produced output", () => {
    const msg = buildStartupFailureMessage("claude-code", "stderr line", "stdout line");
    expect(msg).toContain("stderr line");
    expect(msg).toContain("stdout line");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/startup-failure-message.test.ts`
Expected: FAIL — `buildStartupFailureMessage` is a private method and is not exported; it takes two parameters.

- [ ] **Step 3: Extract and widen the message builder**

In `packages/vibedeckx/src/agent-session-manager.ts`, remove the private method at lines 1366-1379 and add a module-scope exported function near the top of the file (after the imports):

```typescript
/**
 * Build a user-facing message for when an agent process fails to start.
 *
 * Both streams are folded in: claude reports an unusable --model on STDOUT
 * (verified 2026-07-26 against claude 2.1.220 — exit 1, stderr empty), and
 * that line is not stream-json so it never becomes a parsed event. Without the
 * stdout tail the user would see only a "did you install it?" hint for a CLI
 * that is plainly installed.
 *
 * The install hint is suppressed whenever the process produced any output at
 * all: a process that printed a diagnosis clearly launched, so the problem is
 * its arguments, not its absence.
 */
export function buildStartupFailureMessage(
  agentType: AgentType,
  stderrTail: string,
  stdoutTail: string,
): string {
  const provider = getProvider(agentType);
  const name = provider.getDisplayName();
  const details = [stdoutTail.trim(), stderrTail.trim()].filter(Boolean).join("\n");

  let msg = `Couldn't start ${name}.`;
  if (!details) {
    const hint = provider.getInstallHint?.();
    if (hint) msg += `\n\n${hint}`;
    return msg;
  }
  return `${msg}\n\nDetails:\n${details}`;
}
```

- [ ] **Step 4: Capture the unparseable stdout tail**

In `packages/vibedeckx/src/agent-session-manager.ts`, add a per-spawn tail alongside `stderrTail` (line 726):

```typescript
    let stderrTail = "";
    // Lines the provider could not parse into events. claude prints startup
    // diagnostics (e.g. an unusable --model) here as plain text, not
    // stream-json, so this is the only place that text survives.
    let unparsedStdoutTail = "";
```

`handleStdout` is a separate method, so it cannot close over that local. Store the tail on the session instead. Add to the `RunningSession` interface next to `producedOutput` (line 100):

```typescript
  /** Tail of stdout lines that produced no parsed events (reset per spawn). */
  unparsedStdoutTail?: string;
```

Replace the local declaration above with a reset next to `session.producedOutput = false;` (line 721):

```typescript
    session.producedOutput = false;
    session.unparsedStdoutTail = "";
```

In `handleStdout` (lines 1006-1017), record unparsed lines:

```typescript
    for (const line of lines) {
      if (!line.trim()) continue;

      const events = provider.parseStdoutLine(line, session.id);
      if (events.length > 0) {
        // The process produced real agent output, so it started successfully —
        // a later non-zero exit is a runtime error, not a "not installed" case.
        session.producedOutput = true;
      } else {
        // Keep a capped tail so a plain-text startup diagnosis (claude prints
        // model errors here) can be surfaced if the process fails to start.
        session.unparsedStdoutTail = ((session.unparsedStdoutTail ?? "") + line + "\n").slice(-4000);
      }
      for (const event of events) {
        await this.processAgentEvent(session.id, event);
      }
    }
```

- [ ] **Step 5: Pass both tails at the call sites**

In the `close` handler (line 806), replace the `message:` line with:

```typescript
            message: buildStartupFailureMessage(session.agentType, stderrTail, session.unparsedStdoutTail ?? ""),
```

In the `error` handler (line 858), replace the equivalent `this.buildStartupFailureMessage(...)` call with:

```typescript
          ? buildStartupFailureMessage(session.agentType, stderrTail, session.unparsedStdoutTail ?? "")
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter vibedeckx test -- src/startup-failure-message.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify against the real CLI**

Start the server, create a session with model `definitely-not-a-real-model`, and send one message. Expected: the conversation shows an error entry containing `There's an issue with the selected model` and **no** install hint.

If the frontend is not wired yet (it isn't until Task 8), drive it over the API instead:

```bash
curl -s -X POST localhost:5173/api/path/agent-sessions/new \
  -H 'Content-Type: application/json' \
  -d '{"path":"/tmp/p1","branch":null,"permissionMode":"edit","agentType":"claude-code","model":"definitely-not-a-real-model"}'
```

(This route gains its `model` field in Task 6 — if running Task 5 standalone, temporarily hardcode a model in `createNewSession` to reproduce.)

- [ ] **Step 8: Full suite and typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: no type errors; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/vibedeckx/src/agent-session-manager.ts \
        packages/vibedeckx/src/startup-failure-message.test.ts
git commit -m "fix(sessions): surface plain-stdout CLI startup errors instead of an install hint"
```

---

### Task 6: Routes — accept, return, and forward the model

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts:161-168` (providers), `:172-174`, `:297-299`, `:320-326`, `:458-467`, `:622-631`, `:685-691`, and the session-response builders at `:135`, `:235`, `:338`, `:607`, `:703`, `:768`
- Modify: `packages/vibedeckx/src/remote-agent-sessions.ts:44-51, 86`
- Test: `packages/vibedeckx/src/routes/agent-session-model-routes.test.ts` (create)

**Interfaces:**
- Consumes: `createNewSession(..., { model })` (Task 4); `MODEL_SUGGESTIONS` (Task 1).
- Produces:
  - `GET /api/agent-providers` → `{ providers: Array<{ type, displayName, available, models: string[] }> }`
  - All session-create bodies accept `model?: string | null`
  - All session responses include `model?: string | null`

**Note on the session list routes:** the two list serializers (`:276-286` and `:436-446`) spread the DB row with `...s`, so `model` flows into `BranchSessionSummary` automatically once Task 3 added it to the row mapper. No change is needed there — verify it rather than editing it.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/routes/agent-session-model-routes.test.ts`, following the Fastify decorate + inject pattern of `packages/vibedeckx/src/routes/agent-session-branch-routes.test.ts:21-52`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import agentSessionRoutes from "./agent-session-routes.js";

const SESSION_ID = "created-session";

function makeApp() {
  // Records the createNewSession opts so the model's journey into the manager
  // can be asserted without spawning anything.
  const createNewSession = vi.fn(async () => SESSION_ID);
  let created: { model?: string | null } = {};

  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {
    projects: { getById: async () => ({ id: "p1", path: "/tmp/p1" }) },
    agentSessions: { getById: async () => ({ id: SESSION_ID, project_id: "p1" }) },
  });
  app.decorate("agentSessionManager", {
    createNewSession: vi.fn(async (...args: unknown[]) => {
      created = (args[8] ?? {}) as { model?: string | null };
      return SESSION_ID;
    }),
    getSession: () => ({
      id: SESSION_ID,
      projectId: "p1",
      branch: null,
      status: "running",
      permissionMode: "edit",
      agentType: "claude-code",
      model: created.model ?? null,
    }),
    getMessages: () => [],
    getSessionProcessAlive: () => true,
  });
  app.decorate("remoteSessionMap", new Map());
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);

  return { app, createNewSession, opts: () => created };
}

describe("agent session model routes", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it("GET /api/agent-providers returns a suggestion list per provider", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: "/api/agent-providers" });

    expect(res.statusCode).toBe(200);
    const providers = res.json().providers as Array<{ type: string; models: string[] }>;
    expect(providers.find((p) => p.type === "claude-code")?.models).toEqual(["opus", "sonnet", "haiku"]);
    expect(providers.find((p) => p.type === "codex")?.models.length).toBeGreaterThan(0);
  });

  it("passes the model into createNewSession and echoes it back", async () => {
    let opts: () => { model?: string | null };
    ({ app, opts } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null, permissionMode: "edit", agentType: "claude-code", model: "opus" },
    });

    expect(res.statusCode).toBe(200);
    expect(opts().model).toBe("opus");
    expect(res.json().session.model).toBe("opus");
  });

  it("accepts a model the CLI will reject (no server-side validation)", async () => {
    let opts: () => { model?: string | null };
    ({ app, opts } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null, model: "not-a-real-model" },
    });

    expect(res.statusCode).toBe(200);
    expect(opts().model).toBe("not-a-real-model");
  });

  it("omitting the model yields a null model", async () => {
    ({ app } = makeApp());
    await app.register(agentSessionRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agent-sessions/new",
      payload: { branch: null },
    });

    expect(res.json().session.model ?? null).toBeNull();
  });
});
```

`createNewSession`'s `opts` is its ninth parameter, hence `args[8]`. If the route passes arguments differently, read them off the recorded call rather than by index.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/routes/agent-session-model-routes.test.ts`
Expected: FAIL — `models` is missing from the providers response; `session.model` is undefined.

- [ ] **Step 3: Add suggestions to the providers endpoint**

In `packages/vibedeckx/src/routes/agent-session-routes.ts`, add the import at the top:

```typescript
import { MODEL_SUGGESTIONS } from "../protocol/model-suggestions.js";
```

and replace the handler at lines 161-168:

```typescript
  fastify.get("/api/agent-providers", async (_req, reply) => {
    const providers = getAllProviders().map((provider) => {
      const type = provider.getAgentType();
      return {
        type,
        displayName: provider.getDisplayName(),
        available: provider.isAvailable?.() ?? provider.detectBinary() !== null,
        // Suggestions only. The picker also accepts free text, and nothing
        // validates against this list — the session's real capabilities depend
        // on the CLI version and account tier of whichever machine spawns it,
        // which this server cannot know.
        models: MODEL_SUGGESTIONS[type as keyof typeof MODEL_SUGGESTIONS] ?? [],
      };
    });
    return reply.code(200).send({ providers });
  });
```

- [ ] **Step 4: Accept `model` in every create body**

Add `model?: string | null` to each of these `Body` types and destructure it from `req.body`:

- line 172-174 (`POST /api/path/agent-sessions`)
- line 297-299 (`POST /api/path/agent-sessions/new`)
- line 458-467 (`POST /api/projects/:projectId/agent-sessions`)
- line 622-631 (`POST /api/projects/:projectId/agent-sessions/new`)

For example, line 297-299 becomes:

```typescript
    Body: { path: string; branch?: string | null; permissionMode?: "plan" | "edit"; agentType?: string; force?: boolean; sessionId?: string; crossRemoteMcp?: CrossRemoteMcpConfig; model?: string | null };
  }>("/api/path/agent-sessions/new", async (req, reply) => {
    const { path: projectPath, branch, permissionMode, agentType, force, sessionId, crossRemoteMcp, model } = req.body;
```

- [ ] **Step 5: Pass `model` into `createNewSession`**

Both `createNewSession` calls (lines 320-326 and 685-691) end with an `opts` object. Add `model` to each:

```typescript
        { sessionId, crossRemoteMcp, model },
```

If a call site currently passes no `opts` object, add `{ model }` as the ninth argument.

- [ ] **Step 6: Return `model` in every session response**

Each response builder that emits `permissionMode: session?.permissionMode || "edit"` (lines 135, 235, 338, 607, 703, 768) should gain, immediately after it:

```typescript
          model: session?.model ?? null,
```

At line 768 the variable is non-optional (`session.permissionMode`), so use `model: session.model ?? null,`.

- [ ] **Step 7: Forward `model` to remote workers**

In `packages/vibedeckx/src/remote-agent-sessions.ts`, add to the params type (after line 46):

```typescript
    model?: string | null;
```

add `model` to the destructuring on line 51, and add it to the forwarded body on line 86:

```typescript
      { path: remoteConfig.remote_path, branch, permissionMode, agentType, force, sessionId: remoteSessionId, crossRemoteMcp, model },
```

Then update the caller at `agent-session-routes.ts:517` to pass `model` in its params object as well.

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter vibedeckx test -- src/routes/agent-session-model-routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Verify the list route carries the model without edits**

Run:

```bash
curl -s localhost:5173/api/projects/p1/agent-sessions?branch= | head -c 400
```

Expected: session objects include a `model` field (null for sessions created before this feature).

- [ ] **Step 10: Full suite and typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && pnpm --filter vibedeckx test`
Expected: no type errors; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/vibedeckx/src/routes/agent-session-routes.ts \
        packages/vibedeckx/src/remote-agent-sessions.ts \
        packages/vibedeckx/src/routes/agent-session-model-routes.test.ts
git commit -m "feat(api): accept, return, and proxy a per-session model"
```

---

### Task 7: Frontend data layer — types, create call, and hook

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:718-722` (`AgentProviderInfo`), `:837-850` (`BranchSessionSummary`), `:866-891` (`createNewAgentSession`)
- Modify: `apps/vibedeckx-ui/hooks/use-agent-session.ts:43-44` (`AgentSession`), `:1055-1073` (`ensureSession`), `:1114-1115`
- Test: `apps/vibedeckx-ui/hooks/use-agent-session.model.test.tsx` (create)

**Interfaces:**
- Consumes: the API shapes from Task 6.
- Produces:
  - `AgentProviderInfo { type, displayName, available, models: string[] }`
  - `createNewAgentSession(projectId, branch, permissionMode?, agentType?, force?, model?)`
  - `ensureSession(permissionMode?, model?)` on the `useAgentSession` return value
  - `AgentSession.model?: string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/vibedeckx-ui/hooks/use-agent-session.model.test.tsx`, mirroring the Probe/`act` setup of `apps/vibedeckx-ui/hooks/use-agent-session.ensure-session.test.tsx:1-90` (this repo has no `@testing-library` — component and hook tests drive `react-dom/client` directly):

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createNewAgentSession: vi.fn(),
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});

import { createNewAgentSession, authFetch } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const createSession = vi.mocked(createNewAgentSession);
const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;

function Probe() {
  const hook = useAgentSession("p1", "main");
  useEffect(() => { latest = hook; });
  return null;
}

let root: Root | null = null;

async function render() {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => { r.render(<Probe />); });
}

beforeEach(() => {
  createSession.mockReset();
  // Keeps the hook in the empty-placeholder state so ensureSession is the only
  // create path exercised.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ session: null, messages: [] }),
  } as unknown as Response);
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  latest = null;
});

describe("useAgentSession model", () => {
  it("sends the chosen model in the create request", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });

    await act(async () => { await latest!.ensureSession("edit", "opus"); });

    expect(createSession).toHaveBeenCalledWith("p1", "main", "edit", undefined, undefined, "opus");
  });

  it("sends no model when none was chosen", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running" },
      messages: [],
    });

    await act(async () => { await latest!.ensureSession("edit"); });

    expect(createSession).toHaveBeenCalledWith("p1", "main", "edit", undefined, undefined, undefined);
  });

  it("exposes the model returned by the server on the session object", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "sonnet" },
      messages: [],
    });

    let created: { model?: string | null } | null = null;
    await act(async () => { created = await latest!.ensureSession("edit", "sonnet"); });

    expect(created!.model).toBe("sonnet");
  });
});
```

The hook is constructed without an `agentType`, so the 4th argument to `createNewAgentSession` is `undefined`; if the `Probe` passes one, update the assertions to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- hooks/use-agent-session.model.test.tsx`
Expected: FAIL — `ensureSession` takes one argument; `session.model` is undefined.

- [ ] **Step 3: Extend the API types and create call**

In `apps/vibedeckx-ui/lib/api.ts`, replace `AgentProviderInfo` (lines 718-722):

```typescript
export interface AgentProviderInfo {
  type: AgentType;
  displayName: string;
  available: boolean;
  /**
   * Suggested model names for this agent. NOT a whitelist — the picker also
   * accepts free text, and nothing validates against this list.
   */
  models?: string[];
}
```

Add to `BranchSessionSummary` (after `agent_type` on line 844):

```typescript
  model?: string | null;
```

Replace `createNewAgentSession` (lines 866-891) so it accepts and sends `model`:

```typescript
export async function createNewAgentSession(
  projectId: string,
  branch: string | null,
  permissionMode?: "plan" | "edit",
  agentType?: string,
  force?: boolean,
  model?: string | null,
): Promise<{
  session: { id: string; projectId: string; branch: string | null; status: string; permissionMode?: string; agentType?: string; model?: string | null; processAlive?: boolean };
  messages: unknown[];
}> {
  const res = await authFetch(`${getApiBase()}/api/projects/${projectId}/agent-sessions/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, permissionMode, agentType, force, model }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.errorCode === "resident_limit_reached") {
      throw new ResidentLimitError(
        body.maxResidentAgentProcesses,
        Array.isArray(body.runningSessions) ? body.runningSessions : [],
      );
    }
    throw new Error(`createNewAgentSession failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 4: Thread the model through the hook**

In `apps/vibedeckx-ui/hooks/use-agent-session.ts`, add to the `AgentSession` interface (after line 44):

```typescript
  model?: string | null;
```

Change the `ensureSession` callback signature (line 1055-1056):

```typescript
  const ensureSession = useCallback((
    permissionMode?: "plan" | "edit",
    model?: string | null,
```

Pass `model` to both `createNewAgentSession` calls (lines 1073 and 1100):

```typescript
          data = await createNewAgentSession(projectId, branch, permissionMode, agentType, undefined, model);
```

```typescript
          data = await createNewAgentSession(projectId, branch, permissionMode, agentType, true, model);
```

and add to the session object literal (after line 1115):

```typescript
          model: data.session.model ?? null,
```

`ensureSession` has a single-flight guard keyed on an in-flight ref (line 1047). Include the model in whatever key that guard uses so two first-sends with different models cannot collapse into one — inspect `ensureSessionInFlightRef` and extend its stored shape accordingly.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter vibedeckx-ui test -- hooks/use-agent-session.model.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, lint, and full frontend suite**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd - && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test`
Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts \
        apps/vibedeckx-ui/hooks/use-agent-session.ts \
        apps/vibedeckx-ui/hooks/use-agent-session.model.test.tsx
git commit -m "feat(ui): thread a per-session model through the agent session API and hook"
```

---

### Task 8: Model picker component and header integration

**Files:**
- Create: `apps/vibedeckx-ui/components/ui/popover.tsx`
- Create: `apps/vibedeckx-ui/components/agent/model-picker.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx:148` (state), `:217` (providers fetch), `:427-433` (`ensureSession` call), `:715-718` (header)
- Test: `apps/vibedeckx-ui/components/agent/model-picker.test.tsx` (create)

**Interfaces:**
- Consumes: `AgentProviderInfo.models` and `ensureSession(permissionMode, model)` (Task 7).
- Produces: `<ModelPicker agentType models value onChange locked />`

**Design constraints (settled in the design discussion):**
- The chip is **always rendered**, showing `Default` when no model is chosen — consistency was chosen over saving header space.
- Before the session exists it is an **editable combobox**; afterwards it is **plain muted text with no border, chevron, or hover state**. It must not be a `disabled` dropdown: a disabled control keeps its affordances and reads as "temporarily unavailable", inviting the user to keep clicking. This visual difference is the *only* signal that the model is immutable, so it has to be unambiguous.
- The combobox must accept free text, which is why it is Popover + cmdk rather than a Radix `DropdownMenu` — the menu's typeahead swallows keystrokes intended for an input.
- The label is agent-relative (`Default` means "Claude Code's default" or "Codex's default"), which is why the chip sits immediately right of the agent dropdown.

- [ ] **Step 1: Write the failing test**

Create `apps/vibedeckx-ui/components/agent/model-picker.test.tsx`, following the raw `react-dom/client` + `act` idiom of `apps/vibedeckx-ui/components/search/quick-switcher.test.tsx:1-53` (this repo has **no** `@testing-library` — do not add one).

Driving a cmdk popover through synthetic events is brittle, so the selection logic is exported as pure functions and tested directly; the DOM assertions cover the part that actually matters visually — that the locked form is not a control:

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, modelLabel, shouldOfferCustom } from "./model-picker";

describe("model picker logic", () => {
  it("labels a null model as Default", () => {
    expect(modelLabel(null)).toBe("Default");
    expect(modelLabel("opus")).toBe("opus");
  });

  it("offers a custom entry only for a non-empty query outside the suggestions", () => {
    expect(shouldOfferCustom("my-model", ["opus"])).toBe(true);
    expect(shouldOfferCustom("opus", ["opus"])).toBe(false);
    expect(shouldOfferCustom("", ["opus"])).toBe(false);
    expect(shouldOfferCustom("   ", ["opus"])).toBe(false);
  });
});

describe("ModelPicker rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders a clickable trigger before the session exists", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value={null} onChange={vi.fn()} locked={false} />,
      );
    });

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Default");
  });

  it("renders static text — not a disabled control — once locked", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value="opus" onChange={vi.fn()} locked />,
      );
    });

    // A disabled <button> would keep its border and chevron and read as
    // "temporarily unavailable", inviting clicks on something that can never
    // change. The locked form must not be a control at all.
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("opus");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("branch to change");
  });

  it("shows Default rather than nothing when locked with no model", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value={null} onChange={vi.fn()} locked />,
      );
    });

    expect(container.textContent).toContain("Default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/model-picker.test.tsx`
Expected: FAIL — module `./model-picker` not found.

- [ ] **Step 3: Add the Popover primitive**

Create `apps/vibedeckx-ui/components/ui/popover.tsx`. The repo uses the unified `radix-ui` package (see `components/ui/tooltip.tsx:4` for the import idiom), which already ships Popover — no new dependency:

```tsx
"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-0 shadow-md outline-hidden",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
```

- [ ] **Step 4: Build the model picker**

Create `apps/vibedeckx-ui/components/agent/model-picker.tsx`:

```tsx
"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

interface ModelPickerProps {
  agentType: AgentType;
  /** Suggestions only — free text is always allowed. */
  models: string[];
  /** null = use the agent CLI's own default. */
  value: string | null;
  onChange: (model: string | null) => void;
  /**
   * true once the session exists. The model is a spawn argument, so it cannot
   * change for a live session — the chip becomes static text rather than a
   * disabled control, which would still look clickable.
   */
  locked: boolean;
}

const DEFAULT_LABEL = "Default";

/**
 * The chip always shows something, even with no model chosen — a blank slot
 * would read as "this build has no model feature" rather than "this session
 * uses the CLI default".
 */
export function modelLabel(value: string | null): string {
  return value ?? DEFAULT_LABEL;
}

/**
 * Suggestions are not a whitelist, so any string the user types is offerable —
 * except one that is blank or already in the list.
 */
export function shouldOfferCustom(query: string, models: string[]): boolean {
  const trimmed = query.trim();
  return trimmed.length > 0 && !models.includes(trimmed);
}

export function ModelPicker({ agentType, models, value, onChange, locked }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const label = modelLabel(value);

  if (locked) {
    return (
      <span
        className="text-xs text-muted-foreground px-1"
        title="Fixed for this session — branch to change"
      >
        {label}
      </span>
    );
  }

  const trimmed = query.trim();
  const showCustom = shouldOfferCustom(query, models);

  const pick = (model: string | null) => {
    onChange(model);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5",
            "text-xs font-medium transition-colors hover:bg-muted",
          )}
        >
          {label}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56">
        <Command shouldFilter>
          <CommandInput
            placeholder={`Model for ${agentType === "codex" ? "Codex" : "Claude Code"}…`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No suggestion matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT_LABEL} onSelect={() => pick(null)} className="text-xs">
                {DEFAULT_LABEL}
              </CommandItem>
              {models.map((m) => (
                <CommandItem key={m} value={m} onSelect={() => pick(m)} className="text-xs">
                  {m}
                </CommandItem>
              ))}
            </CommandGroup>
            {showCustom && (
              // Suggestions are not a whitelist: whether a name works depends
              // on the CLI version and account tier of the machine that spawns
              // the session, so any string is allowed through.
              <CommandGroup heading="Custom">
                <CommandItem value={trimmed} onSelect={() => pick(trimmed)} className="text-xs">
                  Use &quot;{trimmed}&quot;
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/model-picker.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire it into the conversation header**

In `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`:

Add the import:

```typescript
import { ModelPicker } from "./model-picker";
```

Add state next to the existing `providers` state (line 148):

```typescript
  // Pre-session model choice. Mirrors how agentType is pre-selected before a
  // session exists (see the agent dropdown's `if (!session)` branch). Reset to
  // null on New Conversation so a choice never leaks into the next session —
  // the last pick is deliberately not remembered.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
```

In `handleNewConversation` (line 405-419), add `setPendingModel(null);` immediately after `await startNewConversation();`.

Pass the model when creating the session. In the imperative handle (lines 427-433):

```typescript
        const newSession = await ensureSession(permissionMode, pendingModel);
```

and add `pendingModel` to that `useImperativeHandle` dependency array (line 438). Do the same for the other `ensureSession(...)` call in `handleSubmit` (near line 615) — grep for `ensureSession(` to catch every call site.

Render the chip immediately after the agent dropdown block and before `<PermissionModeToggle .../>` (line 715):

```tsx
          <ModelPicker
            agentType={agentType}
            models={providers.find((p) => p.type === agentType)?.models ?? []}
            value={session ? (session.model ?? null) : pendingModel}
            onChange={setPendingModel}
            locked={session != null}
          />
```

- [ ] **Step 7: Verify in the running app**

Run the app (`pnpm dev:all`), then:

1. Open a workspace with no session — the header shows `[Claude Code ▾] [Default ▾]`.
2. Click the model chip, pick `opus`, send a message. The chip becomes static `opus` text with no border or chevron; hovering shows "Fixed for this session — branch to change".
3. Click New Conversation — the chip returns to an editable `Default`, confirming the choice is not remembered.
4. Type a nonsense model, send a message: the conversation shows an error entry containing the CLI's own message (this exercises Task 5).

- [ ] **Step 8: Typecheck, lint, and full frontend suite**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd - && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test`
Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/vibedeckx-ui/components/ui/popover.tsx \
        apps/vibedeckx-ui/components/agent/model-picker.tsx \
        apps/vibedeckx-ui/components/agent/model-picker.test.tsx \
        apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(ui): add a per-session model picker to the conversation header"
```

---

### Task 9: Header space reclamation and model in the session list

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx:726-770` (connection status)
- Modify: `apps/vibedeckx-ui/components/agent/session-history-dropdown.tsx:387-395` (row tooltip)

**Interfaces:**
- Consumes: `BranchSessionSummary.model` (Task 7); the header layout from Task 8.
- Produces: no new exports.

**Why:** Task 8 added a fifth control to a `h-10` header. The connection status currently renders an icon *and* a word, and the word is least informative in the expected state. Collapsing it to an icon reclaims the space. The catch: the five status states map to only three icon appearances — `Connecting` and `Reconnecting` are both amber pulsing `Wifi`, and `Disconnected` vs `Remote disconnected` differ only in color. Dropping the text without a tooltip would destroy real information, so `statusText` (already computed) moves into `title`.

- [ ] **Step 1: Collapse the connection status to an icon with a tooltip**

In `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`, replace the returned JSX at the end of the status IIFE (lines 765-770) with:

```tsx
            return (
              // Icon-only to leave header room for the model chip. statusText
              // moves to the tooltip rather than being dropped: Connecting and
              // Reconnecting share an icon, as do the two disconnected states,
              // so the text is the only thing that tells them apart.
              <span className={`flex items-center ${statusColor}`} title={statusText}>
                {statusIcon}
              </span>
            );
```

Leave the `statusColor` / `statusIcon` / `statusText` computation above it untouched.

- [ ] **Step 2: Verify each status is still distinguishable**

Run the app and confirm by hover:

1. Normal load → green Wifi icon, tooltip "Connected".
2. Stop the backend → icon changes, tooltip reads "Disconnected" or "Reconnecting...".
3. Confirm no status text renders inline in any state, and the header fits the model chip without wrapping at a narrow window width.

- [ ] **Step 3: Add the model to the session-list row tooltip**

In `apps/vibedeckx-ui/components/agent/session-history-dropdown.tsx`, replace the `title` expression at lines 389-393:

```tsx
                    title={`${
                      s.updated_at
                        ? new Date(s.updated_at).toLocaleString()
                        : new Date(s.created_at).toLocaleString()
                    } • ${s.entry_count ?? 0} messages • status: ${s.status} • model: ${s.model ?? "Default"}`}
```

The model goes in the existing tooltip rather than an inline label: the list is a scanning surface where an extra badge on every row costs more than it informs, and hover-only means the "show Default for consistency" rule costs nothing here.

- [ ] **Step 4: Verify the tooltip**

Run the app, open the session history dropdown, and hover a row.
Expected: the tooltip ends with `• model: opus` for a session created with a model, and `• model: Default` for one created without.

- [ ] **Step 5: Typecheck, lint, and full frontend suite**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit && cd - && pnpm --filter vibedeckx-ui lint && pnpm --filter vibedeckx-ui test`
Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx \
        apps/vibedeckx-ui/components/agent/session-history-dropdown.tsx
git commit -m "feat(ui): collapse connection status to an icon and show session model on hover"
```

---

## Final Verification

- [ ] **Full backend suite:** `pnpm --filter vibedeckx test`
- [ ] **Full frontend suite:** `pnpm --filter vibedeckx-ui test`
- [ ] **Both typechecks:** `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && cd apps/vibedeckx-ui && npx tsc --noEmit`
- [ ] **Lint:** `pnpm --filter vibedeckx-ui lint`
- [ ] **Production build:** `pnpm build`
- [ ] **End-to-end, Claude:** create a session with model `haiku`, send a message, confirm it answers. Then create one with `definitely-not-a-real-model` and confirm the conversation shows the CLI's own "There's an issue with the selected model" text and **no** install hint.
- [ ] **End-to-end, Codex:** create a session with a bogus model, send a message. The process starts, the turn fails, and the conversation shows the server's 400 error text. (Codex reports this through `turn/completed`'s `turn.error.message`, which the existing `handleTurnCompleted` already surfaces — no code in this plan touches that path.)
- [ ] **Isolation:** with a live session pinned to a non-default model, create a second session in another workspace without choosing one. Confirm the second spawns with no model flag (check the server log line `[AgentSession] ... version:` and the spawn args) and that the first session's chip is unchanged.
- [ ] **Persistence:** restart the server, reopen a session created with a model, send a message, and confirm it still runs on that model rather than silently reverting to the default.
- [ ] **Branch inheritance:** branch a session that has a model, confirm the branch's chip shows the same model.

## Known Follow-Ups (explicitly out of scope)

- **Mid-session model switching.** The column is a plain updatable `TEXT` column, so this needs no migration — only a repository update method and a route. Codex could support it without a respawn via `thread/settings/update` (the params include `model` and `effort`), but that method's wire format was never verified — only its TypeScript binding names were read out of the codex binary. Claude would need a full process restart either way.
- **Nested JSON in codex error messages.** `turn.error.message` arrives as a JSON string wrapped inside the message field, so the user sees a raw blob rather than the readable sentence inside it. This is a pre-existing issue affecting all codex server errors, not just model errors.
- **`CodexProvider.lastPermissionMode`.** A module-scope singleton holding per-session state written on every spawn (`codex-provider.ts:46, 72`) and read later (`:397`). This plan deliberately avoids the pattern for `model`, but the existing `permissionMode` leak remains.
- **`/api/agent-providers` scoping.** Its `available` field is computed from the front server's local `detectBinary()`, which is wrong under SaaS deployments where a reverse-connect worker does the spawning. The "no validation" stance makes this harmless for model selection, but the field is still misleading (`review-dialog.tsx:20` already hardcodes a `available: true` fallback around it).
