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

function runPrompt(pm: ProcessManager, provider: "claude" | "codex" | "fx", prompt: string, cwd: string) {
  return new Promise<{ exitCode: number | null; finalResult?: string }>((resolve, reject) => {
    const executor: Executor = {
      id: `smoke-${provider}`, project_id: "p", workspace_id: "", name: "smoke",
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
    writeFileSync(path.join(bin, "fx"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FX_AUTO_UPGRADE !== '0' || args[0] !== 'ask' || args[2] !== 'auto' || args[3] !== '--json') process.exit(2);
const prompt = args.at(-1);
if (prompt === 'malformed') { console.log('invalid'); process.exit(0); }
const code = prompt === 'approval' ? 1 : prompt === 'usage' ? 2 : 0;
console.error(code ? 'Permission required or invalid arguments' : 'working');
console.log(JSON.stringify({ output: code ? '' : 'working\\n# fx Report', final_output: code ? '' : '# fx Report', exit_code: prompt === 'reported-failure' ? 1 : code }));
process.exit(code);
`);
    chmodSync(path.join(bin, "fx"), 0o755);
    chmodSync(path.join(bin, "claude"), 0o755);
    chmodSync(path.join(bin, "codex"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([['ok', 0, '# fx Report'], ['approval', 1, undefined], ['usage', 2, undefined], ['malformed', 1, undefined], ['reported-failure', 1, '# fx Report']] as const)(
    "fx captures final output and status: %s", async (prompt, code, finalResult) => {
      const pm = new ProcessManager(fakeStorage);
      const res = await runPrompt(pm, "fx", prompt, cwd);
      expect(res).toEqual({ exitCode: code, finalResult });
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
