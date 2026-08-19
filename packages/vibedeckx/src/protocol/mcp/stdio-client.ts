import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { mcpLine, parseMcpLine } from "./codec.js";

export interface McpServerSpec { command: string; args?: string[]; cwd?: string }
export interface McpTool { name: string; description?: string; inputSchema?: unknown }

export class McpClientError extends Error {}
export class McpTimeoutError extends McpClientError {}

export class McpStdioClient {
  private nextId = 1;
  private pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;
  private exited = false;
  private closePromise: Promise<void> | undefined;
  private stderr = "";
  private lineReader: readline.Interface;

  private constructor(private child: ChildProcessWithoutNullStreams) {
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4096);
    });
    child.stdin.on("error", (error) => this.rejectAll(new McpClientError(error.message)));
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.closed = true;
      this.lineReader.close();
      const detail = this.stderr.trim();
      this.rejectAll(new McpClientError(`MCP process exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
    });
    child.once("error", (error) => {
      this.exited = true;
      this.closed = true;
      this.lineReader.close();
      this.rejectAll(new McpClientError(error.message));
    });
  }

  static async connect(spec: McpServerSpec, timeoutMs = 20_000): Promise<{
    client: McpStdioClient;
    serverInfo: unknown;
  }> {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Give the MCP server its own process group so wrappers such as npx and
      // their grandchildren can all be terminated when the session closes.
      detached: true,
    });
    const client = new McpStdioClient(child);
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vibedeckx-remote-mcp-broker", version: "1.0.0" },
      }, timeoutMs) as { serverInfo?: unknown };
      client.notify("notifications/initialized", {});
      return { client, serverInfo: initialized?.serverInfo };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async listTools(timeoutMs = 20_000): Promise<McpTool[]> {
    const result = await this.request("tools/list", {}, timeoutMs) as { tools?: McpTool[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async ping(timeoutMs = 10_000): Promise<void> { await this.request("ping", {}, timeoutMs); }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeProcess();
    await this.closePromise;
  }

  get isClosed(): boolean { return this.closed; }

  private async closeProcess(): Promise<void> {
    this.closed = true;
    this.lineReader.close();
    this.rejectAll(new McpClientError("MCP client closed"));
    if (this.exited || this.child.pid === undefined) return;

    this.killTree("SIGTERM");
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        this.child.off("exit", finish);
        this.child.off("error", finish);
        resolve();
      };
      const killTimer = setTimeout(() => {
        this.killTree("SIGKILL");
        finish();
      }, 2_000);
      this.child.once("exit", finish);
      this.child.once("error", finish);
      if (this.exited) finish();
    });
  }

  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpClientError("MCP client is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "request timed out" });
        reject(new McpTimeoutError(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(mcpLine({ id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.closed) this.child.stdin.write(mcpLine({ method, params }));
  }

  private onLine(line: string): void {
    const message = parseMcpLine(line);
    if (message.kind === "request") {
      this.child.stdin.write(mcpLine({ id: message.id, error: { code: -32601, message: "Client method not supported" } }));
      return;
    }
    if (message.kind !== "response" && message.kind !== "error") return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // Timed-out response: discard by id; never desynchronizes later calls.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.kind === "error") pending.reject(new McpClientError(message.error.message ?? "MCP request failed"));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
