# Terminal Tools for Main Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `listTerminals` and `runInTerminal` tools to the Main Chat AI so it can discover and execute commands in the user's open terminal sessions.

**Architecture:** Two new Vercel AI SDK tools in `ChatSessionManager.createTools()`, backed by a new `executeInTerminal()` method on `ProcessManager` that uses marker-based completion detection on PTY output. Frontend gets tool label rendering.

**Tech Stack:** TypeScript, Vercel AI SDK (`tool()` from `ai`), Zod schemas, `node-pty` (existing), WebSocket JSON Patches (existing)

**Spec:** `docs/superpowers/specs/2026-03-28-terminal-tools-main-chat-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/vibedeckx/src/process-manager.ts` | Modify | Add `executeInTerminal()` method — marker generation, PTY write, output buffering, marker scanning, timeout |
| `packages/vibedeckx/src/chat-session-manager.ts` | Modify | Add `listTerminals` and `runInTerminal` tools to `createTools()`, update system prompt |
| `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` | Modify | Add tool label entries for new tools |

---

### Task 1: Add `executeInTerminal()` to ProcessManager

**Files:**
- Modify: `packages/vibedeckx/src/process-manager.ts` (insert after `handleInput()` method, around line 716)

- [ ] **Step 1: Add the `executeInTerminal` method**

Insert after the `handleInput()` method (line 716) in `packages/vibedeckx/src/process-manager.ts`:

```typescript
  /**
   * Execute a command in a running terminal session using marker-based completion detection.
   * Writes the command to the PTY, waits for a unique marker in the output to detect completion,
   * and returns the captured output with exit code.
   */
  async executeInTerminal(
    processId: string,
    command: string,
    timeoutSeconds: number = 30,
  ): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      throw new Error(`Terminal ${processId} not found`);
    }
    if (!runningProcess.isPty || !runningProcess.isTerminal) {
      throw new Error(`Process ${processId} is not an interactive terminal`);
    }
    // Check that terminal is still alive
    const lastLog = runningProcess.logs[runningProcess.logs.length - 1];
    if (lastLog?.type === "finished") {
      throw new Error(`Terminal ${processId} has already exited`);
    }

    const marker = `__VDX_${crypto.randomUUID().slice(0, 8)}__`;
    const markerPattern = new RegExp(`${marker}_(\\d+)_`);

    return new Promise<{ exitCode: number; output: string; timedOut: boolean }>((resolve) => {
      let outputBuffer = "";
      let resolved = false;

      const cleanup = () => {
        if (unsubscribe) unsubscribe();
        clearTimeout(timer);
      };

      const finish = (exitCode: number, output: string, timedOut: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        // Strip ANSI escape codes
        const stripped = output.replace(
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
          "",
        );
        // Remove the echo command line and marker line from output
        const lines = stripped.split("\n");
        const filtered = lines.filter(
          (line) => !line.includes(marker) && !line.includes(`echo "${marker}`)
        );
        resolve({ exitCode, output: filtered.join("\n").trim(), timedOut });
      };

      // Subscribe to live output
      const unsubscribe = this.subscribe(processId, (msg) => {
        if (resolved) return;

        if (msg.type === "finished") {
          // Terminal exited before marker — return what we have
          finish(msg.exitCode, outputBuffer, false);
          return;
        }

        if (msg.type === "pty" || msg.type === "stdout") {
          outputBuffer += msg.data;
          const match = markerPattern.exec(outputBuffer);
          if (match) {
            const exitCode = parseInt(match[1], 10);
            // Trim everything from the marker onward
            const markerIdx = outputBuffer.indexOf(match[0]);
            const captured = outputBuffer.slice(0, markerIdx);
            finish(exitCode, captured, false);
          }
        }
      });

      // Timeout
      const timer = setTimeout(() => {
        finish(-1, outputBuffer, true);
      }, timeoutSeconds * 1000);

      // Write the wrapped command to PTY
      const ptyProcess = runningProcess.process as IPty;
      ptyProcess.write(`${command} ; echo "${marker}_$?_"\n`);
    });
  }
```

- [ ] **Step 2: Verify backend type-checks**

Run:
```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```
Expected: No errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git add packages/vibedeckx/src/process-manager.ts
git commit -m "feat: add executeInTerminal() to ProcessManager for marker-based command execution"
```

---

### Task 2: Add `listTerminals` and `runInTerminal` tools to ChatSessionManager

**Files:**
- Modify: `packages/vibedeckx/src/chat-session-manager.ts` (system prompt at line 360, tools in `createTools()` at line 374)

- [ ] **Step 1: Update the system prompt**

In `packages/vibedeckx/src/chat-session-manager.ts`, in the `getSystemPrompt()` method (line 360), add the following lines to the array before the `Current workspace` line:

```typescript
      "You can list active terminal sessions using the listTerminals tool.",
      "You can run commands in a terminal using the runInTerminal tool. The command runs visibly in the user's terminal.",
      "When the user asks to run a command, check something in the terminal, or interact with a shell, use these tools.",
      "If no terminals are open, suggest the user open one in the Terminal tab first.",
```

The full method should look like:

```typescript
  private getSystemPrompt(projectId: string, branch: string | null): string {
    return [
      "You are a helpful assistant for a software development workspace.",
      "You can check the status of running executors (dev servers, build processes, etc.) using the getExecutorStatus tool.",
      "You can start executors using the runExecutor tool and stop them using the stopExecutor tool.",
      "When the user asks about running processes, errors, build status, or dev server status, use the getExecutorStatus tool.",
      "When the user asks to start, run, or launch a process, use runExecutor. When they ask to stop or kill a process, use stopExecutor.",
      "You can view the coding agent's conversation history using the getAgentConversation tool.",
      "When the user asks about what the agent is doing, has done, or references agent activities, use this tool.",
      "When you receive an [Executor Event] message, respond in 1-2 sentences only. State what finished, whether it succeeded or failed, and the key detail (e.g. error message) if it failed. Do not repeat the output logs.",
      "You can list active terminal sessions using the listTerminals tool.",
      "You can run commands in a terminal using the runInTerminal tool. The command runs visibly in the user's terminal.",
      "When the user asks to run a command, check something in the terminal, or interact with a shell, use these tools.",
      "If no terminals are open, suggest the user open one in the Terminal tab first.",
      `Current workspace: project=${projectId}, branch=${branch ?? "default"}.`,
    ].join("\n");
  }
```

- [ ] **Step 2: Add the `listTerminals` tool**

In `createTools()`, add the following tool inside the returned object, after the `stopExecutor` tool (after the closing `}),` around line 661):

```typescript
      listTerminals: tool({
        description:
          "List all active terminal sessions in the current workspace. " +
          "Use this to discover available terminals before running commands with runInTerminal.",
        inputSchema: z.object({}),
        execute: async () => {
          const terminals = processManager.getTerminals(projectId, branch);
          if (terminals.length === 0) {
            return {
              terminals: [],
              message: "No active terminals. The user should open a terminal in the Terminal tab first.",
            };
          }
          return {
            terminals: terminals.map((t) => ({
              id: t.id,
              name: t.name,
              cwd: t.cwd,
              branch: t.branch,
            })),
          };
        },
      }),

      runInTerminal: tool({
        description:
          "Run a shell command in an active terminal session. The command executes visibly in the user's terminal. " +
          "Use listTerminals first to get available terminal IDs. " +
          "Use this when the user asks to run a command, check something, or interact with their shell.",
        inputSchema: z.object({
          terminalId: z.string().describe("ID of the terminal to run the command in (from listTerminals)"),
          command: z.string().describe("The shell command to execute"),
          timeout: z
            .number()
            .min(1)
            .max(120)
            .default(30)
            .describe("Max seconds to wait for command to finish"),
        }),
        execute: async ({ terminalId, command, timeout }) => {
          try {
            const result = await processManager.executeInTerminal(terminalId, command, timeout);
            return {
              success: !result.timedOut,
              exitCode: result.exitCode,
              output: result.output,
              timedOut: result.timedOut,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return {
              success: false,
              output: "",
              message: msg,
            };
          }
        },
      }),
```

- [ ] **Step 3: Verify backend type-checks**

Run:
```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```
Expected: No errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 4: Commit**

```bash
git add packages/vibedeckx/src/chat-session-manager.ts
git commit -m "feat: add listTerminals and runInTerminal tools to main chat"
```

---

### Task 3: Add tool labels in frontend

**Files:**
- Modify: `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` (line 26, `getToolLabel()` function)

- [ ] **Step 1: Add tool labels**

In `apps/vibedeckx-ui/components/conversation/main-conversation.tsx`, update the `getToolLabel()` function (line 26) to add cases for the new tools:

```typescript
function getToolLabel(tool: string): string {
  switch (tool) {
    case "getExecutorStatus":
      return "Checking executor status...";
    case "getAgentConversation":
      return "Checking agent conversation...";
    case "listTerminals":
      return "Listing terminals...";
    case "runInTerminal":
      return "Running command in terminal...";
    default:
      return `Running ${tool}...`;
  }
}
```

- [ ] **Step 2: Verify frontend type-checks**

Run:
```bash
cd apps/vibedeckx-ui && npx tsc --noEmit
```
Expected: No errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation/main-conversation.tsx
git commit -m "feat: add tool labels for terminal tools in main chat UI"
```

---

### Task 4: Manual integration test

- [ ] **Step 1: Build the project**

Run:
```bash
pnpm build
```
Expected: Build succeeds.

- [ ] **Step 2: Start dev servers**

Run:
```bash
pnpm dev:all
```

- [ ] **Step 3: Test the flow**

1. Open the app in a browser at `http://localhost:3000`
2. Select a project in the sidebar
3. Go to the **Terminal** tab in the right panel and create a new terminal
4. In the **Main Chat** (left panel), type: "list my open terminals"
5. Verify the AI calls `listTerminals` and shows the terminal ID/name
6. Type: "run `ls -la` in the terminal"
7. Verify:
   - The AI calls `runInTerminal`
   - The `ls -la` command appears and executes in the terminal tab (visible to user)
   - The AI receives and displays the output in its response
   - The marker (`echo "__VDX_..."`) appears briefly in the terminal but the AI's returned output is clean (no marker, no ANSI codes)

- [ ] **Step 4: Test edge cases**

1. Close all terminals, then ask the AI to run a command — should get "no terminals open" message
2. Run a command that takes >30s (e.g., `sleep 60`) — should timeout and return partial output with timedOut indicator
3. Run a failing command (e.g., `false`) — should return exitCode 1

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during terminal tools integration testing"
```
