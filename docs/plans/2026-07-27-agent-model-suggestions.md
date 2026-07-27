# Agent Model Suggestions Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the Claude Code and Codex model suggestions returned to the model picker.

**Architecture:** Keep the existing server-owned `MODEL_SUGGESTIONS` constant as the single source of truth. Verify the complete ordered lists through the existing `/api/agent-providers` route test, then update only that constant; the frontend continues consuming the lists through the existing API.

**Tech Stack:** TypeScript, Fastify, Vitest, pnpm

---

### Task 1: Update provider model suggestions

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-model-routes.test.ts:49-61`
- Modify: `packages/vibedeckx/src/protocol/model-suggestions.ts:14-17`

**Step 1: Write the failing route test**

Replace the current provider-model assertions with exact assertions for both
providers:

```typescript
expect(providers.find((p) => p.type === "claude-code")?.models).toEqual([
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);
expect(providers.find((p) => p.type === "codex")?.models).toEqual([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
]);
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter vibedeckx test -- src/routes/agent-session-model-routes.test.ts
```

Expected: FAIL because Claude Code lacks `fable`, while Codex still contains
`gpt-5.6-codex` and `o3` and lacks the three newly requested models.

**Step 3: Update the shared suggestion lists**

Change the constant to:

```typescript
export const MODEL_SUGGESTIONS: Record<"claude-code" | "codex", readonly string[]> = {
  "claude-code": ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
} as const;
```

Do not add validation or a frontend copy. The existing picker must continue to
accept free-form model names.

**Step 4: Run the focused test to verify it passes**

Run:

```bash
pnpm --filter vibedeckx test -- src/routes/agent-session-model-routes.test.ts
```

Expected: all tests in the file PASS.

**Step 5: Run backend verification**

Run:

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
pnpm --filter vibedeckx test -- src/routes/agent-session-model-routes.test.ts
git diff --check
```

Expected: every command exits with status 0.

**Step 6: Commit the implementation**

```bash
git add packages/vibedeckx/src/protocol/model-suggestions.ts \
  packages/vibedeckx/src/routes/agent-session-model-routes.test.ts \
  docs/plans/2026-07-27-agent-model-suggestions.md
git commit -m "feat: update agent model suggestions"
```
