import { spawn } from "child_process";
import path from "path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Spawn options for a child whose whole tree we may later kill.
 *
 * POSIX: `detached` makes the child a process-group leader, so killProcessTree
 * can signal the group and reach grandchildren.
 *
 * Windows: there are no process groups, and `detached` maps to DETACHED_PROCESS —
 * the child (e.g. the cmd.exe of `shell: true`) gets no console, so every console
 * program it launches allocates a new, visible console window whose output never
 * reaches our pipes. So stay attached and let `windowsHide` give the child a
 * hidden console that its own children share.
 */
export function treeSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: !IS_WINDOWS, windowsHide: true };
}

/**
 * Kill a child spawned with treeSpawnOptions() together with its descendants.
 * Returns false when the process (group) no longer exists.
 *
 * Windows has no signals to deliver — Node's own SIGTERM there is already
 * TerminateProcess — and terminating a parent does not take its children with
 * it, so walk the tree with `taskkill /T /F` regardless of `signal`. It runs
 * asynchronously so a slow taskkill cannot stall the event loop; the return
 * value only says the root was alive when the kill was issued — as on POSIX,
 * where a delivered SIGTERM may still be ignored. Callers that need the exit
 * confirmed must wait for it.
 *
 * Known gap: taskkill /T walks from the root, so descendants whose root has
 * already exited are out of reach. Only a Job Object can contain those.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  // Negating PID 1 broadcasts to every process we can signal on POSIX.
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (IS_WINDOWS) return killWindowsTree(pid);
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// taskkill's exit status when the PID no longer exists.
const TASKKILL_NOT_FOUND = 128;

/** Windows half of killProcessTree; `run` is injectable for tests. */
export function killWindowsTree(pid: number, run: typeof spawn = spawn): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Absolute path: the worker's PATH is the user's and may not reach System32.
  const taskkill = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  let fellBack = false;
  // At least stop the root, the way a plain child.kill() would have.
  const fallBack = (reason: string) => {
    if (fellBack) return;
    fellBack = true;
    console.warn(`[process-tree] taskkill for PID ${pid} ${reason}; terminating the root only`);
    try { process.kill(pid); } catch { /* already gone */ }
  };
  const child = run(taskkill, ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => fallBack(`failed to start: ${err.message}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== TASKKILL_NOT_FOUND && code !== null) fallBack(`exited with ${code}`);
  });
  return true;
}
