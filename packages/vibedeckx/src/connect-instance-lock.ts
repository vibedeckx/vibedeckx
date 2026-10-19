import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";

/**
 * One worker per data-dir (worker-supervision-design §3.5).
 *
 * The lock is an open `BEGIN EXCLUSIVE` transaction on a dedicated SQLite file.
 * That gives us, from a dependency we already ship:
 *  - a kernel lock (fcntl on Unix, LockFileEx on Windows), so it is shared by
 *    every process on the host — including other PID namespaces, i.e. two
 *    containers mounting the same volume;
 *  - automatic release when the holder dies, SIGKILL included;
 *  - no inheritance: POSIX record locks belong to the process, not the fd, so
 *    agent/executor children never hold it, and SQLite opens with O_CLOEXEC.
 * Local filesystems only — fcntl over NFS/SMB is not trusted.
 *
 * Mutual exclusion only. Which PID holds the data-dir (for status/stop) is
 * still recorded in run/connect.json.
 */

export class DataDirInUseError extends Error {
  constructor(dataDir: string) {
    super(
      `Data directory ${dataDir} is in use by another vibedeckx connect worker. ` +
        "Stop it first (`vibedeckx connect stop`), or use a different --data-dir.",
    );
    this.name = "DataDirInUseError";
  }
}

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

// A held lock must never be garbage-collected: better-sqlite3 closes the
// connection in its finalizer, which would silently drop the lock.
const heldLocks = new Set<BetterSqlite3Database>();

export function instanceLockPath(dataDir: string): string {
  return path.join(dataDir, "run", "instance.lock");
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

export interface AcquireInstanceLockOptions {
  /** How long to wait for a concurrent holder (e.g. a status probe). */
  timeoutMs?: number;
}

export function acquireInstanceLock(
  dataDir: string,
  options: AcquireInstanceLockOptions = {},
): InstanceLock {
  const lockPath = instanceLockPath(dataDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const db = new Database(lockPath, { timeout: options.timeoutMs ?? 2_000 });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (isBusyError(error)) throw new DataDirInUseError(dataDir);
    throw error;
  }
  heldLocks.add(db);

  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      heldLocks.delete(db);
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Non-blocking probe: is some worker holding this data-dir right now? Takes
 * and drops the lock in microseconds; a worker starting concurrently waits it
 * out through its own acquisition timeout.
 */
export function isInstanceLockHeld(dataDir: string): boolean {
  if (!fs.existsSync(instanceLockPath(dataDir))) return false;
  try {
    acquireInstanceLock(dataDir, { timeoutMs: 0 }).release();
    return false;
  } catch (error) {
    if (error instanceof DataDirInUseError) return true;
    throw error;
  }
}
