# Paste-to-File Design

Auto-convert long clipboard pastes into temp files on the agent's execution machine, keeping only a file-path reference in the conversation history.

## Problem

When users paste long content (logs, configs, error traces) into the agent chat input, the full text ends up in the conversation. This pollutes message history, inflates WebSocket patches, and consumes agent context on material that can be re-fetched on demand.

## Goals

- Pastes above a size threshold are written to a file on the machine that will execute the agent (the remote machine for remote sessions, or the local machine for local sessions).
- The conversation carries only a path reference, rendered as a file chip in the UI.
- Paste position within the typed message is preserved, so `"here's the log: <paste> and here's the config: <paste>"` still reads naturally to the agent.
- No orphan files are produced by drafts the user never sends.

## Non-goals

- No server-side cleanup/GC. The temp directory lives under `os.tmpdir()`; OS housekeeping is the backstop.
- No preview/fetch of historical paste contents from the UI. Files may have been GC'd by the OS; the path in the message is the source of truth.
- No edit-in-place of a paste after insertion. To change it, the user deletes the token and re-pastes.
- No file extension inference from content. All pastes are `.txt`.
- No configurable threshold UI. The value is hardcoded with a marked extension point.

## High-level flow

1. User pastes text into the agent input textarea.
2. `onPaste` inspects the clipboard text length.
   - If below threshold, behavior is unchanged (text flows into the textarea).
   - If above threshold, `preventDefault()` fires; a short placeholder token `[📎 paste #N (X.YKB)]` is inserted at the cursor. The full content is stored in React state keyed by token id.
3. User can type around the token, insert more pastes (incrementing id), and delete tokens by backspacing the full range.
4. On submit, the UI:
   - Reconciles the pastes state against the current textarea text (drops any paste whose token was partially deleted).
   - `POST /api/agent-sessions/:sessionId/paste` once per surviving paste; collects `{ path, size }` for each.
   - Replaces every token in the text with `<vpaste path="…" size="…" />`.
   - Sends the resulting string via the existing `sendMessageToSession` path.
5. The user message arrives in the conversation with `<vpaste />` markers. The message renderer parses the markers and displays each as a file chip.

## Architecture

### Frontend

**`apps/vibedeckx-ui/components/ai-elements/prompt-input.tsx`**

Extend the existing `handlePaste` handler (currently handles images/files). Add a text-length branch:

- If `clipboardData.getData("text")` length > `PASTE_TO_FILE_THRESHOLD` (constant, default 2000; comment marks future config point):
  - `preventDefault()`
  - Allocate next paste id (monotonic per-input-instance).
  - Insert `[📎 paste #N (X.YKB)]` at the current selection range of the textarea using the standard "replace selection range, restore caret after insertion" approach.
  - Append an entry to the local `pastes` array.
- Leave image/file attachment behavior untouched.

State shape (component-local):

```ts
type PasteEntry = { id: number; content: string; size: number };
const [pastes, setPastes] = useState<PasteEntry[]>([]);
const [nextPasteId, setNextPasteId] = useState(1);
```

Both `pastes` and `nextPasteId` reset after a successful send. `nextPasteId` can also be reset; id uniqueness matters only within a single draft, since tokens are replaced by paths before the message leaves the client.

Token format (regex): `/\[📎 paste #(\d+) \([\d.]+KB\)\]/g` — matched verbatim on send.

**Submit pipeline** (in the submit handler, before the existing `onSubmit` call):

1. Read the textarea value.
2. Reconcile: drop entries from `pastes` whose token substring is no longer present in the text (user edited the token).
3. For each surviving entry, `POST /api/agent-sessions/:sessionId/paste` with `{ content }` and expect `{ path, size }`. Do these sequentially for simplicity — paste uploads are expected to be rare and small on the size scale HTTP cares about. Can parallelize later if needed.
4. If any upload fails: show a toast, keep textarea and pastes state intact, abort send.
5. On all successes, replace tokens with `<vpaste path="<path>" size="<size>" />` (string replace by exact match on the token text).
6. Pass the transformed string to the existing submit path. Clear pastes state on successful send.

**Message rendering**

`apps/vibedeckx-ui/components/agent/agent-message.tsx` (or the user-bubble branch within it): when rendering user messages, parse for `<vpaste path="…" size="…" />`. Split the text into alternating literal and chip nodes. Render each chip as a compact pill showing the filename (basename of path) and the size (formatted). No click behavior for v1 — the chip is informational only, since the file may already be gone.

### Backend

**New route: `POST /api/agent-sessions/:sessionId/paste`**

Location: `packages/vibedeckx/src/routes/agent-session-routes.ts`, alongside the existing `/message` route. Request body: `{ content: string }`. Response: `{ path: string; size: number }`.

Behavior:

- For remote sessions (id starts with `remote-`): use `proxyToRemoteAuto()` to forward the POST to the remote `/api/agent-sessions/:remoteSessionId/paste` endpoint, mirroring how `/message` already proxies. The remote vibedeckx handles the write on its own filesystem.
- For local sessions: call a new helper, e.g., `writePasteToTempFile(content: string)`, and return the result.

**Helper: `writePasteToTempFile`**

Location: `packages/vibedeckx/src/utils/paste-file.ts` (new).

- Ensures `path.join(os.tmpdir(), "vibedeckx-pastes")` exists (`mkdir -p`, idempotent).
- Generates `<crypto.randomUUID()>.txt`.
- Writes content UTF-8.
- Returns `{ path: <absolute>, size: Buffer.byteLength(content, "utf8") }`.

No per-session subdirectory. UUID filenames are globally unique; flat structure is simpler and fine at expected volumes.

### Wire protocol

The user message sent over the existing `/message` endpoint is a plain string, unchanged in shape. The only new convention is the `<vpaste … />` marker inside the message text, which agents see as part of the prompt (Claude Code will understand "read this file path" semantics) and the UI detects for chip rendering.

## Error handling

| Failure | Behavior |
|---|---|
| Upload HTTP error (local) | Toast; keep textarea and pastes; no send |
| Upload HTTP error (remote proxy) | Same as above; the proxy already surfaces errors |
| Remote unreachable | Toast (existing proxy error surface); no send |
| User partially deletes a token mid-edit | Reconciled away at submit; that paste is dropped silently |
| User clears textarea | pastes state is cleared alongside the textarea |

## Testing

No test framework is configured. Manual test plan:

- [ ] Paste <2000 chars → text appears inline (unchanged legacy behavior).
- [ ] Paste >2000 chars → token appears at cursor; pastes state has one entry.
- [ ] Multiple pastes in one draft → unique ascending ids, both tokens visible.
- [ ] Paste then backspace over the token → paste removed from state (verify via debug/log).
- [ ] Send with local session → file exists at `os.tmpdir()/vibedeckx-pastes/<uuid>.txt` on server; user message shows chip rendering; agent can Read the file.
- [ ] Send with remote session → file exists on the remote machine (not the proxy server); path in message is the remote path; agent (running on remote) can Read it.
- [ ] Kill remote during send → error toast; draft preserved; retry after remote returns works.
- [ ] Paste + image attachment + typed text in one draft → each path survives; user message shows both text + chip.
- [ ] End-to-end: paste a JSON config, ask "what's wrong here?", verify agent Reads the file and responds contextually.

## Open questions addressed

- **Threshold value**: 2000 chars, hardcoded with a `TODO: make configurable` comment near the constant.
- **Extension detection**: out of scope. `.txt` for all.
- **Cleanup**: out of scope. `os.tmpdir()` OS-level lifecycle is acceptable.
- **Historical content preview from chip**: out of scope.

## Future extensions (not this change)

- Surface threshold in user settings.
- Content-sniff extension (.json / .md / language from shebang).
- Click chip to fetch current content if file still exists on remote.
- Per-session subdirectory + explicit cleanup on session delete.
