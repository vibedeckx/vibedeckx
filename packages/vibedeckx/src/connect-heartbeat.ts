import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./utils/atomic-file.js";

/**
 * Local liveness + readiness for a running worker (worker-supervision-design
 * §3.6). The worker rewrites run/status.json from a main-event-loop timer:
 *  - liveness  = the file was rewritten recently, i.e. the main loop runs;
 *  - readiness = the connection state recorded in it.
 * Readers never dial the hub. A wedged main loop shows up as a stale file; v1
 * reports that and does not try to recover from it.
 */

export type ConnectionState =
  | "starting"
  | "connecting"
  | "connected"
  | "auth-failed"
  | "blocked";

export interface WorkerStatus {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  version: string;
  connectTo: string;
  state: ConnectionState;
  /** Why the worker is in this state (error text for auth-failed/blocked/connecting). */
  detail?: string;
  /** What the user should do about it. */
  fix?: string;
  supervisor?: string;
  installMode: string;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Six missed heartbeats. */
export const LIVENESS_STALE_MS = 30_000;

export function workerStatusPath(dataDir: string): string {
  return path.join(dataDir, "run", "status.json");
}

const STATES: readonly ConnectionState[] = [
  "starting",
  "connecting",
  "connected",
  "auth-failed",
  "blocked",
];

export function readWorkerStatus(dataDir: string): WorkerStatus | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(workerStatusPath(dataDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<WorkerStatus> | null;
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.updatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.updatedAt)) ||
      !STATES.includes(parsed.state as ConnectionState)
    ) {
      return undefined;
    }
    return parsed as WorkerStatus;
  } catch {
    return undefined;
  }
}

export interface HeartbeatInit {
  dataDir: string;
  version: string;
  connectTo: string;
  supervisor?: string;
  installMode: string;
  intervalMs?: number;
  now?: () => Date;
}

export class HeartbeatWriter {
  private status: WorkerStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(private readonly init: HeartbeatInit) {
    this.now = init.now ?? (() => new Date());
    this.filePath = workerStatusPath(init.dataDir);
    const startedAt = this.now().toISOString();
    this.status = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt,
      updatedAt: startedAt,
      version: init.version,
      connectTo: init.connectTo,
      state: "starting",
      supervisor: init.supervisor,
      installMode: init.installMode,
    };
  }

  get state(): ConnectionState {
    return this.status.state;
  }

  start(): void {
    this.write();
    if (this.timer) return;
    this.timer = setInterval(
      () => this.write(),
      this.init.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
    // The local server keeps the process alive; the heartbeat must not.
    this.timer.unref?.();
  }

  setState(state: ConnectionState, detail?: string, fix?: string): void {
    this.status = { ...this.status, state, detail, fix };
    this.write();
  }

  setConnectTo(connectTo: string): void {
    this.status = { ...this.status, connectTo };
  }

  /** Stop beating and remove the file if it is still ours. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const current = readWorkerStatus(this.init.dataDir);
    if (current && current.pid === process.pid) {
      fs.rmSync(this.filePath, { force: true });
    }
  }

  private write(): void {
    this.status = { ...this.status, updatedAt: this.now().toISOString() };
    try {
      writeFileAtomic(this.filePath, `${JSON.stringify(this.status)}\n`, {
        mode: 0o600,
        durable: false,
      });
    } catch (error) {
      // A full disk must not take the worker down; status just goes stale.
      console.warn(
        `[Heartbeat] Failed to write ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface LivenessVerdict {
  live: boolean;
  /** Milliseconds since the last heartbeat, when known. */
  ageMs?: number;
}

export function judgeLiveness(
  status: WorkerStatus | undefined,
  pid: number,
  now: Date = new Date(),
): LivenessVerdict | undefined {
  // No file, or a file from another process: this worker predates heartbeats
  // (or has not written its first one yet). Unknown, not dead.
  if (!status || status.pid !== pid) return undefined;
  const ageMs = Math.max(0, now.getTime() - Date.parse(status.updatedAt));
  return { live: ageMs <= LIVENESS_STALE_MS, ageMs };
}
