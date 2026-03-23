import { spawn, execFileSync, type ChildProcess } from "child_process";
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
      return `${binary} -p '${escapedPrompt}' --dangerously-skip-permissions`;
    }
    return `npx -y @anthropic-ai/claude-code -p '${escapedPrompt}' --dangerously-skip-permissions`;
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
    const cwd = executor.cwd || projectPath;

    // For prompt executors, build the provider-specific command
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

    this.eventBus?.emit({ type: "executor:started", projectId: executor.project_id, executorId: executor.id, processId });

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

    let shell: string;
    if (process.platform === "win32") {
      shell = "powershell.exe";
    } else {
      shell = process.env.SHELL || "/bin/zsh";
      if (!shell.includes("/")) {
        shell = `/bin/${shell}`;
      }
    }

    console.log(`[ProcessManager] Starting terminal ${processId} (${name}) in ${cwd}`);

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" } as Record<string, string>,
    });

    const runningProcess: RunningProcess = {
      process: ptyProcess,
      isPty: true,
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

    ptyProcess.onData((data: string) => {
      const msg: LogMessage = { type: "pty", data };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);
    });

    ptyProcess.onExit(({ exitCode }) => {
      const code = exitCode ?? 0;
      console.log(`[ProcessManager] Terminal ${processId} exited with code ${code}`);
      const msg: LogMessage = { type: "finished", exitCode: code };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);
      this.processes.delete(processId);
    });

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

    // Handle PTY data output
    ptyProcess.onData((data: string) => {
      const msg: LogMessage = { type: "pty", data };
      runningProcess.logs.push(msg);
      if (runningProcess.logs.length > TERMINAL_MAX_LOG_ENTRIES) {
        runningProcess.logs = runningProcess.logs.slice(-TERMINAL_MAX_LOG_ENTRIES);
      }
      this.broadcast(processId, msg);
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      const code = exitCode ?? 0;
      const status: ExecutorProcessStatus = code === 0 ? "completed" : "failed";

      console.log(`[ProcessManager] PTY process ${processId} exited with code ${code}`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, code);
      }

      const msg: LogMessage = { type: "finished", exitCode: code };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: code });

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
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode });

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
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: 1 });
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
   * Handle input from the client (for PTY processes)
   */
  handleInput(processId: string, message: InputMessage): boolean {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess || !runningProcess.isPty) {
      return false;
    }

    const ptyProcess = runningProcess.process as IPty;

    if (message.type === "input") {
      ptyProcess.write(message.data);
      return true;
    } else if (message.type === "resize") {
      ptyProcess.resize(message.cols, message.rows);
      return true;
    }

    return false;
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
