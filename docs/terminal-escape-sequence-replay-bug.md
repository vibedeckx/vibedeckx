# Terminal Escape Sequence Replay Bug

## Commit

`9f1813a` — fix: mute terminal input during history replay

## Symptom

After opening a remote terminal tab, switching to another tab (e.g. Agent), and switching back, garbled text like this appears in the terminal:

```
2RR0;276;0c10;rgb:fafa/fafa/fafa11;rgb:0909/0909/0b0b12;2$y
```

The text appears **every time** the user switches back to the affected terminal. New terminals are unaffected. Restarting the system clears it.

The affected terminal was opened during a period of poor network connectivity.

## Decoded sequences

The garbled text is actually terminal escape sequence **response payloads** with their `\e[` / `\e]` prefixes stripped:

| Raw text               | Full escape response        | What it answers                          |
|------------------------|-----------------------------|------------------------------------------|
| `2R`                   | `\e[2;1R`                   | CPR — Cursor Position Report             |
| `0;276;0c`             | `\e[?0;276;0c`              | DA1 — Device Attributes                  |
| `10;rgb:fafa/fafa/fafa` | `\e]10;rgb:fafa/fafa/fafa`  | OSC 10 — Foreground color query response |
| `11;rgb:0909/0909/0b0b` | `\e]11;rgb:0909/0909/0b0b`  | OSC 11 — Background color query response |
| `12;2$y`               | `\e[?12;2$y`                | DECRPM — Mode report response            |

The color values (`fafa/fafa/fafa` = `#fafafa`, `0909/0909/0b0b` = `#09090b`) match the xterm.js theme configured in `executor-output.tsx`.

## Root cause

The bug involves an interaction between WebSocket reconnection, historical log replay, and the terminal protocol's single-channel design.

### Background

In the terminal protocol, the process running inside the PTY (e.g. bash/readline) can send **query** escape sequences to stdout to ask the terminal emulator about its capabilities, cursor position, colors, etc. The terminal emulator responds by writing the answer back to the process's **stdin**. Both directions use the same escape sequence encoding — there is no metadata to distinguish a terminal response from a keypress. The process relies on **timing** (reading stdin immediately after sending a query) to correlate responses.

### The data flow in vibedeckx

```
bash stdout → PTY → node-pty → JSON → WebSocket → proxy → WebSocket → browser → xterm.js
xterm.js onData → WebSocket → proxy → WebSocket → node-pty → PTY stdin → bash stdin
```

During bash startup, readline sends terminal queries (CPR, DA1, etc.) as part of feature detection. In a native terminal, the round-trip is sub-millisecond. In vibedeckx's architecture, the round-trip traverses multiple WebSocket hops.

### How the contamination happens

1. User opens a remote terminal. Bash starts and readline sends terminal queries during initialization. xterm.js responds via `onData`, and readline reads the responses from stdin in time. Everything works.

2. Network degrades. The WebSocket between the browser and the local proxy drops.

3. The frontend `use-executor-logs` hook detects the close and, because this is a remote terminal (`processId.startsWith("remote-")`), attempts to reconnect with exponential backoff.

4. On reconnection, the backend sends all **historical logs** from the remote server's in-memory log buffer (process-manager stores up to 5000 log entries per process).

5. The frontend clears xterm.js and replays all historical logs into it. xterm.js processes the replayed PTY output and encounters the original terminal query escape sequences from bash's initial startup.

6. xterm.js generates **responses** to these queries (CPR, DA1, OSC 10/11, DECRPM) and emits them via `onData`.

7. The `onData` handler in `executor-output.tsx` sends these responses back through the WebSocket chain to the remote PTY's stdin.

8. But bash/readline is sitting idle at a prompt — it is not expecting terminal responses. readline's escape sequence parser tries to match the incoming bytes as keyboard input, fails to find a key binding, and **inserts the unmatched payload as literal typed characters**. readline then echoes these "typed" characters to stdout.

9. This echo becomes **new PTY output**, which is appended to the remote server's log history.

10. On the next reconnection (or tab switch that triggers a reconnect), the history now includes the garbage from step 9. xterm.js replays it, generates responses to any queries still embedded in the stream, and the cycle repeats — the contamination is **self-reinforcing**.

### Why only one terminal was affected

Two conditions must both be true:

- **Remote terminal** — local terminals never reconnect (the hook skips reconnection for non-`remote-` process IDs), so they never replay history.
- **WebSocket dropped during the terminal's lifetime** — the poor network caused at least one drop+reconnect cycle, triggering the first contamination.

Terminals opened with a stable connection never experience a reconnection, so their history is never replayed while xterm.js is actively listening.

## Fix

The fix prevents xterm.js terminal responses from being forwarded to the PTY during historical log replay.

### Changes

**Backend — `packages/vibedeckx/src/routes/websocket-routes.ts`**

Send a `{ type: "history_end" }` message after all historical logs have been sent:

```typescript
const logs = fastify.processManager.getLogs(processId);
for (const log of logs) {
  socket.send(JSON.stringify(log));
}
socket.send(JSON.stringify({ type: "history_end" }));
```

**Frontend — `apps/vibedeckx-ui/lib/api.ts`**

Add `history_end` to the `LogMessage` discriminated union:

```typescript
export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number }
  | { type: "init"; isPty: boolean }
  | { type: "error"; message: string }
  | { type: "history_end" };
```

**Frontend — `apps/vibedeckx-ui/hooks/use-executor-logs.ts`**

Track `replayingHistory` state — set to `true` on `init`, set to `false` on `history_end`:

```typescript
const [replayingHistory, setReplayingHistory] = useState<boolean>(true);

// In onmessage handler:
if (msg.type === "init") {
  setIsPty(msg.isPty);
  setReplayingHistory(true);
} else if (msg.type === "history_end") {
  setReplayingHistory(false);
}
```

**Frontend — `apps/vibedeckx-ui/components/executor/executor-output.tsx`**

Use a ref to track the mute state and skip `onInput` forwarding during replay:

```typescript
const muteInputRef = useRef(muteInput);
muteInputRef.current = muteInput;

terminal.onData((data) => {
  if (!muteInputRef.current) {
    onInput(data);
  }
});
```

The `muteInput` prop is passed from `TerminalInstance` (in `terminal-panel.tsx`) and `ExecutorItem` (in `executor-item.tsx`), both connected to `replayingHistory` from the hook.

### Result

During history replay, xterm.js still renders the historical terminal output correctly (including ANSI colors, cursor movement, etc.), but its automatic responses to terminal queries are silently dropped instead of being forwarded to the PTY. Once replay completes and live streaming begins, input forwarding resumes normally.

## Follow-up fix (2026-07): mute window vs. parse time race

The `9f1813a` fix was incomplete — the bug still occurred occasionally after
switching to another workspace/project page and back (which unmounts the
terminal, then reconnects and replays history on return).

### Why the first fix didn't fully work

The mute window was defined at **WebSocket-receipt time** (`init` →
`history_end`), but xterm.js emits query responses at **parse time**.
`terminal.write()` only enqueues data; the parser runs asynchronously via
`setTimeout` in 12 ms time slices (`WriteBuffer._innerWrite`). Measured on
xterm 6.0.0: `history_end` flips `replayingHistory` to `false` at +0 ms, while
the DA1/CPR/DECRPM responses to queries embedded in the replayed history fire
via `onData` at +3 ms and later — after the mute was already lifted. With a
large history (up to 5000 buffered entries) or background-tab timer
throttling, the gap grows to seconds. React 18 batching can also commit the
history logs and `replayingHistory=false` in the same render, so the mute ref
may never be `true` during the write at all.

### The fix

Tie the mute to parse completion instead of message receipt:

1. Log entries are tagged `historical: true` at receipt time (using
   synchronous per-connection variables, immune to state batching) in both
   `use-executor-logs.ts` and the mux path in `executor-logs-context.tsx`.
2. `ExecutorOutput` writes historical and live bytes as separate chunks. Before
   writing a historical chunk it increments `historyParseMuteRef`, and
   decrements it in that write's **parse-completion callback** — which xterm
   fires strictly after all `onData` events generated by the chunk (FIFO per
   chunk in `WriteBuffer`).
3. `onData` drops input while the counter is non-zero, so responses to replayed
   queries are suppressed for exactly the replayed bytes; a live query arriving
   right after replay is still answered and forwarded.

Note: histories already contaminated by the pre-fix loop still *display* the
garbage once (it is literal text bash echoed into the log), but no new
responses are forwarded, so the contamination stops growing.
