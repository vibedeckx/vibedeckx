# Paste-to-File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-convert long clipboard pastes (>2000 chars) into temp files on the agent's execution machine (local or remote), keeping only a path marker in conversation history.

**Architecture:** Paste interception inserts a placeholder token in the textarea; on submit, each paste is uploaded via a new backend route (which proxies to the remote machine when the session is remote) and written to `os.tmpdir()/vibedeckx-pastes/<uuid>.txt`. Tokens in the text are replaced with `<vpaste path="…" size="…" />` markers; the user-message renderer parses these and displays a compact file chip in place of the marker.

**Tech Stack:** TypeScript, Fastify (backend), React + Next.js (frontend), existing remote-proxy infrastructure.

**Spec:** `docs/superpowers/specs/2026-04-23-paste-to-file-design.md`

**Test framework note:** The project has no automated test framework (`CLAUDE.md`: "No test framework is configured."). Instead of TDD, each task includes an explicit manual verification step before commit. Do not skip these — they are the quality gate.

---

## File Structure

New files:
- `packages/vibedeckx/src/utils/paste-file.ts` — helper that writes a paste to `os.tmpdir()/vibedeckx-pastes/<uuid>.txt`.
- `apps/vibedeckx-ui/components/agent/vpaste-chip.tsx` — small component that renders a `<vpaste …/>` marker as a file chip.

Modified files:
- `packages/vibedeckx/src/routes/agent-session-routes.ts` — register `POST /api/agent-sessions/:sessionId/paste` (remote-proxy aware).
- `apps/vibedeckx-ui/hooks/use-agent-session.ts` — add `uploadPaste(sessionId, content)` helper.
- `apps/vibedeckx-ui/components/ai-elements/prompt-input.tsx` — extend `PromptInputTextarea` with an optional `onPasteText` callback prop.
- `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — own the `pastes` state, wire the paste interception via `onPasteText`, transform the text before send.
- `apps/vibedeckx-ui/components/agent/agent-message.tsx` — parse `<vpaste …/>` in `UserMessage` and render chips inline.

---

## Task 1: Backend helper `writePasteToTempFile`

**Files:**
- Create: `packages/vibedeckx/src/utils/paste-file.ts`

- [ ] **Step 1: Create the helper**

Write this file verbatim:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PASTE_DIR = path.join(tmpdir(), "vibedeckx-pastes");

export interface WrittenPaste {
  path: string;
  size: number;
}

export async function writePasteToTempFile(content: string): Promise<WrittenPaste> {
  await mkdir(PASTE_DIR, { recursive: true });
  const filePath = path.join(PASTE_DIR, `${randomUUID()}.txt`);
  await writeFile(filePath, content, "utf8");
  return { path: filePath, size: Buffer.byteLength(content, "utf8") };
}
```

- [ ] **Step 2: Backend type-check**

Run from repo root:

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: exits 0 with no errors.

- [ ] **Step 3: Smoke test the helper via a one-off script**

Run:

```bash
node --input-type=module -e "import('./packages/vibedeckx/dist/utils/paste-file.js').catch(() => {}); import('./packages/vibedeckx/src/utils/paste-file.ts')" 2>&1 || true
```

If the above does not work because the build hasn't produced `dist/`, run the build first:

```bash
pnpm build:main && node -e "import('./packages/vibedeckx/dist/utils/paste-file.js').then(async m => { const r = await m.writePasteToTempFile('hello paste'); console.log(r); const fs = await import('fs/promises'); console.log(await fs.readFile(r.path, 'utf8')); await fs.unlink(r.path); })"
```

Expected output includes a `{ path: '/tmp/vibedeckx-pastes/<uuid>.txt', size: 11 }` object followed by the string `hello paste`, and the file is unlinked cleanly.

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/utils/paste-file.ts
git commit -m "feat(paste): add writePasteToTempFile helper"
```

---

## Task 2: Backend route `POST /api/agent-sessions/:sessionId/paste`

**Files:**
- Modify: `packages/vibedeckx/src/routes/agent-session-routes.ts` — insert new route after the `/message` route (around line 636, immediately before `/stop`).

- [ ] **Step 1: Add the import**

At the top of `packages/vibedeckx/src/routes/agent-session-routes.ts`, after the existing imports (line 1-8 region), add:

```ts
import { writePasteToTempFile } from "../utils/paste-file.js";
```

- [ ] **Step 2: Register the route**

Locate the end of the `/message` route (the closing `});` at approximately line 636) and the start of the `/stop` route (approximately line 639). Insert this block between them:

```ts
// Save a pasted blob of text to a temp file on the agent's execution machine.
// For remote sessions, proxies through so the file lands on the remote host.
fastify.post<{
  Params: { sessionId: string };
  Body: { content: string };
}>("/api/agent-sessions/:sessionId/paste", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
  const { content } = req.body;

  if (typeof content !== "string" || content.length === 0) {
    return reply.code(400).send({ error: "content must be a non-empty string" });
  }

  if (req.params.sessionId.startsWith("remote-")) {
    const remoteInfo = fastify.remoteSessionMap.get(req.params.sessionId);
    if (!remoteInfo) {
      return reply.code(404).send({ error: "Remote session not found" });
    }
    const result = await proxyAuto(
      remoteInfo.remoteServerId,
      remoteInfo.remoteUrl,
      remoteInfo.remoteApiKey,
      "POST",
      `/api/agent-sessions/${remoteInfo.remoteSessionId}/paste`,
      { content }
    );
    if (!result.ok) {
      const status = result.status || 502;
      return reply.code(status).send({
        error: `Remote proxy failed: ${result.errorCode || "unknown"}`,
        errorCode: result.errorCode,
        attempts: result.attempts,
        totalDurationMs: result.totalDurationMs,
        detail: result.data,
      });
    }
    return reply.code(result.status || 200).send(result.data);
  }

  try {
    const written = await writePasteToTempFile(content);
    return reply.code(200).send(written);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.error({ err }, "[paste] failed to write temp file");
    return reply.code(500).send({ error: `Failed to write paste: ${msg}` });
  }
});
```

- [ ] **Step 3: Backend type-check**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: exits 0.

- [ ] **Step 4: Manual verification against a local session**

Start the backend in dev mode (in a terminal):

```bash
pnpm dev:server
```

From another terminal, create a local session via the existing endpoint (requires a running vibedeckx with a registered project — use an existing session from the DB if there is one) and then hit the new endpoint. Simplest check without a session:

```bash
curl -i -X POST http://localhost:5173/api/agent-sessions/nonexistent/paste \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello from curl"}'
```

Expected: HTTP 200 with JSON body `{"path":"/tmp/vibedeckx-pastes/<uuid>.txt","size":15}`. The session id is not validated for local sessions (the file is written regardless, since the path is independent of any session). Verify the file exists:

```bash
ls -la /tmp/vibedeckx-pastes/ | tail -5
cat /tmp/vibedeckx-pastes/<uuid>.txt
```

Expected: the file contains `hello from curl`.

Also test the 400 guard:

```bash
curl -i -X POST http://localhost:5173/api/agent-sessions/nonexistent/paste \
  -H 'Content-Type: application/json' \
  -d '{"content":""}'
```

Expected: HTTP 400 with `{"error":"content must be a non-empty string"}`.

Stop the dev server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/agent-session-routes.ts
git commit -m "feat(paste): add POST /api/agent-sessions/:id/paste route"
```

---

## Task 3: Frontend API wrapper `uploadPaste`

**Files:**
- Modify: `apps/vibedeckx-ui/hooks/use-agent-session.ts` — add a new module-level function alongside `sendMessageToSession` (around line 114) and export it via the hook's return value (around line 688-725).

- [ ] **Step 1: Add `uploadPaste` helper**

In `apps/vibedeckx-ui/hooks/use-agent-session.ts`, immediately after the `sendMessageToSession` function ends (around line 139), insert:

```ts
export interface UploadedPaste {
  path: string;
  size: number;
}

async function uploadPasteToSession(
  sessionId: string,
  content: string
): Promise<UploadedPaste> {
  const response = await fetch(`${getApiBase()}/api/agent-sessions/${sessionId}/paste`, {
    method: "POST",
    headers: getAuthHeaders("application/json"),
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (body.error) detail = ` — ${body.error}`;
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to upload paste [${response.status}]${detail}`);
  }

  return response.json();
}
```

- [ ] **Step 2: Expose it from the hook**

Locate the return object of `useAgentSession` (search for `sendMessage,` in the returned object — it is in the final `return { ... }` of the hook). Add an `uploadPaste` member next to `sendMessage`:

```ts
    uploadPaste: useCallback(
      async (content: string, sessionId?: string): Promise<UploadedPaste> => {
        const targetSessionId = sessionId || session?.id;
        if (!targetSessionId) {
          throw new Error("No session id available for paste upload");
        }
        return uploadPasteToSession(targetSessionId, content);
      },
      [session?.id]
    ),
```

If `useCallback` is not already imported in this file, it is already imported (check). If the `useAgentSession` return object uses direct expressions rather than `useCallback`-wrapped references, match that style — use `useCallback` only if surrounding members do.

- [ ] **Step 3: Frontend type-check**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Expected: exits 0. If it fails because the hook return type is explicitly declared somewhere, update the type.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-agent-session.ts
git commit -m "feat(paste): add uploadPaste to agent session hook"
```

---

## Task 4: `PromptInputTextarea` — add `onPasteText` prop

**Files:**
- Modify: `apps/vibedeckx-ui/components/ai-elements/prompt-input.tsx` — extend `PromptInputTextareaProps` and `handlePaste` (around lines 815-892).

- [ ] **Step 1: Widen the props type**

Replace the existing props type at approximately line 815:

```ts
export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;
```

with:

```ts
export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea> & {
  /**
   * Optional handler invoked when the user pastes plain text (no files).
   * Receives the clipboard text. If the handler calls `event.preventDefault()`,
   * the textarea's default text insertion is suppressed.
   */
  onPasteText?: (event: ClipboardEvent<HTMLTextAreaElement>, text: string) => void;
};
```

(Note: `ClipboardEvent` is already imported via `ClipboardEventHandler` at the top; if direct `ClipboardEvent` isn't imported, add it to the existing `type { ... }` import block at the top of the file.)

- [ ] **Step 2: Accept and wire the new prop**

Change the component signature from:

```ts
export const PromptInputTextarea = ({
  onChange,
  onKeyDown: onKeyDownProp,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
```

to:

```ts
export const PromptInputTextarea = ({
  onChange,
  onKeyDown: onKeyDownProp,
  onPasteText,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
```

- [ ] **Step 3: Extend `handlePaste`**

Locate `handlePaste` at approximately line 870. Replace the entire function body with:

```ts
const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
  const items = event.clipboardData?.items;
  if (!items) {
    return;
  }

  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }

  if (files.length > 0) {
    event.preventDefault();
    attachments.add(files);
    return;
  }

  if (onPasteText) {
    const text = event.clipboardData?.getData("text") ?? "";
    if (text.length > 0) {
      onPasteText(event, text);
    }
  }
};
```

- [ ] **Step 4: Frontend type-check**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Regression sanity check (default behavior unchanged)**

Start the dev stack:

```bash
pnpm dev:all
```

Open http://localhost:3000 in a browser. Without touching `agent-conversation.tsx` yet, paste any text (<2000 chars) into the input. Verify it appears inline in the textarea exactly as before (default browser behavior). Paste an image (from any screenshot tool); verify the image chip still appears in the attachments row.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/ai-elements/prompt-input.tsx
git commit -m "feat(paste): add onPasteText prop to PromptInputTextarea"
```

---

## Task 5: Paste interception in `agent-conversation.tsx`

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — add `pastes` state, a paste handler, and wire both to `PromptInputTextarea`.

This task introduces state + the paste handler. It does NOT yet upload on submit — tokens flow through as plain text until Task 6.

- [ ] **Step 1: Add paste constants and utilities near the top of the file**

Immediately before the `AgentConversation` component declaration (search for `export function AgentConversation` or the analogous component), add:

```ts
// TODO(paste): expose as configurable setting
const PASTE_TO_FILE_THRESHOLD = 2000;
// Match any size label inside the parens (e.g. "1.2KB", "42KB", "900B") so the
// regex stays in sync with formatPasteSize without coupling the two.
const PASTE_TOKEN_RE = /\[📎 paste #(\d+) \([^)]+\)\]/g;

interface PasteEntry {
  id: number;
  content: string;
  size: number; // bytes, UTF-8
}

function formatPasteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  return `${Math.round(kb)}KB`;
}

function pasteTokenFor(id: number, bytes: number): string {
  return `[📎 paste #${id} (${formatPasteSize(bytes)})]`;
}
```

- [ ] **Step 2: Add pastes state next to existing input state**

Find the line `const [input, setInput] = useWorkspaceDraft(projectId, branch);` (around line 93). Add beneath it:

```ts
const [pastes, setPastes] = useState<PasteEntry[]>([]);
const [nextPasteId, setNextPasteId] = useState(1);
```

`useState` is already imported. Task 5 Step 3 below also requires `useCallback` and the `ClipboardEvent` type — extend the existing React import at the top of the file. Change:

```ts
import { useState, useEffect, useRef, forwardRef, useImperativeHandle, createContext, useContext } from "react";
```

to:

```ts
import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle, createContext, useContext, type ClipboardEvent } from "react";
```

- [ ] **Step 3: Add the paste handler**

Above `handleSubmit` (around line 186), add:

```ts
const handlePasteText = useCallback(
  (event: ClipboardEvent<HTMLTextAreaElement>, text: string) => {
    if (text.length <= PASTE_TO_FILE_THRESHOLD) return;

    event.preventDefault();

    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? input.length;
    const end = textarea.selectionEnd ?? input.length;
    const size = new Blob([text]).size;

    const id = nextPasteId;
    const token = pasteTokenFor(id, size);
    const newValue = input.slice(0, start) + token + input.slice(end);

    setInput(newValue);
    setPastes((prev) => [...prev, { id, content: text, size }]);
    setNextPasteId(id + 1);

    // Restore caret after the inserted token.
    const caret = start + token.length;
    requestAnimationFrame(() => {
      try {
        textarea.setSelectionRange(caret, caret);
      } catch {
        // ignore — textarea may have been unmounted
      }
    });
  },
  [input, nextPasteId, setInput]
);
```

(`useCallback` and the `ClipboardEvent` type were added to the React imports in Step 2 above.)

- [ ] **Step 4: Pass `onPasteText` to `<PromptInputTextarea>`**

Locate the existing `<PromptInputTextarea ... />` (around line 523-530). Add the `onPasteText` prop:

```tsx
<PromptInputTextarea
  value={input}
  onChange={(e) => setInput(e.target.value)}
  onPasteText={handlePasteText}
  // ... existing props
/>
```

Leave all existing props untouched.

- [ ] **Step 5: Frontend type-check**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 6: Manual verification**

Start the dev stack:

```bash
pnpm dev:all
```

In the browser:

1. Paste a short string (under 2000 chars) into the agent input. Verify it flows into the textarea inline (unchanged behavior).
2. Paste a long string (paste a 3000+ char block — e.g., the contents of a README). Verify the textarea shows `[📎 paste #1 (X.YKB)]` at the cursor position instead of the full text. Caret should be positioned right after the token.
3. Type text before and after the token. Paste another long block; verify `[📎 paste #2 (X.YKB)]` appears at the new cursor.
4. Inspect React DevTools (or add a temporary `console.log(pastes)` in the component) to confirm the `pastes` array has 2 entries with the correct `content`/`size`.
5. Use backspace to delete one of the tokens; verify it deletes character-by-character like any other text.
6. Paste a screenshot image; verify it still goes to the attachments row as before.

Do NOT send the message yet — Task 6 adds the upload step. At this point, pressing send would pass the literal token string through to the agent, which is not yet desired. Stop before sending.

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(paste): intercept long text pastes with token placeholder"
```

---

## Task 6: Submit pipeline — upload and replace tokens

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — extend `handleSubmit` to reconcile pastes, upload, and replace tokens.

- [ ] **Step 1: Destructure `uploadPaste` from the hook**

Find the line `sendMessage,` in the destructuring of `useAgentSession(...)` (around line 120). Add `uploadPaste` to the destructuring:

```ts
const {
  session,
  status,
  // ...
  sendMessage,
  uploadPaste,
  // ...
} = useAgentSession(...);
```

- [ ] **Step 2: Add a reconcile-and-upload helper**

Above `handleSubmit` (just below `handlePasteText` from Task 5), add:

```ts
async function materializePastes(
  rawText: string,
  pastes: PasteEntry[],
  upload: (content: string, sessionId?: string) => Promise<UploadedPaste>,
  sessionId?: string
): Promise<string> {
  const presentIds = new Set<number>();
  for (const match of rawText.matchAll(PASTE_TOKEN_RE)) {
    presentIds.add(Number(match[1]));
  }
  const surviving = pastes.filter((p) => presentIds.has(p.id));
  if (surviving.length === 0) return rawText;

  let result = rawText;
  for (const paste of surviving) {
    const uploaded = await upload(paste.content, sessionId);
    const token = pasteTokenFor(paste.id, paste.size);
    const marker = `<vpaste path="${uploaded.path}" size="${uploaded.size}" />`;
    // Replace every occurrence of this token (should be exactly one, but be safe).
    result = result.split(token).join(marker);
  }
  return result;
}
```

Import `UploadedPaste`: at the top of the file, find the line importing from `@/hooks/use-agent-session` (for `ContentPart` etc.) and add `UploadedPaste` to that import.

- [ ] **Step 3: Thread pastes through `handleSubmit`**

Locate `handleSubmit` (around line 186). The current beginning is:

```ts
const handleSubmit = async (message: PromptInputMessage) => {
  const text = message.text.trim();
  const hasFiles = message.files.length > 0;
  if (!text && !hasFiles) return;

  setInput("");
  inputHistory.push(text);
  // ...
};
```

Modify it as follows. Replace `const text = message.text.trim();` with these lines (keeping the rest of the function intact):

```ts
  const rawText = message.text;
  const hasFiles = message.files.length > 0;
  const hasPastes = pastes.length > 0;
  const trimmedRaw = rawText.trim();
  if (!trimmedRaw && !hasFiles) return;

  setInput("");
  inputHistory.push(trimmedRaw);

  // Resolve which session id to use. If no session yet, the session will be
  // created below and materialization must happen against that new id.
  let targetSessionId: string | undefined = session?.id;
  let startedSession: Awaited<ReturnType<typeof startSession>> = null;
  if (!session || status !== "running") {
    onStatusChange?.();
    startedSession = await startSession(permissionMode);
    if (!startedSession) {
      // Restore input on failure so the user doesn't lose their pastes.
      setInput(rawText);
      return;
    }
    targetSessionId = startedSession.id;
  }

  // Upload pastes (if any) and replace tokens with <vpaste/> markers.
  let processedText = trimmedRaw;
  if (hasPastes) {
    try {
      processedText = (await materializePastes(rawText, pastes, uploadPaste, targetSessionId)).trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to upload paste";
      toast.error("Paste upload failed", { description: msg });
      setInput(rawText);
      return;
    }
  }

  // Clear pastes state now that they've been materialized into the outgoing message.
  setPastes([]);
  setNextPasteId(1);
```

Then, within the same function, replace subsequent references to `text` (the old local) with `processedText` where the outgoing content is built. Specifically:

- Where `content = text;` appears (in the `if (!hasFiles)` branch) → change to `content = processedText;`.
- Where `parts.push({ type: "text", text });` appears → change to `parts.push({ type: "text", text: processedText });`.

The translation block (around lines 215-244) continues to operate on `content` after this point — leave it alone.

Finally, find the tail of the function that calls `sendMessage`. It currently looks like:

```ts
if (!session || status !== "running") {
  console.log(`[AgentConversation] handleSubmit: no session or not running ...`);
  onStatusChange?.();
  const newSession = await startSession(permissionMode);
  console.log(`[AgentConversation] handleSubmit: startSession returned`, newSession?.id ?? 'null', newSession?.status);
  if (newSession) {
    sendMessage(content, newSession.id);
  }
} else {
  console.log(`[AgentConversation] handleSubmit: existing session ${session.id}, status=${status}`);
  sendMessage(content);
}
```

Since we've already started the session above (if needed), replace this block with:

```ts
if (startedSession) {
  console.log(`[AgentConversation] handleSubmit: using freshly started session ${startedSession.id}`);
  sendMessage(content, startedSession.id);
} else {
  console.log(`[AgentConversation] handleSubmit: existing session ${session!.id}, status=${status}`);
  sendMessage(content);
}
```

- [ ] **Step 4: Frontend type-check**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Expected: exits 0. If there are errors about `startedSession` type, adjust the type to match what `startSession` returns (likely `AgentSession | null` — check its declaration and align).

- [ ] **Step 5: Manual verification — local session end-to-end**

Start the dev stack:

```bash
pnpm dev:all
```

In the browser:

1. Open a local project with an agent session. In the agent chat input, type `what is in here: `, then paste a 3000+ char block, then type ` ?`.
2. Verify the textarea shows `what is in here: [📎 paste #1 (X.YKB)] ?`.
3. Press Enter to send.
4. In the chat history, the user message should render as text with a chip in place of the token. (The chip is implemented in Task 7 — until that lands, the message will visibly contain a literal `<vpaste path="/tmp/vibedeckx-pastes/..." size="..." />` marker. That is correct intermediate state for this task.)
5. On the server's disk, verify the file exists: `ls /tmp/vibedeckx-pastes/` should show a new `<uuid>.txt`, and `cat` shows the pasted content.
6. Watch the agent's response. It should be able to `Read` the file path from the message and act on it.
7. Failure path: stop the backend (Ctrl+C on `pnpm dev:server`). Then paste long text and try to send. Expected: an error toast "Paste upload failed", input and pastes preserved (textarea still shows your text including the token).
8. Restart the backend. Send again. Expected: succeeds on retry.
9. Token-deletion path: paste a long block, then backspace to delete the token partially (destroy the token). Send. Expected: the destroyed token's paste is silently dropped (not uploaded), and the message goes through with whatever partial text is left.
10. Two-paste path: paste two long blocks in one draft, send. Expected: two files on disk, two `<vpaste …/>` markers in the message, preserved in order.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(paste): upload paste tokens on submit and replace with markers"
```

---

## Task 7: Render `<vpaste/>` markers as chips

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/vpaste-chip.tsx`
- Modify: `apps/vibedeckx-ui/components/agent/agent-message.tsx` — parse markers in `UserMessage`.

- [ ] **Step 1: Create the chip component**

Write `apps/vibedeckx-ui/components/agent/vpaste-chip.tsx` verbatim:

```tsx
"use client";

import { FileText } from "lucide-react";

interface VPasteChipProps {
  path: string;
  size: number;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function VPasteChip({ path, size }: VPasteChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs font-mono align-baseline"
      title={path}
    >
      <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="truncate max-w-[18ch]">{basename(path)}</span>
      <span className="text-muted-foreground">{formatSize(size)}</span>
    </span>
  );
}

export const VPASTE_MARKER_RE = /<vpaste path="([^"]+)" size="(\d+)" \/>/g;

/**
 * Split a string into an array of literal-text segments and chip descriptors.
 * Consumers render each segment in order.
 */
export type VPasteSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; path: string; size: number };

export function splitVPasteMarkers(text: string): VPasteSegment[] {
  const segments: VPasteSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(VPASTE_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: "chip", path: match[1], size: Number(match[2]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
```

- [ ] **Step 2: Use it in `UserMessage`**

Open `apps/vibedeckx-ui/components/agent/agent-message.tsx` and add the import near the other `./` imports (around line 30):

```ts
import { VPasteChip, splitVPasteMarkers } from "./vpaste-chip";
import { Fragment } from "react";
```

(If `Fragment` is already imported via `react`, skip the second import.)

Replace the `UserMessage` component (approximately lines 118-147) with:

```tsx
function renderTextWithVPaste(text: string) {
  const segments = splitVPasteMarkers(text);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <MessageResponse>{text ?? ""}</MessageResponse>;
  }
  return (
    <div className="text-sm text-foreground break-words">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Fragment key={i}>
            <MessageResponse>{seg.text}</MessageResponse>
          </Fragment>
        ) : (
          <VPasteChip key={i} path={seg.path} size={seg.size} />
        )
      )}
    </div>
  );
}

function UserMessage({ content }: { content: string | ContentPart[] }) {
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
        <User className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium text-foreground mb-1">You</p>
        <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words">
          {typeof content === "string" ? (
            renderTextWithVPaste(content)
          ) : (
            content.map((part, i) =>
              part.type === "text" ? (
                <Fragment key={i}>{renderTextWithVPaste(part.text)}</Fragment>
              ) : (
                <img
                  key={i}
                  src={`data:${part.mediaType};base64,${part.data}`}
                  alt="Attached image"
                  className="max-w-sm rounded-lg mt-2"
                />
              )
            )
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Frontend type-check**

```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Manual verification**

Start the dev stack:

```bash
pnpm dev:all
```

In the browser:

1. Paste long text into the agent input, type a question around it, and send.
2. Verify the user message in history now shows a chip (filename + size, with `FileText` icon) where the marker used to appear in Task 6. Hovering the chip shows the full path as a tooltip.
3. Scroll back in session history; confirm previously-sent messages that contain `<vpaste/>` markers also render chips (no regressions in historical messages).
4. Send an ordinary message without any paste. Confirm it renders exactly as before (markdown via `MessageResponse`).
5. Send a message with an image attachment AND a long paste. Confirm both the image and the chip render correctly in the user message.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/vpaste-chip.tsx apps/vibedeckx-ui/components/agent/agent-message.tsx
git commit -m "feat(paste): render <vpaste/> markers as file chips in user messages"
```

---

## Task 8: Full remote-session end-to-end

This task adds no code. It is the required remote-path verification and is the reason the design exists.

- [ ] **Step 1: Set up a remote vibedeckx server**

Use an existing remote vibedeckx instance, or spin one up on a second machine (or a second local port) per the project's standard remote setup (`packages/vibedeckx/src/routes/remote-routes.ts`). Register it from the UI so it appears in the server dropdown.

- [ ] **Step 2: Open a remote-backed project**

In the UI, switch to a project whose execution server is the remote. Verify the session id prefix is `remote-` once the session starts (check via DevTools network tab — look for `/api/agent-sessions/remote-…` requests).

- [ ] **Step 3: Paste + send flow**

1. Paste a 3000+ char block into the chat input. Verify the token appears.
2. Send the message.
3. In the UI, verify the chip appears in the user message. Right-click / inspect and read its `title` attribute — the path should be an **absolute path on the remote machine** (e.g., `/tmp/vibedeckx-pastes/<uuid>.txt`), not a local path to your proxy server.
4. On the **remote machine** (ssh in or equivalent), confirm the file exists at that path and contains the original pasted content.
5. On the **local proxy machine** (your dev laptop), confirm that `/tmp/vibedeckx-pastes/` does NOT contain a new file for this paste (it should have been written only on the remote).
6. Watch the agent's response. Because the agent runs on the remote, it should be able to `Read` the file at that path.

- [ ] **Step 4: Failure path — remote disconnect mid-paste**

1. Paste long text into the input. Before sending, stop the remote vibedeckx server (or cut its network).
2. Press send. Expected: toast "Paste upload failed" with a reverse-proxy error; input and pastes preserved.
3. Restart the remote server. Press send again. Expected: the paste uploads and the message sends successfully.

- [ ] **Step 5: Mark the feature complete**

No commit needed — this is a verification task. If any of the above behaviors diverge from expectation, file the issue and fix before declaring done.

---

## Self-review checklist (for the implementer)

After completing all tasks, do a quick pass:

- [ ] Every new or modified file listed in "File Structure" has a commit.
- [ ] Both type-checks pass: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` and `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- [ ] Lint passes for the UI: `pnpm --filter vibedeckx-ui lint`.
- [ ] The spec's manual test plan items (§ Testing) are all verified:
  - [ ] <2000 char paste inline (unchanged)
  - [ ] >2000 char paste → token
  - [ ] Multiple pastes → unique ids
  - [ ] Delete token → silently reconciled
  - [ ] Local send → file on server's /tmp
  - [ ] Remote send → file on remote's /tmp, not local
  - [ ] Remote unreachable → toast + retry works
  - [ ] Mixed paste + image + text
  - [ ] Agent Read end-to-end
