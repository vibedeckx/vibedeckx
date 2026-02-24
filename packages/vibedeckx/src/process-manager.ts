import { spawn, type ChildProcess } from "child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { Executor, ExecutorProcessStatus, Storage } from "./storage/types.js";
import type { EventBus } from "./event-bus.js";

export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number };

export type InputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type LogSubscriber = (msg: LogMessage) => void;

interface RunningProcess {
  process: ChildProcess | IPty;
  isPty: boolean;
  logs: LogMessage[];
  subscribers: Set<LogSubscriber>;
  executorId: string;
  projectId: string;
  projectPath: string;
  skipDb: boolean;
}

const LOG_RETENTION_MS = 5 * 60 * 1000; // 5 minutes

export class ProcessManager {
  private processes: Map<string, RunningProcess> = new Map();
  private storage: Storage;
  private eventBus: EventBus | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
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

    console.log(`[ProcessManager] Starting process ${processId}`);
    console.log(`[ProcessManager] Command: ${executor.command}`);
    console.log(`[ProcessManager] CWD: ${cwd}`);
    console.log(`[ProcessManager] Forcing PTY mode for ANSI color support`);

    // Always use PTY mode for proper ANSI color support
    try {
      this.startPtyProcess(processId, executor, cwd, skipDb);
      console.log(`[ProcessManager] PTY mode started successfully`);
    } catch (error) {
      // PTY failed (e.g., native module not compiled), fallback to regular process
      console.warn(`[ProcessManager] PTY spawn failed, falling back to regular process: ${error}`);
      this.startRegularProcess(processId, executor, cwd, skipDb);
    }

    this.eventBus?.emit({ type: "executor:started", projectId: executor.project_id, executorId: executor.id, processId });

    return processId;
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
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,
      projectPath: cwd,
      skipDb,
    };

    this.processes.set(processId, runningProcess);
    console.log(`[ProcessManager] PTY process ${processId} added to map, PID: ${ptyProcess.pid}`);

    // Handle PTY data output
    ptyProcess.onData((data: string) => {
      const msg: LogMessage = { type: "pty", data };
      runningProcess.logs.push(msg);
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
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    const runningProcess: RunningProcess = {
      process: childProcess,
      isPty: false,
      logs: [],
      subscribers: new Set(),
      executorId: executor.id,
      projectId: executor.project_id,
      projectPath: cwd,
      skipDb,
    };

    this.processes.set(processId, runningProcess);
    console.log(`[ProcessManager] Regular process ${processId} added to map, PID: ${childProcess.pid}`);

    // Handle stdout
    childProcess.stdout?.on("data", (data: Buffer) => {
      const msg: LogMessage = { type: "stdout", data: data.toString() };
      runningProcess.logs.push(msg);
      this.broadcast(processId, msg);
    });

    // Handle stderr
    childProcess.stderr?.on("data", (data: Buffer) => {
      const msg: LogMessage = { type: "stderr", data: data.toString() };
      runningProcess.logs.push(msg);
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
      return false;
    }

    let killed = false;
    if (runningProcess.isPty) {
      // For PTY processes, use kill method
      const ptyProcess = runningProcess.process as IPty;
      ptyProcess.kill();
      killed = true;
    } else {
      // For regular processes, use SIGTERM
      const childProcess = runningProcess.process as ChildProcess;
      killed = childProcess.kill("SIGTERM");
    }

    if (killed && !runningProcess.skipDb) {
      this.storage.executorProcesses.updateStatus(processId, "killed");
    }

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
