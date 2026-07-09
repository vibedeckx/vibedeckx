// Drives the real ProcessManager against stub `claude`/`codex` binaries to
// verify the finished message carries the agent's final message (finalResult):
// claude via the stream-json `result` event, codex via --output-last-message.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ProcessManager, type LogMessage } from "./process-manager.js";
import type { Storage, Executor } from "./storage/types.js";

const fakeStorage = {
  executorProcesses: { create: async () => {}, updateStatus: async () => {}, updatePid: async () => {} },
} as unknown as Storage;

function runPrompt(pm: ProcessManager, provider: "claude" | "codex", prompt: string, cwd: string) {
  return new Promise<{ exitCode: number | null; finalResult?: string }>((resolve, reject) => {
    const executor: Executor = {
      id: `smoke-${provider}`, project_id: "p", group_id: "", name: "smoke",
      command: prompt, executor_type: "prompt", prompt_provider: provider,
      cwd: null, pty: true, position: 0, disabled_targets: [], created_at: new Date().toISOString(),
    };
    void pm.start(executor, cwd, true).then((processId) => {
      const timer = setTimeout(() => reject(new Error(`${provider}: timed out`)), 15000);
      pm.subscribe(processId, (msg: LogMessage) => {
        if (msg.type === "finished") {
          clearTimeout(timer);
          resolve({ exitCode: msg.exitCode, finalResult: msg.finalResult });
        }
      });
    }, reject);
  });
}

describe("ProcessManager prompt-run report capture", () => {
  let dir: string;
  let bin: string;
  let cwd: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-pm-report-"));
    bin = path.join(dir, "bin");
    cwd = path.join(dir, "cwd");
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash
cat > /dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it..."}]}}'
echo '{"type":"result","subtype":"success","duration_ms":1234,"cost_usd":0.01,"result":"# Claude Report\\nDid the thing."}'
`);
    writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
echo "codex stub running"
if [ -n "$out" ]; then printf '## Codex Report\\nAll done.' > "$out"; fi
`);
    chmodSync(path.join(bin, "claude"), 0o755);
    chmodSync(path.join(bin, "codex"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("claude stream run carries the result event text as finalResult", async () => {
    const pm = new ProcessManager(fakeStorage);
    const res = await runPrompt(pm, "claude", "do the thing", cwd);
    expect(res.exitCode).toBe(0);
    expect(res.finalResult).toBe("# Claude Report\nDid the thing.");
  });

  it("codex run reads the --output-last-message file as finalResult", async () => {
    const pm = new ProcessManager(fakeStorage);
    const res = await runPrompt(pm, "codex", "do the other thing", cwd);
    expect(res.exitCode).toBe(0);
    expect(res.finalResult).toBe("## Codex Report\nAll done.");
  });
});
