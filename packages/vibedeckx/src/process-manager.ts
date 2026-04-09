import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, chmodSync, readdirSync, statSync } from "fs";
import path from "path";
import { createRequire } from "module";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { Executor, ExecutorProcessStatus, PromptProvider, Storage } from "./storage/types.js";
import type { EventBus } from "./event-bus.js";

export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number };

export type InputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface TerminalInfo {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  branch: string | null;
}

type LogSubscriber = (msg: LogMessage) => void;

interface RunningProcess {
  process: ChildProcess | IPty;
  isPty: boolean;
  isTerminal: boolean;
  name: string;
  logs: LogMessage[];
  subscribers: Set<LogSubscriber>;
  executorId: string;
  projectId: string;
  projectPath: string;
  branch: string | null;
  skipDb: boolean;
}

const LOG_RETENTION_MS = 5 * 60 * 1000; // 5 minutes
const TERMINAL_MAX_LOG_ENTRIES = 5000;

/**
 * node-pty on macOS uses a `spawn-helper` binary in prebuilds/.
 * pnpm strips execute bits from tarball entries, so posix_spawn fails
 * with "Permission denied". Fix permissions at startup.
 */
function fixNodePtyPermissions(): void {
  try {
    const require_ = createRequire(import.meta.url);
    const ptyDir = path.dirname(require_.resolve("node-pty/package.json"));
    const prebuildsDir = path.join(ptyDir, "prebuilds");
    if (!existsSync(prebuildsDir)) return;
    for (const platform of readdirSync(prebuildsDir)) {
      const helper = path.join(prebuildsDir, platform, "spawn-helper");
      if (existsSync(helper)) {
        const mode = statSync(helper).mode;
        if (!(mode & 0o111)) {
          chmodSync(helper, mode | 0o755);
          console.log(`[ProcessManager] Fixed spawn-helper permissions: ${helper}`);
        }
      }
    }
  } catch {
    // Non-critical — PTY will fall back to child_process if spawn fails
  }
}
fixNodePtyPermissions();

export class ProcessManager {
  private processes: Map<string, RunningProcess> = new Map();
  private storage: Storage;
  private eventBus: EventBus | null = null;
  private terminalCounter = 0;
  private binaryCache = new Map<string, string | null>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Detect a CLI binary by name, caching the result.
   */
  private detectBinary(name: string): string | null {
    if (this.binaryCache.has(name)) {
      return this.binaryCache.get(name)!;
    }
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(cmd, [name], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      const path = result || null;
      this.binaryCache.set(name, path);
      console.log(`[ProcessManager] ${name} binary found: ${result}`);
      return path;
    } catch {
      this.binaryCache.set(name, null);
      console.log(`[ProcessManager] ${name} binary not found, will use npx`);
      return null;
    }
  }

  /**
   * Build the shell command string for a prompt executor.
   * Supports claude and codex providers.
   */
  private buildPromptCommand(prompt: string, provider: PromptProvider): string {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    if (provider === 'codex') {
      const binary = this.detectBinary('codex');
      if (binary) {
        return `${binary} --dangerously-bypass-approvals-and-sandbox exec '${escapedPrompt}'`;
      }
      return `npx -y @openai/codex --dangerously-bypass-approvals-and-sandbox exec '${escapedPrompt}'`;
    }

    // Default: claude
    const binary = this.detectBinary('claude');
    if (binary) {
      return `${binary} -p '${escapedPrompt}' --dangerously-skip-permissions --verbose`;
    }
    return `npx -y @anthropic-ai/claude-code -p '${escapedPrompt}' --dangerously-skip-permissions --verbose`;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * Start a new process for the given executor
   * Returns the process ID
   * @param skipDb - When true, skip database operations (used for remote path-based execution
   *                 where the executor doesn't exist in the local DB)
   */
  start(executor: Executor, projectPath: string, skipDb = false): string {
    const processId = crypto.randomUUID();

    // Create process record in database (skip for remote path-based execution)
    if (!skipDb) {
      this.storage.executorProcesses.create({
        id: processId,
        executor_id: executor.id,
      });
    }

    // Determine working directory
    // If executor.cwd is set, resolve it relative to the worktree/project path
    // so that sub-directory paths work correctly across worktrees
    const cwd = executor.cwd
      ? (path.isAbsolute(executor.cwd) ? executor.cwd : path.join(projectPath, executor.cwd))
      : projectPath;

    // For claude prompt executors, use stream-json mode for real-time streaming
    if (executor.executor_type === 'prompt' && (executor.prompt_provider ?? 'claude') === 'claude') {
      console.log(`[ProcessManager] Starting stream-json process ${processId}`);
      console.log(`[ProcessManager] Type: prompt (claude stream-json)`);
      console.log(`[ProcessManager] Prompt: ${executor.command.slice(0, 100)}${executor.command.length > 100 ? '...' : ''}`);
      console.log(`[ProcessManager] CWD: ${cwd}`);
      this.startClaudeStreamProcess(processId, executor, cwd, skipDb);
    } else {
      // For non-claude prompt executors, build the provider-specific command
      const effectiveExecutor = executor.executor_type === 'prompt'
        ? { ...executor, command: this.buildPromptCommand(executor.command, executor.prompt_provider ?? 'claude') }
        : executor;

      console.log(`[ProcessManager] Starting process ${processId}`);
      console.log(`[ProcessManager] Type: ${executor.executor_type || 'command'}${executor.executor_type === 'prompt' ? ` (${executor.prompt_provider ?? 'claude'})` : ''}`);
      console.log(`[ProcessManager] Command: ${effectiveExecutor.command}`);
      console.log(`[ProcessManager] CWD: ${cwd}`);
      console.log(`[ProcessManager] Forcing PTY mode for ANSI color support`);

      // Always use PTY mode for proper ANSI color support
      try {
        this.startPtyProcess(processId, effectiveExecutor, cwd, skipDb);
        console.log(`[ProcessManager] PTY mode started successfully`);
      } catch (error) {
        // PTY failed (e.g., native module not compiled), fallback to regular process
        console.warn(`[ProcessManager] PTY spawn failed, falling back to regular process: ${error}`);
        this.startRegularProcess(processId, effectiveExecutor, cwd, skipDb);
      }
    }

    // Store PID in database for recovery after server restart
    if (!skipDb) {
      const runningProcess = this.processes.get(processId);
      if (runningProcess) {
        const pid = runningProcess.isPty
          ? (runningProcess.process as IPty).pid
          : (runningProcess.process as ChildProcess).pid;
        if (pid) {
          this.storage.executorProcesses.updatePid(processId, pid);
        }
      }
    }

    this.eventBus?.emit({ type: "executor:started", projectId: executor.project_id, executorId: executor.id, processId, target: "local" });

    return processId;
  }

  /**
   * Start an interactive terminal session (persistent shell, no command)
   * Returns the process ID and name
   */
  startTerminal(projectId: string, cwd: string, branch: string | null = null): { id: string; name: string } {
    const processId = crypto.randomUUID();
    this.terminalCounter++;
    const name = `Terminal ${this.terminalCounter}`;

    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    let shell: string;
    if (process.platform === "win32") {
      shell = "powershell.exe";
    } else {
      shell = process.env.SHELL || "/bin/zsh";
      if (!shell.includes("/")) {
        shell = `/bin/${shell}`;
      }
    }

    console.log(`[ProcessManager] Starting terminal ${processId} (${name}) in ${cwd}, shell=${shell}`);

    const ptyEnv = { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" } as Record<string, string>;

    // Try PTY first (proper interactive terminal). If node-pty's native module
    // fails (e.g. posix_spawnp broken on macOS ARM64), fall back to a regular
    // child process which still gives a usable shell, just without full PTY
    // features like raw-mode input.
    let usePty = true;
    let proc: IPty | ChildProcess;
    try {
      proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: ptyEnv,
      });
      console.log(`[ProcessManager] Terminal ${processId} spawned with PTY, PID: ${(proc as IPty).pid}`);
    } catch (ptyErr) {
      console.warn(`[ProcessManager] PTY spawn failed for terminal ${processId}, falling back to regular process: ${ptyErr}`);
      usePty = false;
      proc = spawn(shell, ["-i"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: ptyEnv,
      });
      console.log(`[ProcessManager] Terminal ${processId} spawned with regular process, PID: ${(proc as ChildProcess).pid}`);
    }

    const runningProcess: RunningProcess = {
      process: proc,
      isPty: usePty,
      isTerminal: true,
      name,
      logs: [],
      subscribers: new Set(),
      executorId: "",
      projectId,
      projectPath: cwd,
      branch,
      skipDb: true,
    };

    this.processes.set(processId, runningProcess);

    if (usePty) {
      const ptyProc = proc as IPty;
      ptyProc.onData((data: string) => {
        const msg: LogMessage = { type: "pty", data };
        runningProcess.logs.push(msg);
        if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
          runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
        }
        this.broadcast(processId, msg);
      });

      ptyProc.onExit(({ exitCode }) => {
        const code = exitCode ?? 0;
        console.log(`[ProcessManager] Terminal ${processId} exited with code ${code}`);
        const msg: LogMessage = { type: "finished", exitCode: code };
        runningProcess.logs.push(msg);
        this.broadcast(processId, msg);
        setTimeout(() => {
          this.processes.delete(processId);
        }, LOG_RETENTION_MS);
      });
    } else {
      const childProc = proc as ChildProcess;
      childProc.stdout?.on("data", (data: Buffer) => {
        const msg: LogMessage = { type: "pty", data: data.toString() };
        runningProcess.logs.push(msg);
        if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
          runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
        }
        this.broadcast(processId, msg);
      });
      childProc.stderr?.on("data", (data: Buffer) => {
        const msg: LogMessage = { type: "pty", data: data.toString() };
        runningProcess.logs.push(msg);
        if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
          runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
        }
        this.broadcast(processId, msg);
      });
      childProc.on("close", (code) => {
        const exitCode = code ?? 0;
        console.log(`[ProcessManager] Terminal ${processId} exited with code ${exitCode}`);
        const msg: LogMessage = { type: "finished", exitCode };
        runningProcess.logs.push(msg);
        this.broadcast(processId, msg);
        setTimeout(() => {
          this.processes.delete(processId);
        }, LOG_RETENTION_MS);
      });
    }

    return { id: processId, name };
  }

  /**
   * Start a process using node-pty (for interactive commands)
   */
  private startPtyProcess(processId: string, executor: Executor, cwd: string, skipDb = false): void {
    // Use user's default shell or fall back to common shell paths
    let shell: string;
    if (process.platform === "win32") {
      shell = "powershell.exe";
    } else {
      // Try SHELL env var first, then common paths
      shell = process.env.SHELL || "/bin/zsh";
      // If SHELL is just "bash" or "zsh" without path, prepend /bin/
      if (shell === "bash" || shell === "zsh" || shell === "sh") {
        shell = `/bin/${shell}`;
      }
    }
    const args = process.platform === "win32" ? ["-Command", executor.command] : ["-c", executor.command];
    console.log(`[ProcessManager] Using shell: ${shell}`);

    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" } as Record<string, string>,
    });

    const runningProcess: RunningProcess = {
      process: ptyProcess,
      isPty: true,
      isTerminal: false,
      name: "",
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,
      projectPath: cwd,
      branch: null,
      skipDb,
    };

    this.processes.set(processId, runningProcess);
    console.log(`[ProcessManager] PTY process ${processId} added to map, PID: ${ptyProcess.pid}`);

    // Drain mechanism: node-pty can fire onExit before all onData callbacks
    // have delivered buffered output. We track exit state and use setImmediate
    // to let pending I/O flush. Each new onData after exit resets the drain,
    // so we only emit once output has settled.
    let exitPending: { code: number } | null = null;
    let drainHandle: ReturnType<typeof setImmediate> | null = null;

    const emitStopped = () => {
      if (!exitPending) return;
      const { code } = exitPending;
      exitPending = null;
      drainHandle = null;
      const tailOutput = this.snapshotTailOutput(runningProcess.logs);
      console.log(`[ProcessManager] emitStopped: processId=${processId}, logs.length=${runningProcess.logs.length}, logTypes=[${runningProcess.logs.map(l => l.type).join(",")}], tailOutput.length=${tailOutput.length}, tailOutput=${JSON.stringify(tailOutput.slice(0, 200))}`);
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: code, target: "local", tailOutput });
    };

    const scheduleDrain = () => {
      if (drainHandle) clearImmediate(drainHandle);
      drainHandle = setImmediate(emitStopped);
    };

    // Handle PTY data output
    ptyProcess.onData((data: string) => {
      const msg: LogMessage = { type: "pty", data };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);

      console.log(`[ProcessManager] onData: processId=${processId}, exitPending=${!!exitPending}, data=${JSON.stringify(data.slice(0, 100))}`);

      // If exit is pending, reset drain — more data may follow
      if (exitPending) {
        scheduleDrain();
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      const code = exitCode ?? 0;
      const status: ExecutorProcessStatus = code === 0 ? "completed" : "failed";

      console.log(`[ProcessManager] PTY onExit: processId=${processId}, code=${code}, logs.length=${runningProcess.logs.length}, logTypes=[${runningProcess.logs.map(l => l.type).join(",")}]`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, code);
      }

      const msg: LogMessage = { type: "finished", exitCode: code };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);

      // Start drain — will emit once no more onData callbacks arrive
      exitPending = { code };
      scheduleDrain();

      // Schedule cleanup after retention period
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
      }, LOG_RETENTION_MS);
    });
  }

  /**
   * Start a process using regular spawn (for non-interactive commands)
   */
  private startRegularProcess(processId: string, executor: Executor, cwd: string, skipDb = false): void {
    const childProcess = spawn(executor.command, {
      shell: true,
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    const runningProcess: RunningProcess = {
      process: childProcess,
      isPty: false,
      isTerminal: false,
      name: "",
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,
      projectPath: cwd,
      branch: null,
      skipDb,
    };

    this.processes.set(processId, runningProcess);
    console.log(`[ProcessManager] Regular process ${processId} added to map, PID: ${childProcess.pid}`);

    // Handle stdout
    childProcess.stdout?.on("data", (data: Buffer) => {
      const msg: LogMessage = { type: "stdout", data: data.toString() };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);
    });

    // Handle stderr
    childProcess.stderr?.on("data", (data: Buffer) => {
      const msg: LogMessage = { type: "stderr", data: data.toString() };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);
    });

    // Handle process exit
    childProcess.on("close", (code) => {
      const exitCode = code ?? 0;
      const status: ExecutorProcessStatus = exitCode === 0 ? "completed" : "failed";

      console.log(`[ProcessManager] Process ${processId} exited with code ${exitCode}`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, exitCode);
      }

      const msg: LogMessage = { type: "finished", exitCode };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);
      // close event guarantees all stdio is flushed — safe to snapshot now
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs) });

      // Schedule cleanup after retention period
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
      }, LOG_RETENTION_MS);
    });

    // Handle spawn errors
    childProcess.on("error", (error) => {
      const msg: LogMessage = { type: "stderr", data: `Error: ${error.message}` };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, "failed", 1);
      }

      const finishMsg: LogMessage = { type: "finished", exitCode: 1 };
      runningProcess.logs.push(finishMsg);
      this.broadcast(processId, finishMsg);
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: 1, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs) });
    });
  }

  /**
   * Start a Claude prompt executor using stream-json mode for real-time output.
   * Spawns claude with --output-format=stream-json --input-format=stream-json,
   * sends the prompt via stdin, and parses JSON output into formatted terminal text.
   */
  private startClaudeStreamProcess(processId: string, executor: Executor, cwd: string, skipDb: boolean): void {
    const binary = this.detectBinary('claude');
    const args = [
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--dangerously-skip-permissions',
      '--verbose',
    ];

    const command = binary || 'npx';
    const fullArgs = binary ? args : ['-y', '@anthropic-ai/claude-code', ...args];

    const childProcess = spawn(command, fullArgs, {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    const runningProcess: RunningProcess = {
      process: childProcess,
      isPty: false,
      isTerminal: false,
      name: '',
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,
      projectPath: cwd,
      branch: null,
      skipDb,
    };

    this.processes.set(processId, runningProcess);
    console.log(`[ProcessManager] Stream process ${processId} added to map, PID: ${childProcess.pid}`);

    // Send prompt via stdin and close to signal single-turn
    const userMessage = JSON.stringify({ type: 'user', message: { role: 'user', content: executor.command } }) + '\n';
    childProcess.stdin?.write(userMessage, () => {
      childProcess.stdin?.end();
    });

    // Stream-JSON parsing state
    let stdoutBuffer = '';
    const prevTextByIndex = new Map<number, string>();
    const seenToolUseIds = new Set<string>();

    const RESET = '\x1b[0m';
    const DIM = '\x1b[2m';
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const BOLD = '\x1b[1m';

    const pushLog = (data: string) => {
      const msg: LogMessage = { type: 'stdout', data };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);
    };

    // Parse stream-json stdout into formatted terminal output
    childProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          pushLog(line + '\n');
          continue;
        }

        if (parsed.type === 'assistant') {
          const message = parsed.message as Record<string, unknown> | undefined;
          const content = message?.content as Array<Record<string, unknown>> | undefined;
          if (!content || !Array.isArray(content)) continue;

          let output = '';
          for (let i = 0; i < content.length; i++) {
            const block = content[i];

            if (block.type === 'text') {
              const fullText = (block.text as string) || '';
              const prev = prevTextByIndex.get(i) || '';
              if (fullText.length > prev.length && fullText.startsWith(prev)) {
                output += fullText.slice(prev.length);
              } else if (fullText !== prev) {
                output += fullText;
              }
              prevTextByIndex.set(i, fullText);
            } else if (block.type === 'tool_use' && block.id && !seenToolUseIds.has(block.id as string)) {
              seenToolUseIds.add(block.id as string);
              output += `\n${CYAN}${BOLD}> ${block.name}${RESET}\n`;
              const input = block.input as Record<string, unknown> | undefined;
              if (input && Object.keys(input).length > 0) {
                const inputStr = JSON.stringify(input, null, 2);
                const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr;
                output += `${DIM}${truncated}${RESET}\n`;
              }
            }
          }

          if (output) pushLog(output);

        } else if (parsed.type === 'user') {
          const message = parsed.message as Record<string, unknown> | undefined;
          const content = message?.content as Array<Record<string, unknown>> | undefined;
          if (!content || !Array.isArray(content)) continue;

          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultStr = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              if (resultStr && resultStr.length > 0) {
                const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + '...' : resultStr;
                pushLog(`${DIM}${truncated}${RESET}\n`);
              }
            }
          }

        } else if (parsed.type === 'system') {
          const msg = parsed.message || parsed.subtype;
          if (msg) {
            pushLog(`${DIM}${msg}${RESET}\n`);
          }

        } else if (parsed.type === 'result') {
          if (parsed.subtype === 'error') {
            pushLog(`\n${RED}Error: ${parsed.error || 'Unknown error'}${RESET}\n`);
          } else {
            const parts: string[] = [];
            if (parsed.duration_ms) parts.push(`${((parsed.duration_ms as number) / 1000).toFixed(1)}s`);
            if (parsed.cost_usd) parts.push(`$${(parsed.cost_usd as number).toFixed(4)}`);
            const info = parts.length > 0 ? ` (${parts.join(', ')})` : '';
            pushLog(`\n${GREEN}Done${info}${RESET}\n`);
          }
        }
      }
    });

    // Ignore stderr (Claude Code uses it for progress/debug info)
    childProcess.stderr?.on('data', () => {});

    // Handle process exit
    childProcess.on('close', (code) => {
      const exitCode = code ?? 0;
      const status: ExecutorProcessStatus = exitCode === 0 ? 'completed' : 'failed';

      console.log(`[ProcessManager] Stream process ${processId} exited with code ${exitCode}`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, exitCode);
      }

      const msg: LogMessage = { type: 'finished', exitCode };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);
      // close event guarantees all stdio is flushed — safe to snapshot now
      this.eventBus?.emit({ type: 'executor:stopped', projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs) });

      // Schedule cleanup after retention period
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
      }, LOG_RETENTION_MS);
    });

    // Handle spawn errors
    childProcess.on('error', (error) => {
      const msg: LogMessage = { type: 'stderr', data: `Error: ${error.message}` };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, 'failed', 1);
      }

      const finishMsg: LogMessage = { type: 'finished', exitCode: 1 };
      runningProcess.logs.push(finishMsg);
      this.broadcast(processId, finishMsg);
      this.eventBus?.emit({ type: 'executor:stopped', projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: 1, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs) });
    });
  }

  /**
   * Stop a running process
   */
  stop(processId: string): boolean {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      console.log(`[ProcessManager] Process ${processId} not found in memory map. Map has ${this.processes.size} entries: [${Array.from(this.processes.keys()).join(", ")}]`);
      // Process not in memory (e.g., server was restarted or PTY exited early) — try to kill by PID from DB
      return this.stopByPid(processId);
    }

    let killed = false;
    if (runningProcess.isPty) {
      // For PTY processes, kill the process group to ensure all children are terminated
      const ptyProcess = runningProcess.process as IPty;
      const pid = ptyProcess.pid;
      killed = this.killProcessGroup(pid);
      if (!killed) {
        // Fallback to node-pty's kill method
        ptyProcess.kill();
        killed = true;
      }
    } else {
      // For regular processes, kill the process group (detached: true makes them group leaders)
      const childProcess = runningProcess.process as ChildProcess;
      const pid = childProcess.pid;
      if (pid) {
        killed = this.killProcessGroup(pid);
        console.log(`[ProcessManager] Process group kill (pid=${pid}): ${killed}`);
      }
      if (!killed) {
        killed = childProcess.kill("SIGTERM");
        console.log(`[ProcessManager] Direct SIGTERM kill (pid=${pid}): ${killed}`);
      }
    }

    if (killed && !runningProcess.skipDb) {
      this.storage.executorProcesses.updateStatus(processId, "killed");
    }

    return killed;
  }

  /**
   * Kill a process group by sending SIGTERM to the negative PID
   */
  private killProcessGroup(pid: number): boolean {
    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Try to stop a process by looking up its PID in the database (for orphaned processes after server restart)
   */
  private stopByPid(processId: string): boolean {
    const dbProcess = this.storage.executorProcesses.getById(processId);
    if (!dbProcess || !dbProcess.pid) {
      console.log(`[ProcessManager] Process ${processId} not found in DB or has no PID (status=${dbProcess?.status})`);
      return false;
    }

    console.log(`[ProcessManager] Process ${processId} not in memory (db status=${dbProcess.status}), attempting to kill by PID ${dbProcess.pid}`);

    let killed = false;
    // Try process group kill first
    try {
      process.kill(-dbProcess.pid, "SIGTERM");
      killed = true;
    } catch {
      // Process group kill failed, try direct kill
      try {
        process.kill(dbProcess.pid, "SIGTERM");
        killed = true;
      } catch {
        // Process already dead
        console.log(`[ProcessManager] PID ${dbProcess.pid} is already dead`);
      }
    }

    this.storage.executorProcesses.updateStatus(processId, "killed");
    return killed;
  }

  /**
   * Handle input from the client (for PTY or terminal processes)
   */
  handleInput(processId: string, message: InputMessage): boolean {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      return false;
    }

    if (runningProcess.isPty) {
      const ptyProcess = runningProcess.process as IPty;
      if (message.type === "input") {
        ptyProcess.write(message.data);
        return true;
      } else if (message.type === "resize") {
        ptyProcess.resize(message.cols, message.rows);
        return true;
      }
    } else if (runningProcess.isTerminal) {
      // Non-PTY terminal fallback: write to stdin
      const childProcess = runningProcess.process as ChildProcess;
      if (message.type === "input") {
        childProcess.stdin?.write(message.data);
        return true;
      }
      // resize is not supported for non-PTY processes
    }

    return false;
  }

  /**
   * Send a command to a running terminal session (fire-and-forget).
   * Writes the command + newline to the PTY. Does not wait for output.
   */
  sendToTerminal(processId: string, command: string): void {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      throw new Error(`Terminal ${processId} not found`);
    }
    if (!runningProcess.isTerminal) {
      throw new Error(`Process ${processId} is not an interactive terminal`);
    }
    const lastLog = runningProcess.logs[runningProcess.logs.length - 1];
    if (lastLog?.type === "finished") {
      throw new Error(`Terminal ${processId} has already exited`);
    }

    if (runningProcess.isPty) {
      (runningProcess.process as IPty).write(`${command}\n`);
    } else {
      (runningProcess.process as ChildProcess).stdin?.write(`${command}\n`);
    }
  }

  /**
   * Get recent output lines from a terminal's log buffer.
   * Returns stripped ANSI text from the last N lines.
   */
  getRecentOutput(processId: string, maxLines = 50): string {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) return "";

    const textLogs = runningProcess.logs
      .filter((l): l is Exclude<LogMessage, { type: "finished" }> => l.type !== "finished")
      .map((l) => l.data);
    const joined = textLogs.join("");
    const lines = joined.split("\n");
    const tail = lines.slice(-maxLines).join("\n");
    // Strip ANSI escape codes
    return tail.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
      "",
    );
  }

  /**
   * Check if a process is using PTY mode
   */
  isPtyProcess(processId: string): boolean {
    const runningProcess = this.processes.get(processId);
    return runningProcess?.isPty ?? false;
  }

  /**
   * Subscribe to log updates for a process
   * Returns an unsubscribe function
   */
  subscribe(processId: string, callback: LogSubscriber): (() => void) | null {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      return null;
    }

    runningProcess.subscribers.add(callback);

    return () => {
      runningProcess.subscribers.delete(callback);
    };
  }

  /**
   * Get all historical logs for a process
   */
  getLogs(processId: string): LogMessage[] {
    const runningProcess = this.processes.get(processId);
    return runningProcess?.logs ?? [];
  }

  /**
   * Snapshot the tail output from a process's logs, stripping ANSI codes.
   * Used to include output in executor:stopped events.
   */
  private snapshotTailOutput(logs: LogMessage[]): string {
    const outputLogs = logs.filter(
      (l) => l.type === "pty" || l.type === "stdout" || l.type === "stderr"
    );
    const tail = outputLogs.slice(-100);
    let raw = tail.map((l) => (l as { data: string }).data).join("");
    raw = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
    return raw.length > 10000 ? raw.slice(-10000) : raw;
  }

  /**
   * Check if a process is still running
   */
  isRunning(processId: string): boolean {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) {
      return false;
    }

    if (runningProcess.isPty) {
      // PTY processes: check if the last log is a "finished" message
      const lastLog = runningProcess.logs[runningProcess.logs.length - 1];
      return lastLog?.type !== "finished";
    } else {
      // Regular processes: check killed and exitCode
      const childProcess = runningProcess.process as ChildProcess;
      return !childProcess.killed && childProcess.exitCode === null;
    }
  }

  /**
   * Get all running process IDs
   */
  getRunningProcessIds(): string[] {
    return Array.from(this.processes.entries())
      .filter(([id, proc]) => {
        if (proc.isPty) {
          const lastLog = proc.logs[proc.logs.length - 1];
          return lastLog?.type !== "finished";
        } else {
          const childProcess = proc.process as ChildProcess;
          return !childProcess.killed && childProcess.exitCode === null;
        }
      })
      .map(([id]) => id);
  }

  /**
   * Get all running terminal sessions for a project
   */
  getTerminals(projectId: string, branch?: string | null): TerminalInfo[] {
    const terminals: TerminalInfo[] = [];
    const filterBranch = branch === undefined ? undefined : (branch ?? null);
    for (const [id, proc] of this.processes) {
      if (proc.isTerminal && proc.projectId === projectId) {
        if (filterBranch !== undefined && proc.branch !== filterBranch) continue;
        const lastLog = proc.logs[proc.logs.length - 1];
        if (lastLog?.type !== "finished") {
          terminals.push({ id, projectId: proc.projectId, name: proc.name, cwd: proc.projectPath, branch: proc.branch });
        }
      }
    }
    return terminals;
  }

  /**
   * Get all processes for a given executor ID with their status and logs
   */
  getProcessesByExecutorId(executorId: string): Array<{
    processId: string;
    isRunning: boolean;
    logs: LogMessage[];
  }> {
    const results: Array<{ processId: string; isRunning: boolean; logs: LogMessage[] }> = [];
    for (const [processId, proc] of this.processes) {
      if (proc.executorId === executorId) {
        results.push({
          processId,
          isRunning: this.isRunning(processId),
          logs: proc.logs,
        });
      }
    }
    return results;
  }

  /**
   * Kill all running processes and clear state for graceful shutdown
   */
  shutdown(): void {
    for (const [id, proc] of this.processes) {
      try {
        if (proc.isPty) {
          (proc.process as IPty).kill();
        } else {
          (proc.process as ChildProcess).kill("SIGTERM");
        }
      } catch { /* ignore - process may already be dead */ }
    }
    this.processes.clear();
  }

  /**
   * Broadcast a message to all subscribers of a process
   */
  private broadcast(processId: string, msg: LogMessage): void {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) return;

    for (const subscriber of runningProcess.subscribers) {
      try {
        subscriber(msg);
      } catch (error) {
        console.error("Error in log subscriber:", error);
      }
    }
  }
}
