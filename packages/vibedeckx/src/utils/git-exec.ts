import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Per git call. Kept under the hub's 30s tunnel timeout so a slow repo comes
 * back to the user as the route's own error, not a generic proxy timeout.
 */
export const GIT_TIMEOUT_MS = 20_000;

/** A git call outlived its timeout. Carries the HTTP status routes answer with. */
export class GitTimeoutError extends Error {
  readonly statusCode = 504;

  constructor(args: string[], timeoutMs: number) {
    super(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms — the repository may be too large or busy`);
    this.name = "GitTimeoutError";
  }
}

/**
 * Run git without blocking the event loop. Request paths must use this rather
 * than execFileSync: a slow git (huge repo, index lock, slow disk) should hold
 * only its own request, not every session stream and terminal on the machine.
 *
 * Throws GitTimeoutError on timeout, and execFile's error for any other
 * failure (non-zero exit, oversized output).
 */
export async function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    // execFile's timeout kills the child and flags the error `killed`. An
    // over-maxBuffer kill is excluded: that's an oversized output, not a slow one.
    const e = err as { killed?: boolean; code?: unknown } | null;
    if (e?.killed === true && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GitTimeoutError(args, timeoutMs);
    }
    throw err;
  }
}

/** For catch blocks that read a git failure as "no": let a timeout through instead. */
export function rethrowGitTimeout(err: unknown): void {
  if (err instanceof GitTimeoutError) throw err;
}
