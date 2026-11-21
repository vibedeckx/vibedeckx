/**
 * A short-lived conversation with a line-protocol CLI: spawn it, write some
 * request lines, read stdout line by line until `onLine` returns an answer,
 * then kill it. Used for read-only handshakes (model catalogs) that need the
 * agent's own protocol but no session.
 */
import { spawn } from "child_process";
import { tmpdir } from "os";
import type { SpawnConfig } from "../../agent-provider.js";
import { treeSpawnOptions, killProcessTree } from "../../utils/process-tree.js";

export interface LineProbe<T> {
  /** Lines written right after spawn (newline-terminated). */
  initial: string[];
  /**
   * Called per stdout line. Return `{ done: value }` to finish, `{ write }` to
   * send more lines (e.g. the next page), or nothing to keep reading. Throwing
   * fails the probe.
   */
  onLine: (line: string) => { done: T } | { write: string } | void;
  timeoutMs: number;
}

export function runLineProbe<T>(config: SpawnConfig, probe: LineProbe<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      // Not a project directory: the probe must not pick up a repo's hooks,
      // MCP config or instructions, and must not touch any workspace.
      cwd: tmpdir(),
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "ignore"],
      shell: config.shell ?? false,
      ...treeSpawnOptions(),
    });
    let settled = false;
    let buffer = "";
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stdin?.end();
      if (child.pid !== undefined) killProcessTree(child.pid);
      if (err) reject(err); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`${config.command} did not answer within ${probe.timeoutMs} ms`)), probe.timeoutMs);

    child.on("error", (err) => finish(err));
    child.on("exit", (code) => finish(new Error(`${config.command} exited (${code}) before answering`)));
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while (!settled && (nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const step = probe.onLine(line);
          if (step && "done" in step) finish(null, step.done);
          else if (step && "write" in step) child.stdin?.write(step.write);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    for (const line of probe.initial) child.stdin?.write(line);
  });
}
