import { spawn, type ChildProcess } from "child_process";
import { existsSync, chmodSync, readdirSync, statSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createRequire } from "module";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { Executor, ExecutorProcessStatus, PromptProvider, Storage } from "./storage/types.js";
import type { EventBus } from "./event-bus.js";
import { detectBinary, getBinaryVersion } from "./protocol/shared/binary.js";
import { buildCodexExecCommand } from "./protocol/codex/cli.js";
import {
  buildClaudePrintCommand,
  buildClaudeStreamExecutorSpawn,
} from "./protocol/claude-code/cli.js";
import { serializeUserInput } from "./protocol/claude-code/codec.js";

export type LogMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "pty"; data: string }
  | { type: "finished"; exitCode: number | null; finalResult?: string };

export class ProcessEffectConflictError extends Error {}

export interface ProcessLogBufferStats {
  /** Live + retained-after-exit entries in the process map. */
  processes: number;
  running: number;
  terminals: number;
  log_entries: number;
  /** Sum of chunk payloads in UTF-16 code units — see the caveat on CacheEntry.approxBytes. */
  approx_bytes: number;
  max_process_approx_bytes: number;
}

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
  /** Running sum of `logs` payload lengths — the budget below is enforced on it. */
  logBytes: number;
  /** Output not yet appended to `logs`, waiting for the coalescing window. */
  pending: { type: "stdout" | "stderr" | "pty"; data: string } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Whether this buffer has already dropped output, so we log that once. */
  trimmed: boolean;
  subscribers: Set<LogSubscriber>;
  executorId: string;
  projectId: string;
  projectPath: string;
  branch: string | null;
  skipDb: boolean;
}

const LOG_RETENTION_MS = 30 * 60 * 1000; // keep a finished process's logs replayable for 30 min after exit
const TERMINAL_MAX_LOG_ENTRIES = 5000;
/**
 * The entry cap alone bounds nothing: a chunk is whatever one read returned, up
 * to tens of KB, so 5000 of them can be hundreds of MB. This is the cap that
 * actually holds, in UTF-16 code units of payload (≈ bytes for ASCII output).
 */
const TERMINAL_MAX_LOG_BYTES = 4 * 1024 * 1024;
/**
 * Trim down to this fraction of the caps rather than to exactly the cap, so a
 * process that sits at the limit pays for the shift once per 10% of churn
 * instead of on every single append.
 */
const LOG_TRIM_TARGET = 0.9;
/**
 * Output arriving within this window is concatenated into one entry. A noisy
 * build emits hundreds of small chunks per second; each one otherwise costs a
 * LogMessage object, a subscriber broadcast and a WebSocket frame. Short enough
 * to stay under a frame, so interactive echo is unaffected.
 */
const LOG_COALESCE_MS = 8;
/**
 * Flush the coalescing buffer once it reaches this size instead of waiting out
 * the window. Without it a fast producer could merge megabytes into a single
 * entry, which the trim cannot then shrink (it only drops whole entries) and
 * which arrives at the browser as one huge frame.
 */
const LOG_COALESCE_MAX_BYTES = 128 * 1024;

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
  private processEffects = new Map<string, string>();
  private storage: Storage;
  private eventBus: EventBus | null = null;
  private terminalCounter = 0;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Payload size of one entry; `finished` carries an uncapped finalResult. */
  private static logMessageBytes(msg: LogMessage): number {
    const data = (msg as { data?: string }).data;
    const finalResult = (msg as { finalResult?: string }).finalResult;
    return (typeof data === "string" ? data.length : 0)
      + (typeof finalResult === "string" ? finalResult.length : 0);
  }

  /**
   * Drop entries from the head until the buffer is back under both caps.
   *
   * `splice` rather than the `slice(-N)` this replaces: same shift, but it
   * mutates in place instead of allocating a fresh 5000-element array on every
   * over-cap append.
   */
  private trimLogs(processId: string, rp: RunningProcess): void {
    const maxEntries = Math.floor(TERMINAL_MAX_LOG_ENTRIES * LOG_TRIM_TARGET);
    const maxBytes = Math.floor(TERMINAL_MAX_LOG_BYTES * LOG_TRIM_TARGET);

    let drop = 0;
    let bytes = rp.logBytes;
    while (
      // Never drop the newest entry, even when it alone exceeds the budget.
      // Emptying the buffer would take the `finished` marker with it, and
      // isRunning() reads an empty buffer as "no finished entry ⇒ still
      // running" — a dead process pinned to Running for the whole retention
      // window. One oversized entry over budget is the cheaper failure.
      drop < rp.logs.length - 1
      && (rp.logs.length - drop > maxEntries || bytes > maxBytes)
    ) {
      bytes -= ProcessManager.logMessageBytes(rp.logs[drop]);
      drop++;
    }
    if (drop === 0) return;

    rp.logs.splice(0, drop);
    rp.logBytes = bytes;
    if (!rp.trimmed) {
      rp.trimmed = true;
      console.log(`[ProcessManager] Log buffer for ${processId} hit its cap; oldest output is being dropped`);
    }
  }

  /**
   * Append one entry and fan it out. Every write to `logs` goes through here so
   * the byte accounting and the caps cannot be bypassed.
   */
  private appendLog(processId: string, rp: RunningProcess, msg: LogMessage): void {
    const last = rp.logs[rp.logs.length - 1];
    if (msg.type !== "finished" && last?.type === "finished") {
      // A PTY can deliver output AFTER onExit — that is exactly why the drain
      // mechanism in startPtyProcess exists. Appending it would leave the exit
      // marker in the middle of the buffer, and isRunning() decides a PTY
      // process is alive by checking whether the LAST entry is `finished`, so
      // one late chunk pinned a dead executor to "Running" for the whole
      // retention window (and left replay clients waiting for an exit that had
      // already happened). Keep the marker last; live subscribers still get
      // the chunk in arrival order via the broadcast below.
      rp.logs.splice(rp.logs.length - 1, 0, msg);
    } else {
      rp.logs.push(msg);
    }
    rp.logBytes += ProcessManager.logMessageBytes(msg);
    if (rp.logs.length > TERMINAL_MAX_LOG_ENTRIES || rp.logBytes > TERMINAL_MAX_LOG_BYTES) {
      this.trimLogs(processId, rp);
    }
    this.broadcast(processId, msg);
  }

  /** Commit any coalesced output. Safe to call when nothing is pending. */
  private flushPending(processId: string, rp: RunningProcess): void {
    if (rp.pendingTimer) {
      clearTimeout(rp.pendingTimer);
      rp.pendingTimer = null;
    }
    const pending = rp.pending;
    if (!pending) return;
    rp.pending = null;
    this.appendLog(processId, rp, pending as LogMessage);
  }

  /**
   * Buffer a chunk of process output for up to LOG_COALESCE_MS.
   *
   * Chunks of different types never merge, so stdout/stderr interleaving is
   * preserved exactly as it was observed.
   */
  private appendOutput(
    processId: string,
    rp: RunningProcess,
    type: "stdout" | "stderr" | "pty",
    data: string,
  ): void {
    if (rp.pending && rp.pending.type === type) {
      rp.pending.data += data;
      if (rp.pending.data.length >= LOG_COALESCE_MAX_BYTES) this.flushPending(processId, rp);
      return; // otherwise the already-armed timer will flush it
    }
    this.flushPending(processId, rp);
    if (data.length >= LOG_COALESCE_MAX_BYTES) {
      // Already big enough on its own — no point holding it for more.
      this.appendLog(processId, rp, { type, data } as LogMessage);
      return;
    }
    rp.pending = { type, data };
    rp.pendingTimer = setTimeout(() => {
      rp.pendingTimer = null;
      const proc = this.processes.get(processId);
      if (proc === rp) this.flushPending(processId, rp);
    }, LOG_COALESCE_MS);
    rp.pendingTimer.unref?.();
  }

  /**
   * Append a terminal `finished` entry, flushing buffered output first.
   *
   * Ordering is load-bearing twice over: replay must not show the exit before
   * the output that preceded it, and `isRunning()` decides a PTY process is
   * alive by checking whether the LAST entry is `finished`, so buffered output
   * must never jump ahead of it.
   *
   * Output that arrives *after* the exit is handled on the other side, in
   * appendLog: it is spliced in ahead of the marker so the marker stays last.
   */
  private appendFinished(processId: string, rp: RunningProcess, msg: LogMessage): void {
    this.flushPending(processId, rp);
    this.appendLog(processId, rp, msg);
  }

  /**
   * Build the shell command string for a prompt executor.
   * Supports claude and codex providers. Command shapes live in the
   * protocol layer (src/protocol/).
   */
  private buildPromptCommand(prompt: string, provider: PromptProvider, finalResultFile?: string): string {
    if (provider === 'codex') {
      const binary = detectBinary('codex');
      if (binary) {
        console.log(`[ProcessManager] codex version: ${getBinaryVersion(binary) ?? 'unknown'}`);
      }
      return buildCodexExecCommand(binary, prompt, finalResultFile);
    }
    const binary = detectBinary('claude');
    if (binary) {
      console.log(`[ProcessManager] claude version: ${getBinaryVersion(binary) ?? 'unknown'}`);
    }
    return buildClaudePrintCommand(binary, prompt);
  }

  /**
   * Read (and delete) the scratch file a prompt provider wrote its final
   * message to. Returns undefined when the file is missing/empty (failed or
   * interrupted run, or an old provider version without the flag).
   */
  private consumeFinalResultFile(file?: string): string | undefined {
    if (!file) return undefined;
    try {
      const content = readFileSync(file, 'utf8').trim();
      rmSync(file, { force: true });
      return content || undefined;
    } catch {
      return undefined;
    }
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
  async start(
    executor: Executor,
    projectPath: string,
    skipDb = false,
    preallocatedProcessId?: string,
    suppliedEffectFingerprint?: string,
  ): Promise<string> {
    const processId = preallocatedProcessId ?? crypto.randomUUID();
    const cwd = executor.cwd
      ? (path.isAbsolute(executor.cwd) ? executor.cwd : path.join(projectPath, executor.cwd))
      : projectPath;
    const effect = JSON.stringify({ scope: suppliedEffectFingerprint ?? null,
      projectId: executor.project_id, command: executor.command, executorType: executor.executor_type,
      provider: executor.prompt_provider, cwd,
    });
    // Retry of a durable schedule claim after a lost response: the first
    // request already spawned this exact process, so return its identity
    // instead of launching a duplicate.
    if (preallocatedProcessId && this.processes.has(processId)) {
      if (this.processEffects.get(processId) !== effect) {
        throw new ProcessEffectConflictError("Process identity is already bound to a different effect");
      }
      return processId;
    }
    // Create process record in database (skip for remote path-based execution)
    if (!skipDb) {
      await this.storage.executorProcesses.create({
        id: processId,
        executor_id: executor.id,
      });
    }

    // Determine working directory
    // If executor.cwd is set, resolve it relative to the worktree/project path
    // so that sub-directory paths work correctly across worktrees
    // For claude prompt executors, use stream-json mode for real-time streaming
    if (executor.executor_type === 'prompt' && (executor.prompt_provider ?? 'claude') === 'claude') {
      console.log(`[ProcessManager] Starting stream-json process ${processId}`);
      console.log(`[ProcessManager] Type: prompt (claude stream-json)`);
      console.log(`[ProcessManager] Prompt: ${executor.command.slice(0, 100)}${executor.command.length > 100 ? '...' : ''}`);
      console.log(`[ProcessManager] CWD: ${cwd}`);
      this.startClaudeStreamProcess(processId, executor, cwd, skipDb);
    } else {
      // For non-claude prompt executors, build the provider-specific command.
      // Codex prompt runs get a scratch file for the agent's final message
      // (read back on exit as the run's report).
      const finalResultFile = executor.executor_type === 'prompt' && executor.prompt_provider === 'codex'
        ? path.join(tmpdir(), `vibedeckx-last-msg-${processId}.txt`)
        : undefined;
      const effectiveExecutor = executor.executor_type === 'prompt'
        ? { ...executor, command: this.buildPromptCommand(executor.command, executor.prompt_provider ?? 'claude', finalResultFile) }
        : executor;

      console.log(`[ProcessManager] Starting process ${processId}`);
      console.log(`[ProcessManager] Type: ${executor.executor_type || 'command'}${executor.executor_type === 'prompt' ? ` (${executor.prompt_provider ?? 'claude'})` : ''}`);
      console.log(`[ProcessManager] Command: ${effectiveExecutor.command}`);
      console.log(`[ProcessManager] CWD: ${cwd}`);
      console.log(`[ProcessManager] Forcing PTY mode for ANSI color support`);

      // Always use PTY mode for proper ANSI color support
      try {
        this.startPtyProcess(processId, effectiveExecutor, cwd, skipDb, finalResultFile);
        console.log(`[ProcessManager] PTY mode started successfully`);
      } catch (error) {
        // PTY failed (e.g., native module not compiled), fallback to regular process
        console.warn(`[ProcessManager] PTY spawn failed, falling back to regular process: ${error}`);
        this.startRegularProcess(processId, effectiveExecutor, cwd, skipDb, finalResultFile);
      }
    }

    // Bind the effect only after a retained process identity exists. Exit keeps
    // both entries for log replay; retention cleanup removes both together.
    this.processEffects.set(processId, effect);

    // Store PID in database for recovery after server restart
    if (!skipDb) {
      const runningProcess = this.processes.get(processId);
      if (runningProcess) {
        const pid = runningProcess.isPty
          ? (runningProcess.process as IPty).pid
          : (runningProcess.process as ChildProcess).pid;
        if (pid) {
          await this.storage.executorProcesses.updatePid(processId, pid);
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
      logBytes: 0,
      pending: null,
      pendingTimer: null,
      trimmed: false,
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
        this.appendOutput(processId, runningProcess, "pty", data);
      });

      ptyProc.onExit(({ exitCode }) => {
        const code = exitCode ?? 0;
        console.log(`[ProcessManager] Terminal ${processId} exited with code ${code}`);
        this.appendFinished(processId, runningProcess, { type: "finished", exitCode: code });
        setTimeout(() => {
          this.processes.delete(processId);
          this.processEffects.delete(processId);
        }, LOG_RETENTION_MS);
      });
    } else {
      const childProc = proc as ChildProcess;
      childProc.stdout?.on("data", (data: Buffer) => {
        this.appendOutput(processId, runningProcess, "pty", data.toString());
      });
      childProc.stderr?.on("data", (data: Buffer) => {
        this.appendOutput(processId, runningProcess, "pty", data.toString());
      });
      childProc.on("close", (code) => {
        const exitCode = code ?? 0;
        console.log(`[ProcessManager] Terminal ${processId} exited with code ${exitCode}`);
        this.appendFinished(processId, runningProcess, { type: "finished", exitCode });
        setTimeout(() => {
          this.processes.delete(processId);
          this.processEffects.delete(processId);
        }, LOG_RETENTION_MS);
      });
    }

    return { id: processId, name };
  }

  /**
   * Start a process using node-pty (for interactive commands)
   */
  private startPtyProcess(processId: string, executor: Executor, cwd: string, skipDb = false, finalResultFile?: string): void {
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
      logBytes: 0,
      pending: null,
      pendingTimer: null,
      trimmed: false,
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
    let finalResult: string | undefined;

    const emitStopped = () => {
      if (!exitPending) return;
      const { code } = exitPending;
      exitPending = null;
      drainHandle = null;
      // The drain runs on setImmediate, which fires well before the coalescing
      // window — without this the tail would be missing the final chunks.
      this.flushPending(processId, runningProcess);
      const tailOutput = this.snapshotTailOutput(runningProcess.logs);
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode: code, target: "local", tailOutput, finalResult });
    };

    const scheduleDrain = () => {
      if (drainHandle) clearImmediate(drainHandle);
      drainHandle = setImmediate(emitStopped);
    };

    // Handle PTY data output
    ptyProcess.onData((data: string) => {
      this.appendOutput(processId, runningProcess, "pty", data);

      // If exit is pending, reset drain — more data may follow
      if (exitPending) {
        scheduleDrain();
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      const code = exitCode ?? 0;
      const status: ExecutorProcessStatus = code === 0 ? "completed" : "failed";

      console.log(`[ProcessManager] PTY process ${processId} exited with code ${code}`);
      console.log(`[diag:remote-stop] ${new Date().toISOString()} PTY onExit (this machine's process truly exited) processId=${processId} executorId=${runningProcess.executorId} code=${code} — if seen on the REMOTE machine, the executor genuinely finished (mechanism B), not a transport drop`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, code).catch((err) => {
          console.error(`[ProcessManager] Failed to update status for process ${processId}:`, err);
        });
      }

      finalResult = this.consumeFinalResultFile(finalResultFile);
      this.appendFinished(processId, runningProcess, { type: "finished", exitCode: code, finalResult });

      // Start drain — will emit once no more onData callbacks arrive
      exitPending = { code };
      scheduleDrain();

      // Schedule cleanup after retention period
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
        this.processEffects.delete(processId);
      }, LOG_RETENTION_MS);
    });
  }

  /**
   * Start a process using regular spawn (for non-interactive commands)
   */
  private startRegularProcess(processId: string, executor: Executor, cwd: string, skipDb = false, finalResultFile?: string): void {
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
      logBytes: 0,
      pending: null,
      pendingTimer: null,
      trimmed: false,
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
      this.appendOutput(processId, runningProcess, "stdout", data.toString());
    });

    // Handle stderr
    childProcess.stderr?.on("data", (data: Buffer) => {
      this.appendOutput(processId, runningProcess, "stderr", data.toString());
    });

    // Exactly-once terminal path. Both 'close' and 'error' can reach it, and a
    // spawn failure emits both — without the guard each would append its own
    // `finished`, emit a second stopped event and arm a second cleanup timer.
    let finalized = false;
    const finalize = (exitCode: number, finalResult?: string) => {
      if (finalized) return;
      finalized = true;
      this.appendFinished(processId, runningProcess, { type: "finished", exitCode, finalResult });
      this.eventBus?.emit({ type: "executor:stopped", projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs), finalResult });
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
        this.processEffects.delete(processId);
      }, LOG_RETENTION_MS);
    };

    // Handle process exit
    childProcess.on("close", (code) => {
      const exitCode = code ?? 0;
      const status: ExecutorProcessStatus = exitCode === 0 ? "completed" : "failed";

      console.log(`[ProcessManager] Process ${processId} exited with code ${exitCode}`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, exitCode).catch((err) => {
          console.error(`[ProcessManager] Failed to update status for process ${processId}:`, err);
        });
      }

      // close event guarantees all stdio is flushed — safe to snapshot now
      finalize(exitCode, this.consumeFinalResultFile(finalResultFile));
    });

    childProcess.on("error", (error) => {
      this.appendOutput(processId, runningProcess, "stderr", `Error: ${error.message}`);

      // 'error' does NOT imply the child is gone — Node also emits it when a
      // kill or an IPC send fails, and that child is still running. Declaring
      // it finished there would lie to the UI and, now that finalize schedules
      // cleanup, would drop a live process out of the map after the retention
      // window. A spawn that never happened is the one case nothing else will
      // report, and it is identifiable: no pid was ever assigned.
      if (childProcess.pid !== undefined) {
        console.warn(`[ProcessManager] Process ${processId} reported an error while still alive: ${error.message}`);
        return;
      }

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, "failed", 1).catch((err) => {
          console.error(`[ProcessManager] Failed to update status for process ${processId}:`, err);
        });
      }

      finalize(1);
    });
  }

  /**
   * Start a Claude prompt executor using stream-json mode for real-time output.
   * Spawns claude with --output-format=stream-json --input-format=stream-json,
   * sends the prompt via stdin, and parses JSON output into formatted terminal text.
   */
  private startClaudeStreamProcess(processId: string, executor: Executor, cwd: string, skipDb: boolean): void {
    const { command, args: fullArgs } = buildClaudeStreamExecutorSpawn(detectBinary('claude'));

    if (command !== 'npx') {
      console.log(`[ProcessManager] claude version: ${getBinaryVersion(command) ?? 'unknown'}`);
    }

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
      logBytes: 0,
      pending: null,
      pendingTimer: null,
      trimmed: false,
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
    const userMessage = serializeUserInput(executor.command);
    childProcess.stdin?.write(userMessage, () => {
      childProcess.stdin?.end();
    });

    // Stream-JSON parsing state
    let stdoutBuffer = '';
    const prevTextByIndex = new Map<number, string>();
    const seenToolUseIds = new Set<string>();
    // Final assistant text from the 'result' event — captured as the run's report.
    let finalResult: string | undefined;

    const RESET = '\x1b[0m';
    const DIM = '\x1b[2m';
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const BOLD = '\x1b[1m';

    const pushLog = (data: string) => {
      this.appendOutput(processId, runningProcess, 'stdout', data);
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
            if (typeof parsed.result === 'string' && parsed.result.trim()) {
              finalResult = parsed.result;
            }
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

    // Exactly-once terminal path — see startRegularProcess for why.
    let finalized = false;
    const finalize = (exitCode: number) => {
      if (finalized) return;
      finalized = true;
      this.appendFinished(processId, runningProcess, { type: 'finished', exitCode, finalResult });
      this.eventBus?.emit({ type: 'executor:stopped', projectId: runningProcess.projectId, executorId: runningProcess.executorId, processId, exitCode, target: "local", tailOutput: this.snapshotTailOutput(runningProcess.logs), finalResult });
      setTimeout(() => {
        console.log(`[ProcessManager] Cleaning up process ${processId}`);
        this.processes.delete(processId);
        this.processEffects.delete(processId);
      }, LOG_RETENTION_MS);
    };

    // Handle process exit
    childProcess.on('close', (code) => {
      const exitCode = code ?? 0;
      const status: ExecutorProcessStatus = exitCode === 0 ? 'completed' : 'failed';

      console.log(`[ProcessManager] Stream process ${processId} exited with code ${exitCode}`);

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, status, exitCode).catch((err) => {
          console.error(`[ProcessManager] Failed to update status for process ${processId}:`, err);
        });
      }

      // close event guarantees all stdio is flushed — safe to snapshot now
      finalize(exitCode);
    });

    childProcess.on('error', (error) => {
      this.appendOutput(processId, runningProcess, 'stderr', `Error: ${error.message}`);

      // Only a spawn that never happened (no pid) is terminal here — see
      // startRegularProcess.
      if (childProcess.pid !== undefined) {
        console.warn(`[ProcessManager] Stream process ${processId} reported an error while still alive: ${error.message}`);
        return;
      }

      if (!skipDb) {
        this.storage.executorProcesses.updateStatus(processId, 'failed', 1).catch((err) => {
          console.error(`[ProcessManager] Failed to update status for process ${processId}:`, err);
        });
      }

      finalize(1);
    });
  }

  /**
   * Stop a running process
   */
  async stop(processId: string): Promise<boolean> {
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
      await this.storage.executorProcesses.updateStatus(processId, "killed");
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
  private async stopByPid(processId: string): Promise<boolean> {
    const dbProcess = await this.storage.executorProcesses.getById(processId);
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

    // Guarded ("killed" only if still "running") so this doesn't clobber an
    // accurate completion/failure status the process's own exit handler may
    // write around the same time — this fallback path has no in-memory
    // tracking to confirm the process is actually still alive.
    await this.storage.executorProcesses.markKilledIfRunning(processId);
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
  sendToTerminal(
    processId: string,
    command: string,
    expectedProjectId?: string,
    expectedBranch?: string | null,
  ): void {
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
    if (expectedProjectId && runningProcess.projectId !== expectedProjectId) {
      throw new Error(`Terminal ${processId} is not in the active project`);
    }
    if (expectedBranch !== undefined && runningProcess.branch !== (expectedBranch ?? null)) {
      throw new Error(`Terminal ${processId} is not in the active branch`);
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
    if (!runningProcess) return [];
    // Commit buffered output first so a client attaching mid-stream replays
    // everything produced so far, instead of seeing the last few milliseconds
    // arrive as "live" after history_end.
    this.flushPending(processId, runningProcess);
    return runningProcess.logs;
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
   * Aggregate log-buffer footprint, for the operator memory endpoint.
   *
   * On a SaaS hub this is expected to be near-zero: remote executor output is
   * proxied frame-by-frame and never lands here (see attachRemoteProcessStream).
   * A number that is NOT near-zero means local processes — /api/path/execute
   * temporaries, local-target scheduler runs, hub terminals — are accumulating,
   * which is worth knowing before sizing anything else.
   */
  logBufferStats(): ProcessLogBufferStats {
    let logEntries = 0;
    let approxBytes = 0;
    let terminals = 0;
    let maxProcessApproxBytes = 0;

    for (const proc of this.processes.values()) {
      if (proc.isTerminal) terminals++;
      // `logBytes` is the same sum this used to recompute per call, maintained
      // on the append path (it covers both `data` and the uncapped
      // `finalResult` on the terminating entry). Plus whatever is still sitting
      // in the coalescing buffer, which is memory too.
      const procBytes = proc.logBytes + (proc.pending?.data.length ?? 0);
      logEntries += proc.logs.length;
      approxBytes += procBytes;
      if (procBytes > maxProcessApproxBytes) maxProcessApproxBytes = procBytes;
    }

    return {
      processes: this.processes.size,
      running: this.getRunningProcessIds().length,
      terminals,
      log_entries: logEntries,
      approx_bytes: approxBytes,
      max_process_approx_bytes: maxProcessApproxBytes,
    };
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
   * Resolve the projectId of a running interactive terminal. Returns null if
   * the process is unknown or is not a terminal (e.g. an executor process).
   * Used to authorize terminal-scoped routes: the caller must both confirm the
   * id refers to a terminal and that the terminal belongs to a project they own
   * before stopping it.
   */
  getTerminalProjectId(processId: string): string | null {
    const proc = this.processes.get(processId);
    if (!proc || !proc.isTerminal) return null;
    return proc.projectId;
  }

  /**
   * Resolve the projectId of any running process (executor or terminal). Returns
   * null if the process is unknown. Used to authorize per-process WebSocket
   * access: the caller confirms the resolved project belongs to a user they own
   * before streaming logs or forwarding PTY input.
   */
  getProcessProjectId(processId: string): string | null {
    return this.processes.get(processId)?.projectId ?? null;
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
   * Running processes — executor runs and interactive terminals alike — whose
   * working directory is `root` or below it. Used to clear a worktree before
   * it is deleted out from under them.
   *
   * Matching is by cwd rather than by branch on purpose: only terminals carry
   * a `branch`, executor runs are always recorded with `branch: null`, and on
   * a reverse-connect worker they are path-based with no executor row to join
   * through. The cwd is the one identity every spawn path records.
   */
  getRunningProcessIdsUnderPath(root: string): string[] {
    const resolvedRoot = path.resolve(root);
    const ids: string[] = [];
    for (const [id, proc] of this.processes) {
      const relative = path.relative(resolvedRoot, path.resolve(proc.projectPath));
      // "" is the root itself. Being outside it means the traversal is a whole
      // path segment: exactly ".." or ".." followed by a separator. A bare
      // startsWith("..") would also reject legitimate children whose names
      // merely begin with two dots (…/dev/..cache). The segment test still
      // rejects a sibling worktree whose name extends this one's, since
      // …/dev → …/dev2 relativizes to "../dev2".
      const outside = relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative);
      if (relative !== "" && outside) continue;
      if (this.isRunning(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * True once the tracked process has genuinely exited (or is no longer
   * tracked at all).
   *
   * Deliberately not `!isRunning()`: that helper treats `ChildProcess.killed`
   * as exited, and Node sets `killed` the moment a signal is *delivered*, so
   * it would report success while the process is still winding down. Real
   * exit is only observable through `exitCode`/`signalCode` for a child, or
   * the "finished" log the PTY exit handler appends.
   */
  private hasExited(processId: string): boolean {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) return true;
    if (runningProcess.isPty) {
      return runningProcess.logs[runningProcess.logs.length - 1]?.type === "finished";
    }
    const childProcess = runningProcess.process as ChildProcess;
    return childProcess.exitCode !== null || childProcess.signalCode !== null;
  }

  private async waitForExit(processId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.hasExited(processId)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private signalProcessGroup(processId: string, signal: NodeJS.Signals): void {
    const runningProcess = this.processes.get(processId);
    if (!runningProcess) return;
    const pid = runningProcess.isPty
      ? (runningProcess.process as IPty).pid
      : (runningProcess.process as ChildProcess).pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Group signal failed (already reaped, or never a group leader) — fall
      // back to signalling the process itself.
      try { process.kill(pid, signal); } catch { /* already dead */ }
    }
  }

  /**
   * Stop a process and confirm it actually exited, escalating to SIGKILL when
   * SIGTERM is ignored. Returns false if it is still alive after that.
   *
   * `stop()` alone is not enough for a caller that needs the working directory
   * to be free — deleting a worktree — because it reports only that a signal
   * was delivered. SIGTERM is asynchronous and can be trapped or ignored, so
   * the process may still be writing into the tree when `stop()` resolves.
   *
   * What this confirms is the exit of the tracked process, and with it
   * whatever else shared its process group. A grandchild that detached into
   * its own group or session is not observable here and is not covered.
   */
  async stopAndWait(
    processId: string,
    opts?: { termGraceMs?: number; killGraceMs?: number },
  ): Promise<boolean> {
    await this.stop(processId);
    if (await this.waitForExit(processId, opts?.termGraceMs ?? 3000)) return true;

    console.warn(`[ProcessManager] Process ${processId} ignored SIGTERM, escalating to SIGKILL`);
    this.signalProcessGroup(processId, "SIGKILL");
    const exited = await this.waitForExit(processId, opts?.killGraceMs ?? 2000);
    if (!exited) {
      console.error(`[ProcessManager] Process ${processId} survived SIGKILL — cannot confirm exit`);
    }
    return exited;
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
      if (proc.pendingTimer) clearTimeout(proc.pendingTimer);
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
