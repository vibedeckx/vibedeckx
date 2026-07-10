import { describe, it, expect } from "vitest";
import { runOneShot, MAX_OUTPUT_BYTES } from "./one-shot-exec.js";

describe("runOneShot", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runOneShot("echo hello", { timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runOneShot("echo oops >&2; exit 3", { timeoutMs: 5000 });
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(3);
  });

  it("runs in the given cwd", async () => {
    const result = await runOneShot("pwd", { cwd: "/tmp", timeoutMs: 5000 });
    expect(result.stdout.trim()).toContain("tmp");
  });

  it("kills the process on timeout and reports timedOut", async () => {
    const result = await runOneShot("sleep 5", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("truncates output beyond the cap and keeps the process from hanging", async () => {
    const result = await runOneShot(`head -c ${MAX_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' 'x'`, { timeoutMs: 10000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});
