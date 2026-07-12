/**
 * Live compat probe runner. Spawns the real agent CLIs via the PRODUCTION
 * protocol-layer builders, drives scenario turns, validates every received
 * line against the phase-1 contracts, and records raw transcripts.
 *
 * Failure taxonomy (spec §7): spawn_error / auth_error are distinguished from
 * contract violations so a CI red is immediately attributable.
 */
import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { detectBinary } from "../shared/binary.js";
import { checkContract } from "../contract-check.js";
import { buildClaudeSessionSpawnConfig } from "../claude-code/cli.js";
import { parseClaudeLine, serializeUserInput } from "../claude-code/codec.js";
import {
  CLAUDE_BINARY_NAME,
  ClaudeAssistantMessageSchema,
  ClaudeContentBlockSchema,
  ClaudeResultMessageSchema,
  ClaudeSystemMessageSchema,
  ClaudeUserMessageSchema,
  type ClaudeOutputMessage,
} from "../claude-code/schema.js";
import { buildCodexAppServerSpawnConfig } from "../codex/cli.js";
import {
  buildCodexInput,
  parseCodexLine,
  threadStartParamsFor,
  type CodexIncoming,
} from "../codex/codec.js";
import {
  CODEX_BINARY_NAME,
  CODEX_CLIENT_METHODS,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  CommandApprovalParamsSchema,
  FileChangeApprovalParamsSchema,
  ItemCompletedParamsSchema,
  KnownThreadItemSchema,
  ThreadStartResultSchema,
  TokenUsageParamsSchema,
  TurnCompletedParamsSchema,
  UserInputParamsSchema,
} from "../codex/schema.js";

export type LiveOutcome = "ok" | "timeout" | "spawn_error" | "auth_error";

export interface ContractIssue {
  contractId: string;
  issues: string[];
  line: string;
}

export interface SpawnOverride {
  command: string;
  args: string[];
}

const AUTH_STDERR = /invalid api key|not logged in|please run \/login|log in|authenticat|unauthorized|credential|expired/i;
const RECORDINGS_DIR = new URL("./recordings/", import.meta.url).pathname;

// ---- shared line pump ----

interface Pump {
  proc: ChildProcess;
  rawLines: string[];
  stderr: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
  /** Resolves "matched" when a new line satisfies pred, "exit" on process end, "timeout" after ms. */
  waitFor(pred: (line: string) => boolean, ms: number): Promise<"matched" | "exit" | "timeout">;
  kill(): void;
}

function startPump(proc: ChildProcess): Pump {
  const rawLines: string[] = [];
  let stderrBuf = "";
  let stdoutBuf = "";
  let exited = false;
  let exitCode: number | null = null;
  type Waiter = { pred: (line: string) => boolean; resolve: (r: "matched" | "exit") => void };
  const waiters: Set<Waiter> = new Set();

  proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
  proc.stdout?.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      rawLines.push(line);
      for (const w of [...waiters]) {
        if (w.pred(line)) { waiters.delete(w); w.resolve("matched"); }
      }
    }
  });
  proc.on("close", (code) => {
    exited = true;
    exitCode = code;
    for (const w of [...waiters]) { waiters.delete(w); w.resolve("exit"); }
  });
  proc.on("error", () => {
    exited = true;
    for (const w of [...waiters]) { waiters.delete(w); w.resolve("exit"); }
  });

  return {
    proc,
    rawLines,
    stderr: () => stderrBuf,
    exited: () => exited,
    exitCode: () => exitCode,
    waitFor(pred, ms) {
      // Check already-received lines first
      if (rawLines.some(pred)) return Promise.resolve("matched");
      if (exited) return Promise.resolve("exit");
      return new Promise((resolve) => {
        const w: Waiter = { pred, resolve: (r) => { clearTimeout(t); resolve(r); } };
        const t = setTimeout(() => { waiters.delete(w); resolve("timeout"); }, ms);
        waiters.add(w);
      });
    },
    kill() {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      } catch { proc.kill("SIGTERM"); }
    },
  };
}

function classifyFailure(pump: Pump, sawProtocol: boolean, timedOut: boolean): LiveOutcome {
  if (timedOut) return "timeout";
  if (!sawProtocol) {
    return AUTH_STDERR.test(pump.stderr()) ? "auth_error" : "spawn_error";
  }
  return "ok";
}

function record(recordAs: string | undefined, rawLines: string[]): void {
  if (!recordAs) return;
  try {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    writeFileSync(path.join(RECORDINGS_DIR, `${recordAs}.jsonl`), rawLines.join("\n") + "\n");
  } catch { /* recordings are best-effort */ }
}

function freshCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-"));
}

// ---- claude driver ----

export interface ClaudeRunOptions {
  turns: string[];
  permissionMode?: "plan" | "edit";
  extraArgs?: string[];
  mcpConfigArg?: string;
  cwd?: string;
  timeoutMs?: number;
  recordAs?: string;
  spawnOverride?: SpawnOverride;
}

export interface ClaudeRunResult {
  outcome: LiveOutcome;
  messages: ClaudeOutputMessage[];
  rawLines: string[];
  contractFailures: ContractIssue[];
  unknownKeys: Record<string, string[]>;
  stderr: string;
  exitCode: number | null;
}

const CLAUDE_SCHEMA_BY_TYPE: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
  assistant: { id: "CC-OUT-assistant", schema: ClaudeAssistantMessageSchema },
  user: { id: "CC-OUT-user", schema: ClaudeUserMessageSchema },
  system: { id: "CC-OUT-system", schema: ClaudeSystemMessageSchema },
  result: { id: "CC-OUT-result", schema: ClaudeResultMessageSchema },
};

/**
 * Deviation from the brief: the top-level assistant/user schemas deliberately
 * leave each content block as `{ type: string }` (loose) so the message-shape
 * check alone tolerates upstream additions. That means a per-block regression
 * (e.g. `text` turning into a number) would silently pass the message-level
 * check. The block shapes are their own registered contract
 * (CC-OUT-content_blocks / ClaudeContentBlockSchema) — the runner must check
 * each block against it directly, or drift in a "field we consume" never
 * surfaces. Verified against the fake CLI's claude-drift mode.
 */
function checkClaudeContentBlocks(msg: ClaudeOutputMessage, line: string, contractFailures: ContractIssue[], unknownKeys: Record<string, string[]>): void {
  const type = (msg as { type?: string }).type;
  if (type !== "assistant" && type !== "user") return;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const report = checkContract({ id: "CC-OUT-content_blocks", schema: ClaudeContentBlockSchema, consumers: [] }, block);
    if (!report.ok) contractFailures.push({ contractId: "CC-OUT-content_blocks", issues: report.issues, line });
    if (report.unknownKeys.length) {
      (unknownKeys["CC-OUT-content_blocks"] ??= []).push(...report.unknownKeys.filter((k) => !(unknownKeys["CC-OUT-content_blocks"] ?? []).includes(k)));
    }
  }
}

export async function runClaudeSession(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const base = opts.spawnOverride
    ?? (() => {
      const c = buildClaudeSessionSpawnConfig(detectBinary(CLAUDE_BINARY_NAME), opts.permissionMode ?? "edit", opts.mcpConfigArg);
      return { command: c.command, args: c.args };
    })();
  const proc = spawn(base.command, [...base.args, ...(opts.extraArgs ?? [])], {
    cwd: opts.cwd ?? freshCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const pump = startPump(proc);

  const isResult = (line: string) => (parseClaudeLine(line) as { type?: string } | null)?.type === "result";
  let timedOut = false;

  for (const turn of opts.turns) {
    const already = pump.rawLines.filter(isResult).length;
    proc.stdin?.write(serializeUserInput(turn));
    const r = await pump.waitFor((l) => pump.rawLines.filter(isResult).length > already && isResult(l), timeoutMs);
    if (r === "timeout") { timedOut = true; break; }
    if (r === "exit") break;
  }
  pump.kill();
  // give the close event a beat so exitCode settles
  await new Promise((res) => setTimeout(res, 100));

  const messages: ClaudeOutputMessage[] = [];
  const contractFailures: ContractIssue[] = [];
  const unknownKeys: Record<string, string[]> = {};
  for (const line of pump.rawLines) {
    const msg = parseClaudeLine(line);
    if (!msg) continue; // non-JSON progress noise is legal
    messages.push(msg);
    const entry = CLAUDE_SCHEMA_BY_TYPE[(msg as { type: string }).type];
    if (!entry) {
      (unknownKeys["CC-unknown-message-type"] ??= []).push((msg as { type: string }).type);
      continue;
    }
    const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, msg);
    if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
    if (report.unknownKeys.length) {
      (unknownKeys[entry.id] ??= []).push(...report.unknownKeys.filter((k) => !(unknownKeys[entry.id] ?? []).includes(k)));
    }
    checkClaudeContentBlocks(msg, line, contractFailures, unknownKeys);
  }

  const sawProtocol = messages.length > 0;
  record(opts.recordAs, pump.rawLines);
  return {
    outcome: classifyFailure(pump, sawProtocol, timedOut),
    messages,
    rawLines: pump.rawLines,
    contractFailures,
    unknownKeys,
    stderr: pump.stderr(),
    exitCode: pump.exitCode(),
  };
}

// ---- codex driver ----

export interface CodexControl {
  cancelTurn: () => void;
  reply: (rawLine: string) => void;
}

export interface CodexRunOptions {
  turns: string[];
  threadStartParams?: Record<string, unknown>;
  onIncoming?: (incoming: CodexIncoming, ctl: CodexControl) => void;
  cwd?: string;
  timeoutMs?: number;
  recordAs?: string;
  spawnOverride?: SpawnOverride;
}

export interface CodexRunResult {
  outcome: LiveOutcome;
  incoming: CodexIncoming[];
  threadId: string | null;
  rawLines: string[];
  contractFailures: ContractIssue[];
  unknownKeys: Record<string, string[]>;
  stderr: string;
  exitCode: number | null;
}

function rpc(payload: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
}

// KnownThreadItemSchema is a zod discriminated union; derive the known-type
// list once at module load rather than re-walking `.options` per item.
// Verified against zod 4.3.6: each option is a ZodObject whose `type` field
// is a ZodLiteral exposing `.value` directly (matches the brief's primary
// access path, `.shape.type.value`) — no fallback needed.
const KNOWN_THREAD_ITEM_TYPES = new Set(
  KnownThreadItemSchema.options.map((o) => o.shape.type.value as string),
);

export async function runCodexAppServer(opts: CodexRunOptions): Promise<CodexRunResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const base = opts.spawnOverride
    ?? (() => {
      const c = buildCodexAppServerSpawnConfig(detectBinary(CODEX_BINARY_NAME));
      return { command: c.command, args: c.args };
    })();
  const proc = spawn(base.command, base.args, {
    cwd: opts.cwd ?? freshCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const pump = startPump(proc);

  let rpcId = 1;
  let currentTurnId: number | null = null;
  const ctl: CodexControl = {
    cancelTurn: () => {
      if (currentTurnId != null) {
        proc.stdin?.write(rpc({ method: CODEX_CLIENT_METHODS.cancelRequest, params: { id: currentTurnId } }));
      }
    },
    reply: (rawLine) => { proc.stdin?.write(rawLine); },
  };

  const incoming: CodexIncoming[] = [];
  const seen = new Set<string>();
  const drain = () => {
    for (const line of pump.rawLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      const inc = parseCodexLine(line);
      incoming.push(inc);
      opts.onIncoming?.(inc, ctl);
    }
  };
  // onIncoming must fire as lines arrive (CX-5 cancel, CX-8 approvals), so poll-drain on every wait.

  const initId = rpcId++;
  const threadStartId = rpcId++;
  proc.stdin?.write(rpc({ id: initId, method: CODEX_CLIENT_METHODS.initialize, params: { clientInfo: { name: "vibedeckx", version: "1.0.0" } } }));
  proc.stdin?.write(rpc({ id: threadStartId, method: CODEX_CLIENT_METHODS.threadStart, params: opts.threadStartParams ?? threadStartParamsFor("edit") }));

  const matchesResponse = (id: number) => (line: string) => {
    const inc = parseCodexLine(line);
    return (inc.kind === "response" || inc.kind === "error_response") && Number(inc.id) === id;
  };

  let timedOut = false;
  let threadId: string | null = null;

  const tsWait = await pump.waitFor(matchesResponse(threadStartId), timeoutMs);
  drain();
  if (tsWait === "timeout") timedOut = true;
  const tsResp = incoming.find((i) => i.kind === "response" && Number(i.id) === threadStartId);
  if (tsResp?.kind === "response") {
    const parsed = ThreadStartResultSchema.safeParse(tsResp.result);
    if (parsed.success) threadId = parsed.data.thread.id;
  }

  if (threadId && !timedOut) {
    for (const turn of opts.turns) {
      const turnId = rpcId++;
      currentTurnId = turnId;
      proc.stdin?.write(rpc({ id: turnId, method: CODEX_CLIENT_METHODS.turnStart, params: { threadId, input: buildCodexInput(turn) } }));
      // Wait for turn/completed OR an error response for this turn id; drain
      // continuously so onIncoming can cancel/approve mid-turn.
      const done = (line: string) => {
        drain();
        const inc = parseCodexLine(line);
        if (inc.kind === "notification" && inc.method === CODEX_NOTIFICATIONS.turnCompleted) return true;
        if (inc.kind === "error_response" && Number(inc.id) === turnId) return true;
        return false;
      };
      const r = await pump.waitFor(done, timeoutMs);
      drain();
      if (r === "timeout") { timedOut = true; break; }
      if (r === "exit") break;
    }
  }
  pump.kill();
  await new Promise((res) => setTimeout(res, 100));
  drain();

  // ---- contract validation ----
  const contractFailures: ContractIssue[] = [];
  const unknownKeys: Record<string, string[]> = {};
  const note = (id: string, keys: string[]) => {
    if (keys.length) (unknownKeys[id] ??= []).push(...keys.filter((k) => !(unknownKeys[id] ?? []).includes(k)));
  };
  const NOTIF_SCHEMAS: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
    [CODEX_NOTIFICATIONS.itemCompleted]: { id: "CX-NOTIF-item_completed", schema: ItemCompletedParamsSchema },
    [CODEX_NOTIFICATIONS.turnCompleted]: { id: "CX-NOTIF-turn_completed", schema: TurnCompletedParamsSchema },
    [CODEX_NOTIFICATIONS.tokenUsageUpdated]: { id: "CX-NOTIF-token_usage", schema: TokenUsageParamsSchema },
  };
  const REQ_SCHEMAS: Record<string, { id: string; schema: Parameters<typeof checkContract>[0]["schema"] }> = {
    [CODEX_SERVER_REQUESTS.commandApproval]: { id: "CX-REQ-command_approval", schema: CommandApprovalParamsSchema },
    [CODEX_SERVER_REQUESTS.fileChangeApproval]: { id: "CX-REQ-file_change_approval", schema: FileChangeApprovalParamsSchema },
    [CODEX_SERVER_REQUESTS.userInput]: { id: "CX-REQ-user_input", schema: UserInputParamsSchema },
  };
  for (let i = 0; i < incoming.length; i++) {
    const inc = incoming[i];
    const line = pump.rawLines[i] ?? "";
    if (inc.kind === "notification") {
      const entry = NOTIF_SCHEMAS[inc.method];
      if (!entry) { note("CX-unknown-notification", [inc.method]); continue; }
      const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, inc.params);
      if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
      note(entry.id, report.unknownKeys);
      if (inc.method === CODEX_NOTIFICATIONS.itemCompleted) {
        const item = (inc.params as { item?: { type?: string } })?.item;
        if (item?.type && KNOWN_THREAD_ITEM_TYPES.has(item.type)) {
          const ir = checkContract({ id: "CX-ITEM-known_types", schema: KnownThreadItemSchema, consumers: [] }, item);
          if (!ir.ok) contractFailures.push({ contractId: "CX-ITEM-known_types", issues: ir.issues, line });
        } else if (item?.type) {
          note("CX-unknown-item-type", [item.type]);
        }
      }
    } else if (inc.kind === "server_request") {
      const entry = REQ_SCHEMAS[inc.method];
      if (!entry) { note("CX-unknown-server-request", [inc.method]); continue; }
      const report = checkContract({ id: entry.id, schema: entry.schema, consumers: [] }, inc.params);
      if (!report.ok) contractFailures.push({ contractId: entry.id, issues: report.issues, line });
      note(entry.id, report.unknownKeys);
    }
  }

  const sawProtocol = incoming.some((i) => i.kind !== "ignored");
  record(opts.recordAs, pump.rawLines);
  return {
    outcome: classifyFailure(pump, sawProtocol, timedOut),
    incoming,
    threadId,
    rawLines: pump.rawLines,
    contractFailures,
    unknownKeys,
    stderr: pump.stderr(),
    exitCode: pump.exitCode(),
  };
}

// ---- one-shot driver (CC-8 `-p`, CX-7 `exec`) ----

export async function runOneShot(
  command: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const proc = spawn(command, { shell: true, cwd: opts?.cwd ?? freshCwd(), detached: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (proc.pid) process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ exitCode: code, stdout, stderr, timedOut: false });
    });
  });
}

// ---- gating helpers ----

export function claudeBinaryAvailable(): boolean {
  return detectBinary(CLAUDE_BINARY_NAME) !== null;
}
export function codexBinaryAvailable(): boolean {
  return detectBinary(CODEX_BINARY_NAME) !== null;
}
/** When set (CI), a would-be skip must fail instead — no silent green. */
export function compatRequired(): boolean {
  return process.env.VIBEDECKX_COMPAT_REQUIRED === "1";
}
