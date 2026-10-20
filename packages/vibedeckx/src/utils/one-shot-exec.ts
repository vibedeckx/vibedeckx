import { spawn } from "child_process";
import { killProcessTree, treeSpawnOptions } from "./process-tree.js";

export const MAX_OUTPUT_BYTES = 65536;

// How long to wait for "close" after a timeout kill before giving up on the pipes.
const CLOSE_GRACE_MS = 1000;

export interface OneShotResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Runs a shell command to completion, capping each stream at MAX_OUTPUT_BYTES and
 * killing the process group on timeout. Unlike child_process.exec's maxBuffer, hitting
 * the cap does not discard what was already captured.
 */
export function runOneShot(
  command: string,
  opts: { cwd?: string; timeoutMs: number },
): Promise<OneShotResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      ...treeSpawnOptions(), // so the kill below reaches grandchildren
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr") => (data: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - sizes[stream];
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (data.length > remaining) {
        chunks[stream].push(data.subarray(0, remaining));
        sizes[stream] = MAX_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      chunks[stream].push(data);
      sizes[stream] += data.length;
    };

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const killTree = () => {
      if (child.pid === undefined) return;
      if (!killProcessTree(child.pid, "SIGKILL")) child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // A descendant the kill could not reach (it left the process group, or on
      // Windows its root exited before taskkill /T could walk to it) keeps our
      // pipes open and withholds "close" — stop waiting for it.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(124);
      }, CLOSE_GRACE_MS).unref();
    }, opts.timeoutMs);

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        exitCode,
        timedOut,
        truncated,
      });
    };

    child.on("close", (code) => settle(timedOut ? (code ?? 124) : code));
    child.on("error", (err) => {
      chunks.stderr.push(Buffer.from(String(err)));
      settle(127);
    });
  });
}
