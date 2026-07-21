# Codex Image View Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display Codex `imageView` events as a normal `View Image` tool row containing the viewed file path.

**Architecture:** Convert the Codex app-server item into the existing provider-neutral `tool_use` event, so persistence and WebSocket delivery need no changes. Add one dedicated branch in the existing Agent tool renderer; no new message type, image endpoint, or image data handling is introduced.

**Tech Stack:** TypeScript, Vitest, React 19, Tailwind CSS, Lucide React

---

### Task 1: Parse Codex image-view items

**Files:**
- Modify: `packages/vibedeckx/src/providers/codex-provider.test.ts`
- Modify: `packages/vibedeckx/src/providers/codex-provider.ts:190-283`

**Step 1: Write the failing test**

Add a provider test that sends:

```ts
{
  jsonrpc: "2.0",
  method: "item/completed",
  params: {
    turnId: "turn-1",
    item: { type: "imageView", id: "image-1", path: "/tmp/screenshot.png" },
  },
}
```

and expects:

```ts
[
  {
    type: "tool_use",
    tool: "ImageView",
    input: { path: "/tmp/screenshot.png" },
    toolUseId: "image-1",
  },
]
```

**Step 2: Run the test to verify it fails**

Run: `pnpm --filter vibedeckx test -- src/providers/codex-provider.test.ts`

Expected: FAIL because the provider currently returns `{ type: "system", content: "[imageView]" }`.

**Step 3: Write the minimal implementation**

Add an `imageView` case in `handleItemCompleted` that returns one `tool_use` event with `tool: "ImageView"`, `input: { path: item.path ?? "" }`, and a stable id from `item.id` or `generateId()`.

**Step 4: Run the provider test**

Run: `pnpm --filter vibedeckx test -- src/providers/codex-provider.test.ts`

Expected: PASS.

### Task 2: Render the dedicated tool row

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/agent-message.image-view.test.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-message.tsx:1-500`
- Modify: `packages/vibedeckx/src/protocol/claude-code/schema.ts:47-68`

**Step 1: Write the failing UI test**

Render an `AgentMessageItem` with:

```ts
{
  type: "tool_use",
  tool: "ImageView",
  input: { path: "/tmp/screenshot.png" },
  toolUseId: "image-1",
  timestamp: Date.now(),
}
```

Assert that the output contains `View Image` and `/tmp/screenshot.png`, and does not contain `Tool: ImageView` or `Input`.

**Step 2: Run the test to verify it fails**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/agent-message.image-view.test.tsx`

Expected: FAIL because the generic tool renderer includes `Tool: ImageView` and `Input`.

**Step 3: Write the minimal implementation**

Add an `ImageView` branch to `ToolUseMessage` using the existing tool-row structure. Render an image icon, `View Image`, and the path extracted defensively from the tool input as wrapping monospace text.

Add `ImageView` to `FRONTEND_RENDERED_TOOLS` so the existing frontend/protocol contract test recognizes the dedicated renderer. This registry update must not alter Claude Code parsing.

**Step 4: Run the UI test**

Run: `pnpm --filter vibedeckx-ui test -- components/agent/agent-message.image-view.test.tsx`

Expected: PASS.

### Task 3: Verify the integrated change

**Files:**
- Verify all changed implementation and test files.

**Step 1: Run targeted tests together**

```bash
pnpm --filter vibedeckx test -- src/providers/codex-provider.test.ts
pnpm --filter vibedeckx-ui test -- components/agent/agent-message.image-view.test.tsx
```

Expected: both test files pass.

**Step 2: Run type checking and diff validation**

```bash
npx tsc --noEmit
git diff --check
```

Expected: both commands exit successfully.

**Step 3: Review scope**

Confirm the diff adds only the image-view event mapping, its dedicated renderer, tests, and these planning documents. Confirm there is no image file access, URL generation, or Claude Code behavior change.
