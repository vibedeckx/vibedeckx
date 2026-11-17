/**
 * Agent-agnostic contract for an executor run over plain pipes (no PTY).
 *
 * A protocol module describes how to launch its CLI and how to turn the CLI's
 * stdout/stderr into display text and a final result. ProcessManager owns
 * everything else — process registration, log buffering, stop, status,
 * events and cleanup — so no agent-specific branch lives there.
 */

export interface PipedRunResult {
  /** Extra stdout text to show once the run has settled. */
  output?: string;
  /** Extra stderr text to show once the run has settled. */
  error?: string;
  /** The run's report (shown as the executor result / schedule report). */
  finalResult?: string;
  exitCode: number;
}

export interface PipedRunDecoder {
  /** Display text for a stdout chunk; undefined shows nothing (e.g. buffered). */
  stdout(chunk: string): string | undefined;
  /** Display text for a stderr chunk; undefined shows nothing. */
  stderr(chunk: string): string | undefined;
  /**
   * Settle the run after the process closed (all stdio flushed).
   * `code` is null when the process died from a signal; `stopped` is true when
   * the user asked to stop it, so a truncated output is expected, not an error.
   */
  finish(exit: { code: number | null; stopped: boolean }): PipedRunResult;
}

export interface PipedRunSpec {
  command: string;
  args: string[];
  shell: boolean;
  env?: Record<string, string>;
  /**
   * Write this to stdin, then close it. `null` closes stdin immediately (an
   * unattended run must never wait for input); omitted leaves stdin open.
   */
  stdin?: string | null;
  decoder: PipedRunDecoder;
}

/** Plain commands: show output as-is; the exit code is the process's own. */
export function passthroughDecoder(finalResult?: () => string | undefined): PipedRunDecoder {
  return {
    stdout: (chunk) => chunk,
    stderr: (chunk) => chunk,
    finish: ({ code }) => ({ exitCode: code ?? 0, finalResult: finalResult?.() }),
  };
}
