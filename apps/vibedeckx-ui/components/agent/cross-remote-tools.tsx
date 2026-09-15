"use client";

import { Cloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BashToolResultUI } from "./bash-tools";
import { useRemoteServerName } from "@/hooks/use-remote-server-names";

/** The MCP server name the hub injects the cross-remote gateway under. */
const SERVER_NAME = "cross-remote";

/**
 * Tools of that server, by their bare names. Claude Code reports them prefixed
 * with `mcp__cross-remote__`; Codex reports the bare name with the server in a
 * field the provider now folds into the name — but entries recorded before that
 * are stored bare, so the bare spellings stay matchable. These names are
 * distinctive enough that matching them unqualified is not a real collision
 * risk, and the worst case is a nicer card for someone else's tool.
 */
const TOOL_LABELS: Record<string, string> = {
  remote_bash: "Run Command",
  remote_read_file: "Read File",
  remote_list_dir: "List Directory",
  remote_stat_path: "Stat Path",
  remote_process_list: "List Processes",
  list_accessible_remotes: "List Remotes",
  remote_mcp_open: "Open MCP Server",
  remote_mcp_list_tools: "List MCP Tools",
  remote_mcp_call: "Call MCP Tool",
  remote_mcp_ping: "Ping MCP Server",
  remote_mcp_close: "Close MCP Server",
};

const PREFIXES = [`mcp__${SERVER_NAME}__`, `${SERVER_NAME}__`, `${SERVER_NAME}.`, `${SERVER_NAME}/`];

/** The bare tool name when `tool` is one of the gateway's, null otherwise. */
export function crossRemoteToolName(tool: string): string | null {
  const name = tool.trim();
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) {
      const bare = name.slice(prefix.length);
      return bare in TOOL_LABELS ? bare : null;
    }
  }
  return name in TOOL_LABELS ? name : null;
}

export function isCrossRemoteTool(tool: string): boolean {
  return crossRemoteToolName(tool) !== null;
}

interface CrossRemoteInput {
  remoteId?: string;
  command?: string;
  cwd?: string;
  path?: string;
  timeoutSec?: number;
  tool?: string;
}

function parseInput(input: unknown): CrossRemoteInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") return null;
    const pick = (key: string) => (typeof obj[key] === "string" ? (obj[key] as string) : undefined);
    return {
      remoteId: pick("remoteId"),
      command: pick("command"),
      cwd: pick("cwd"),
      path: pick("path"),
      tool: pick("tool"),
      timeoutSec: typeof obj.timeoutSec === "number" ? obj.timeoutSec : undefined,
    };
  } catch {
    return null;
  }
}

function RawJson({ value, limit }: { value: unknown; limit: number }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
      style={{ fontSize: "var(--conv-font-size, 12px)" }}
    >
      {text.length > limit ? text.substring(0, limit) + "..." : text}
    </pre>
  );
}

function InputBody({ bare, parsed, raw }: { bare: string; parsed: CrossRemoteInput | null; raw: unknown }) {
  if (!parsed) return <RawJson value={raw} limit={500} />;

  if (bare === "remote_bash" && parsed.command) {
    return (
      <div className="flex items-start gap-2">
        <pre
          className="flex-1 min-w-0 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          <span className="text-muted-foreground select-none">$ </span>
          {parsed.command}
        </pre>
        <div className="flex flex-col gap-1 shrink-0 mt-1">
          {parsed.cwd && (
            <Badge variant="outline" className="text-xs max-w-40 truncate" title={parsed.cwd}>
              {parsed.cwd}
            </Badge>
          )}
          {parsed.timeoutSec != null && (
            <Badge variant="outline" className="text-xs">
              {parsed.timeoutSec}s
            </Badge>
          )}
        </div>
      </div>
    );
  }

  if (parsed.path) {
    return (
      <p
        className="font-mono text-muted-foreground break-all"
        style={{ fontSize: "var(--conv-font-size, 12px)" }}
      >
        {parsed.path}
      </p>
    );
  }

  // Nothing but the target to show (process list, remote listing).
  if (bare === "remote_process_list" || bare === "list_accessible_remotes") return null;

  return <RawJson value={raw} limit={500} />;
}

/**
 * A cross-remote call, headed by the machine it runs on. The whole point of the
 * card is that `remoteId` is a uuid: without the name, a transcript gives a
 * reader no way to tell which machine the agent touched — or that it left this
 * one at all, which is why the icon and colour differ from local Bash.
 */
export function CrossRemoteToolUse({ tool, input }: { tool: string; input: unknown }) {
  const bare = crossRemoteToolName(tool) ?? tool;
  const parsed = parseInput(input);
  // MCP-session tools carry an opaque handle instead of a remote id (the hub
  // resolves the target from it), so they simply go unnamed.
  const { label } = useRemoteServerName(parsed?.remoteId);

  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
        <Cloud className="w-4 h-4 text-violet-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium text-violet-500 mb-1 break-words">
          {TOOL_LABELS[bare] ?? bare}
          {label && (
            <>
              <span className="font-normal text-muted-foreground"> on </span>
              <span className="text-foreground" title={parsed?.remoteId}>
                {label}
              </span>
            </>
          )}
        </p>
        <InputBody bare={bare} parsed={parsed} raw={input} />
      </div>
    </div>
  );
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

function asExecResult(value: unknown): ExecResult | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.stdout !== "string" || typeof obj.stderr !== "string") return null;
  return {
    stdout: obj.stdout,
    stderr: obj.stderr,
    exitCode: typeof obj.exitCode === "number" ? obj.exitCode : null,
    timedOut: obj.timedOut === true,
    truncated: obj.truncated === true,
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The text of an MCP `CallToolResult`, or null when this isn't one. Codex
 * serializes the whole result object into the entry's output, so the worker's
 * JSON arrives one layer down; Claude Code hands back the text itself.
 */
function unwrapMcpContent(value: unknown): string | null {
  const content = (value as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block
        && typeof block === "object"
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text);
  return texts.length > 0 ? texts.join("\n") : null;
}

function PlainText({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground break-words whitespace-pre-wrap">{text}</p>;
}

/**
 * The gateway answers with the worker's JSON verbatim, so the payload is an
 * envelope wrapped around a JSON-escaped `stdout` — every newline a literal
 * `\n`. Unwrapping it is most of the value here.
 */
export function CrossRemoteToolResult({ output }: { output: string }) {
  const outer = parseJson(output);
  // Gateway errors ("Call to remote … failed: …") are plain text.
  if (!outer.ok) return <PlainText text={output} />;

  let parsed = outer.value;
  const inner = unwrapMcpContent(parsed);
  if (inner !== null) {
    const innerParsed = parseJson(inner);
    // An error the gateway phrased for the agent, wrapped but not JSON.
    if (!innerParsed.ok) return <PlainText text={inner} />;
    parsed = innerParsed.value;
  }

  const exec = asExecResult(parsed);
  if (exec) {
    const combined = [exec.stdout, exec.stderr].filter((part) => part.trim() !== "").join("\n");
    const failed = exec.exitCode !== null && exec.exitCode !== 0;
    return (
      <div className="space-y-1">
        {(failed || exec.timedOut || exec.truncated) && (
          <div className="flex flex-wrap gap-1">
            {exec.timedOut && (
              <Badge variant="destructive" className="text-xs">
                timed out
              </Badge>
            )}
            {failed && (
              <Badge variant="outline" className="text-xs">
                exit {exec.exitCode}
              </Badge>
            )}
            {exec.truncated && (
              <Badge variant="outline" className="text-xs">
                truncated
              </Badge>
            )}
          </div>
        )}
        <BashToolResultUI output={combined} />
      </div>
    );
  }

  const content = (parsed as { content?: unknown } | null)?.content;
  if (typeof content === "string") return <BashToolResultUI output={content} />;

  return <RawJson value={parsed} limit={1000} />;
}
