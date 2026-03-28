# Terminal Tools for Main Chat

**Date:** 2026-03-28
**Status:** Approved

## Summary

Add two tools to the Main Chat AI (`ChatSessionManager`) that let it interact with active terminal sessions in the Terminal panel: `listTerminals` to discover open terminals, and `runInTerminal` to execute commands in a chosen terminal with marker-based completion detection.

## Motivation

The Main Chat can already manage executors (start/stop/status), but has no way to interact with ad-hoc terminal sessions. Users often have terminals open for exploratory work. Giving the AI the ability to run commands in those terminals bridges the gap between the chat assistant and the user's live shell sessions.

## Design

### Tool 1: `listTerminals`

Returns all active terminal sessions for the current project and branch.

**Input schema:**
```typescript
z.object({})  // no parameters
```

**Output:**
```typescript
{
  terminals: Array<{
    id: string;       // processId used to target the terminal
    name: string;     // e.g. "Terminal 1"
    cwd: string;      // working directory
    branch: string | null;
  }>;
  message?: string;   // when no terminals are open
}
```

**Implementation:** Calls `processManager.getTerminals(projectId, branch)`.

### Tool 2: `runInTerminal`

Sends a command to a specific terminal, waits for it to complete using a marker, and returns the captured output.

**Input schema:**
```typescript
z.object({
  terminalId: z.string().describe("ID of the terminal to run the command in (from listTerminals)"),
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().min(1).max(120).default(30).describe("Max seconds to wait for command to finish"),
})
```

**Output:**
```typescript
{
  success: boolean;
  exitCode?: number;
  output: string;       // captured terminal output (ANSI stripped)
  timedOut?: boolean;    // true if timeout was hit before marker appeared
  message?: string;      // error message if terminal not found, etc.
}
```

**Execution flow:**

1. Validate that `terminalId` refers to a running PTY terminal in `ProcessManager`.
2. Generate a unique marker: `__VDX_<8-char-hex>__`.
3. Subscribe to the terminal's log stream via `processManager.subscribe()`.
4. Write the wrapped command to the PTY: `<command> ; echo "__VDX_<marker>_$?__"\n`.
5. Buffer all PTY output from this point, scanning each chunk for the marker pattern `__VDX_<marker>_<exitCode>__`.
6. When the marker is found:
   - Extract the exit code from the marker.
   - Strip the echo command line and the marker line from captured output.
   - Strip ANSI escape codes from captured output.
   - Unsubscribe and resolve.
7. If `timeout` seconds elapse before the marker appears:
   - Return partial output with `timedOut: true`.
   - Unsubscribe and resolve.
8. The command and its output are visible to the user in their terminal tab in real-time (the PTY echoes everything).

### Backend: `ProcessManager.executeInTerminal()`

New method on `ProcessManager`:

```typescript
async executeInTerminal(
  processId: string,
  command: string,
  timeoutSeconds: number
): Promise<{ exitCode: number; output: string; timedOut: boolean }>
```

- Validates that the process exists, is PTY, and `isTerminal === true`.
- Handles marker generation, PTY write, output buffering, marker scanning, timeout, and cleanup.
- Strips ANSI escape codes from the returned output using the existing `stripAnsi`-style regex.

### Backend: `ChatSessionManager.createTools()` additions

Two new tools added alongside the existing `getExecutorStatus`, `runExecutor`, `stopExecutor`, and `getAgentConversation`:

- `listTerminals` — calls `processManager.getTerminals(projectId, branch)`
- `runInTerminal` — calls `processManager.executeInTerminal(terminalId, command, timeout)`

### Backend: System prompt update

Add to `getSystemPrompt()`:
```
You can list active terminal sessions using the listTerminals tool.
You can run commands in a terminal using the runInTerminal tool. The command runs visibly in the user's terminal.
When the user asks to run a command, check something in the terminal, or interact with a shell, use these tools.
If no terminals are open, suggest the user open one first.
```

### Frontend: `main-conversation.tsx` update

Add tool label entries in `getToolLabel()`:
- `"listTerminals"` -> `"Listing terminals..."`
- `"runInTerminal"` -> `"Running command in terminal..."`

## Files to modify

| File | Change |
|------|--------|
| `packages/vibedeckx/src/process-manager.ts` | Add `executeInTerminal()` method |
| `packages/vibedeckx/src/chat-session-manager.ts` | Add `listTerminals` and `runInTerminal` tools, update system prompt |
| `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` | Add tool labels for new tools |

## Edge cases

- **No terminals open:** `listTerminals` returns empty array with a message. `runInTerminal` returns `success: false` with a message.
- **Terminal closed mid-execution:** The subscriber detects the `finished` log message and resolves with partial output and an error indicator.
- **Command with special characters:** The command is written directly to the PTY as-is; shell interprets it. The marker uses a suffix pattern unlikely to collide.
- **Long output:** Output is buffered in memory. The existing `TERMINAL_MAX_LOG_ENTRIES` limit on the terminal's log array doesn't affect our subscriber-based capture since we listen to live events.
- **Interactive commands (vim, etc.):** These won't produce the marker, so the timeout will fire and return partial output with `timedOut: true`. The AI should avoid running interactive commands.
- **Concurrent `runInTerminal` calls on same terminal:** Each call uses a unique marker, so they won't interfere. However, interleaved output may be confusing. This is an acceptable trade-off for the initial implementation.
