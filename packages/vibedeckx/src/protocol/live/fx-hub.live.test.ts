import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FxProvider } from "../../providers/fx-provider.js";
import type { ParsedAgentEvent } from "../../agent-provider.js";

/** Explicit opt-in: real authenticated hub, real fx; proposals create no tasks. */
it.skipIf(!process.env.FX_HUB_SMOKE_URL && !process.env.FX_LOCAL_HUB_SMOKE)("calls both real hub MCPs through FxProvider", async () => {
  let base = process.env.FX_HUB_SMOKE_URL!;
  let crossToken = process.env.VIBEDECKX_CROSS_REMOTE_MCP_TOKEN!;
  let sessionToken = process.env.VIBEDECKX_SESSION_MCP_TOKEN!;
  let cleanup = async () => {};
  if (process.env.FX_LOCAL_HUB_SMOKE) {
    const { createServer } = await import("../../server.js");
    const { createSqliteStorage } = await import("../../storage/sqlite.js");
    const { getCrossRemoteSecret, signCrossRemoteToken } = await import("../../utils/cross-remote-token.js");
    const { mintSessionToolsMcpConfig } = await import("../../session-tools-mcp.js");
    const dir = mkdtempSync(join(tmpdir(), "fx-real-hub-"));
    const storage = await createSqliteStorage(join(dir, "db.sqlite"));
    const server = await createServer({ storage, uiRoot: null });
    await storage.projects.create({ id: "smoke-project", name: "Smoke", path: dir });
    const started = await server.startLocal(0);
    base = started.url;
    started.instance.agentSessionManager.getSessionProcessAlive = id => id === "smoke";
    crossToken = signCrossRemoteToken(await getCrossRemoteSecret(storage), { userId: "smoke-user", sessionId: "smoke", sourceRemoteServerId: null }, Date.now());
    sessionToken = (await mintSessionToolsMcpConfig({ storage }, { sessionId: "smoke", projectId: "smoke-project", userId: null, baseUrl: base }))!.token;
    cleanup = async () => { await server.close(); await storage.close(); rmSync(dir, { recursive: true, force: true }); };
  }
  const crossRemoteMcp = { url: `${base}/api/cross-remote-mcp`, token: crossToken };
  const sessionToolsMcp = { url: `${base}/api/session-mcp`, token: sessionToken };
  expect(crossRemoteMcp.token).toBeTruthy(); expect(sessionToolsMcp.token).toBeTruthy();
  const cwd = mkdtempSync(join(tmpdir(), "fx-hub-smoke-"));
  const provider = new FxProvider(); provider.onSessionCreated("smoke");
  const config = provider.buildSpawnConfig(cwd, "edit", crossRemoteMcp, process.env.FX_SMOKE_MODEL ?? "openai/gpt-5.4-mini", sessionToolsMcp);
  const child = spawn(config.command, config.args, { cwd, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const events: ParsedAgentEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", () => reject(new Error("fx exited before completion")));
    lines.on("line", line => {
      try {
        for (const e of provider.parseStdoutLine(line, "smoke")) {
          events.push(e);
          if (e.type === "stdin_write") child.stdin.write(e.content);
          if (e.type === "error") reject(new Error(e.message));
          if (e.type === "result") e.subtype === "success" ? resolve() : reject(new Error(e.error ?? e.subtype));
        }
      } catch (e) { reject(e); }
    });
  });
  const timer = setTimeout(() => child.kill(), 100_000);
  try {
    child.stdin.write(provider.getInitializationMessages("smoke", { cwd, crossRemoteMcp, sessionToolsMcp })!);
    child.stdin.write(provider.formatUserInput('This is an explicitly authorized integration smoke test. Use toolbox search to discover the injected MCP tools first, then call mcp_cross-remote_list_accessible_remotes once. Then call mcp_vibedeckx_propose_task with tasks=[{"title":"FX smoke test — do not accept","description":"Temporary MCP verification proposal only; no work requested."}]. Toolbox discovery is permitted. Do not call any unrelated tools, create actual tasks, or change files. Report both tool results.', "smoke"));
    await completion;
    console.log(events.filter(e => ["tool_use", "tool_result"].includes(e.type)));
    for (const tool of ["mcp__cross-remote__list_accessible_remotes", "mcp__vibedeckx__propose_task"]) {
      expect(events.some(e => e.type === "tool_use" && e.tool === tool)).toBe(true);
      const result = events.find(e => e.type === "tool_result" && e.tool === tool);
      expect(result).toBeDefined();
      if (result?.type === "tool_result") {
        expect(result.output).not.toContain('"isError":true');
        console.log(tool, result.output);
      }
    }
  } finally {
    await cleanup();
    clearTimeout(timer); lines.close(); child.kill(); provider.onSessionDestroyed("smoke"); rmSync(cwd, { recursive: true, force: true });
  }
});
