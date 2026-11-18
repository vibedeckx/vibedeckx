import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Opt-in product-path acceptance with the installed fx and original credentials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessManager, type LogMessage } from "../../process-manager.js";
import { SchedulerService } from "../../scheduler.js";
import { createSqliteStorage } from "../../storage/sqlite.js";
import type { Executor } from "../../storage/types.js";
import { buildFxAskSpawnConfig } from "../fx/cli.js";

describe.skipIf(process.env.FX_EXECUTOR_LIVE !== "1")("real fx executor and cron", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); });
  it("historical: auto with an explicit ask rule fails unattended (real CLI, synthetic model)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx8-permission-"));
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const tool = { index: 0, id: "probe", type: "function", function: {
        name: "shell", arguments: JSON.stringify({ action: "run", command: "printf FX_AUTO_APPROVAL_PROBE" }),
      } };
      for (const choice of [
        { index: 0, delta: { role: "assistant", tool_calls: [tool] }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "tool_calls" },
      ]) res.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [choice] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const profile = path.join(dir, "profile");
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
      permission: { bash: { "*": "ask" } },
      providers: { probe: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${port}/v1`,
        auth: { type: "none" }, model_metadata: { probe: { context_window: 32768, max_output_tokens: 2048, supports_tool_use: true } } } },
      models: { probe: "probe" },
    }), { mode: 0o600 });
    cleanup = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); };
    const result = await promisify(execFile)("fx", ["ask", "--provider", "probe", "--model", "probe",
      "--permission-mode", "auto", "--json", "--no-save", "--", "Run printf FX_AUTO_APPROVAL_PROBE with shell."], {
      cwd: dir, env: { ...process.env, FX_HOME: profile, FX_AUTO_UPGRADE: "0" }, timeout: 10000,
    }).then(() => { throw new Error("Expected permission failure"); }, error => error);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 1, error: "NonInteractivePermissionRequired" });
    expect(result.stderr).toContain("permission required by configured rule");
  });

  it("product executor argv (full-access) runs a shell call despite an explicit ask rule", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-full-access-"));
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (choice: object) => res.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [choice] })}\n\n`);
      if (requests++ === 0) {
        const tool = { index: 0, id: "probe", type: "function", function: {
          name: "shell", arguments: JSON.stringify({ action: "run", command: "touch FX_FULL_ACCESS_MARKER" }),
        } };
        chunk({ index: 0, delta: { role: "assistant", tool_calls: [tool] }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else {
        chunk({ index: 0, delta: { role: "assistant", content: "FX_FULL_ACCESS_DONE" }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const profile = path.join(dir, "profile");
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
      permission: { bash: { "*": "ask" } },
      providers: { probe: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${port}/v1`,
        auth: { type: "none" }, model_metadata: { probe: { context_window: 32768, max_output_tokens: 2048, supports_tool_use: true } } } },
      models: { probe: "probe" },
    }), { mode: 0o600 });
    cleanup = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); };
    const config = buildFxAskSpawnConfig("fx", "Create the marker file with shell.");
    const [subcommand, ...rest] = config.args;
    const result = await promisify(execFile)(config.command, [subcommand, "--provider", "probe", "--model", "probe", "--no-save", ...rest], {
      cwd: dir, env: { ...process.env, ...config.env, FX_HOME: profile }, timeout: 20000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 0, final_output: "FX_FULL_ACCESS_DONE" });
    expect(existsSync(path.join(dir, "FX_FULL_ACCESS_MARKER"))).toBe(true);
  });

  it("captures output, stops a run, and persists a cron-triggered report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx8-product-"));
    const storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
    const pm = new ProcessManager(storage);
    const scheduler = new SchedulerService(storage, pm);
    cleanup = async () => { scheduler.shutdown(); pm.shutdown(); await storage.close(); rmSync(dir, { recursive: true, force: true }); };
    await storage.projects.create({ id: "p", name: "probe", path: dir });
    const executor: Executor = { id: "fx", project_id: "p", workspace_id: "", name: "fx",
      command: "Reply exactly FX_PRODUCT_OK without tools.", executor_type: "prompt", prompt_provider: "fx",
      cwd: null, pty: false, position: 0, disabled_targets: [], created_at: new Date().toISOString() };
    const id = await pm.start(executor, dir, true);
    const logs: LogMessage[] = [];
    pm.subscribe(id, msg => logs.push(msg));
    await vi.waitFor(() => expect(logs.some(m => m.type === "finished")).toBe(true), { timeout: 60000 });
    expect(logs).toContainEqual({ type: "finished", exitCode: 0, finalResult: "FX_PRODUCT_OK" });
    expect(logs.some(m => m.type === "stdout" && m.data.includes("FX_PRODUCT_OK"))).toBe(true);
    const stopped = await pm.start({ ...executor, command: "Run sleep 30 using the shell tool, then reply DONE." }, dir, true);
    const stopLogs: LogMessage[] = [];
    pm.subscribe(stopped, msg => stopLogs.push(msg));
    await vi.waitFor(() => expect(stopLogs.some(m => m.type === "stderr" && /Running|sleep 30/.test(m.data))).toBe(true), { timeout: 60000 });
    expect(await pm.stop(stopped)).toBe(true);
    await vi.waitFor(() => expect(stopLogs.some(m => m.type === "finished" && m.exitCode !== 0)).toBe(true));
    expect(pm.isRunning(stopped)).toBe(false);
    expect(pm.getRunningProcessIds()).not.toContain(stopped);
    await storage.scheduledTasks.create({ id: "s", project_id: "p", name: "fx cron",
      cron_expr: "*/2 * * * * *", timezone: "UTC", run_type: "prompt", prompt_provider: "fx",
      content: "Reply with FX_CRON_OK. Do not use tools.", cwd_mode: "directory", directory: dir, timeout_seconds: 60 });
    await scheduler.start();
    await vi.waitFor(async () => {
      const runs = await storage.scheduledTaskRuns.getByScheduleId("s");
      const completed = runs.find(r => r.status === "completed");
      expect(completed).toBeDefined();
      const detail = await storage.scheduledTaskRuns.getById(completed!.id);
      expect(detail?.exit_code).toBe(0);
      expect(detail?.report).toContain("FX_CRON_OK");
    }, { timeout: 60000, interval: 200 });
  }, 130000);
});
