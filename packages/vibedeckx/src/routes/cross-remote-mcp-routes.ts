import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { proxyToRemoteAuto, type ProxyResult } from "../utils/remote-proxy.js";
import {
  getCrossRemoteSecret,
  signRemoteMcpHandle,
  verifyCrossRemoteToken,
  verifyRemoteMcpHandle,
  type CrossRemoteTokenPayload,
} from "../utils/cross-remote-token.js";
import {
  CROSS_REMOTE_MCP_PATH,
  TOOL_TIERS,
  isSessionUsable,
  resolveTarget,
  listAccessibleRemotes,
  SessionConcurrencyGuard,
  supportsRemoteMcpBroker,
  type AccessDeps,
} from "../cross-remote-access.js";
import type { CrossRemoteAuditStatus } from "../storage/types.js";
import "../server-types.js";

const PROTOCOL_VERSION = "2024-11-05";
const AUDIT_ARGS_MAX = 1024;
const NOT_ACCESSIBLE = "remote not found or not accessible";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const REMOTE_ID_PROP = {
  remoteId: { type: "string", description: "Target remote server id from list_accessible_remotes" },
} as const;

const TOOLS = [
  {
    name: "list_accessible_remotes",
    description: "List the remote machines this agent may access, with their access tier and online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "remote_read_file",
    description: "Read a file on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REMOTE_ID_PROP,
        path: { type: "string", description: "Absolute path of the file" },
        offset: { type: "number", description: "Byte offset to start from" },
        limit: { type: "number", description: "Maximum bytes to read (capped at 65536)" },
      },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_list_dir",
    description: "List a directory on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: { ...REMOTE_ID_PROP, path: { type: "string", description: "Absolute directory path" } },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_stat_path",
    description: "Stat a file or directory on a target remote machine. Requires 'read' access.",
    inputSchema: {
      type: "object",
      properties: { ...REMOTE_ID_PROP, path: { type: "string", description: "Absolute path" } },
      required: ["remoteId", "path"],
    },
  },
  {
    name: "remote_process_list",
    description: "List running processes on a target remote machine. Requires 'read' access.",
    inputSchema: { type: "object", properties: { ...REMOTE_ID_PROP }, required: ["remoteId"] },
  },
  {
    name: "remote_bash",
    description: "Run a shell command on a target remote machine. Requires 'exec' access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REMOTE_ID_PROP,
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Absolute working directory" },
        timeoutSec: { type: "number", description: "Timeout in seconds (default 60, max 300)" },
      },
      required: ["remoteId", "command"],
    },
  },
  {
    name: "remote_mcp_open",
    description: "Open a persistent stdio MCP server on an exec-tier remote. Returns a session-bound handle and tool schemas.",
    inputSchema: {
      type: "object",
      properties: {
        ...REMOTE_ID_PROP,
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string", description: "Optional absolute working directory" },
        serverLabel: { type: "string", description: "Short audit label; defaults to command" },
        timeoutSec: { type: "number", description: "Initialization timeout (max 300s)" },
      },
      required: ["remoteId", "command"],
    },
  },
  ...["list_tools", "ping", "close"].map((operation) => ({
    name: `remote_mcp_${operation}`,
    description: `${operation.replace("_", " ")} on a persistent remote MCP session.`,
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "Signed handle returned by remote_mcp_open" } },
      required: ["handle"],
    },
  })),
  {
    name: "remote_mcp_call",
    description: "Call a tool on a persistent remote MCP session.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
        timeoutSec: { type: "number", description: "Tool timeout (max 300s, default 120s)" },
      },
      required: ["handle", "tool"],
    },
  },
];

/** Maps a tool call onto the target-side route and body. Returns null when args are invalid. */
function buildTargetCall(
  toolName: string,
  args: Record<string, unknown>,
): { path: string; body: Record<string, unknown>; summary: string } | null {
  const remoteId = args.remoteId;
  if (typeof remoteId !== "string" || !remoteId) return null;

  switch (toolName) {
    case "remote_bash": {
      if (typeof args.command !== "string" || !args.command) return null;
      return {
        path: "/api/path/cross-remote/exec",
        body: { command: args.command, cwd: args.cwd, timeoutSec: args.timeoutSec },
        summary: args.command,
      };
    }
    case "remote_read_file": {
      if (typeof args.path !== "string" || !args.path) return null;
      return {
        path: "/api/path/cross-remote/read-file",
        body: { path: args.path, offset: args.offset, limit: args.limit },
        summary: args.path,
      };
    }
    case "remote_list_dir": {
      if (typeof args.path !== "string" || !args.path) return null;
      return { path: "/api/path/cross-remote/list-dir", body: { path: args.path }, summary: args.path };
    }
    case "remote_stat_path": {
      if (typeof args.path !== "string" || !args.path) return null;
      return { path: "/api/path/cross-remote/stat", body: { path: args.path }, summary: args.path };
    }
    case "remote_process_list":
      return { path: "/api/path/cross-remote/process-list", body: {}, summary: "ps" };
    case "remote_mcp_open": {
      if (typeof args.command !== "string" || !args.command) return null;
      const serverLabel = typeof args.serverLabel === "string" && args.serverLabel.trim() ? args.serverLabel : args.command;
      return {
        path: "/api/path/cross-remote/mcp/open",
        body: { command: args.command, args: args.args, cwd: args.cwd, timeoutSec: args.timeoutSec },
        summary: `server=${serverLabel} command=${args.command} argCount=${Array.isArray(args.args) ? args.args.length : 0}`,
      };
    }
    case "remote_mcp_list_tools":
      return {
        path: "/api/path/cross-remote/mcp/list-tools",
        body: { workerHandle: args.workerHandle },
        summary: `server=${String(args.serverLabel ?? "mcp")}`,
      };
    case "remote_mcp_ping":
      return {
        path: "/api/path/cross-remote/mcp/ping",
        body: { workerHandle: args.workerHandle },
        summary: `server=${String(args.serverLabel ?? "mcp")}`,
      };
    case "remote_mcp_close":
      return {
        path: "/api/path/cross-remote/mcp/close",
        body: { workerHandle: args.workerHandle },
        summary: `server=${String(args.serverLabel ?? "mcp")}`,
      };
    case "remote_mcp_call": {
      if (typeof args.tool !== "string" || !args.tool) return null;
      return {
        path: "/api/path/cross-remote/mcp/call",
        body: { workerHandle: args.workerHandle, tool: args.tool, arguments: args.arguments, timeoutSec: args.timeoutSec },
        summary: `server=${String(args.serverLabel ?? "mcp")} tool=${args.tool} argKeys=${
          args.arguments && typeof args.arguments === "object" ? Object.keys(args.arguments).sort().join(",") : ""
        }`,
      };
    }
    default:
      return null;
  }
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const routes: FastifyPluginAsync = async (fastify) => {
  const guard = new SessionConcurrencyGuard();

  // Memoized lazily: the secret is bootstrapped once via settings.getOrCreate and never
  // rotates at runtime, so there's no invalidation to wire up. Kept lazy (not read at
  // plugin-registration time) so tests that create the secret after the app is built
  // still see it on the first authenticated request.
  let cachedSecret: Promise<string> | undefined;
  const getSecret = (): Promise<string> => {
    if (!cachedSecret) cachedSecret = getCrossRemoteSecret(fastify.storage);
    return cachedSecret;
  };

  const authenticate = async (request: FastifyRequest): Promise<CrossRemoteTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    const secret = await getSecret();
    const payload = verifyCrossRemoteToken(secret, header.slice("Bearer ".length), Date.now());
    if (!payload) return null;
    if (!isSessionUsable(fastify as unknown as AccessDeps, payload.sessionId)) return null;
    return payload;
  };

  const audit = async (
    payload: CrossRemoteTokenPayload,
    targetRemoteId: string,
    toolName: string,
    summary: string,
    status: CrossRemoteAuditStatus,
    exitCode: number | null,
    startedAt: number,
  ) => {
    // Must never throw: the remote call has already executed by every call site (or was
    // deliberately not attempted), and the caller's response describes that outcome. An
    // audit-insert failure (e.g. a transient DB error) is a logging concern, not a reason
    // to turn a real result into a bare 500.
    try {
      await fastify.storage.crossRemoteAudit.insert({
        user_id: payload.userId,
        session_id: payload.sessionId,
        source_remote_id: payload.sourceRemoteServerId,
        target_remote_id: targetRemoteId,
        tool_name: toolName,
        args_summary: summary.slice(0, AUDIT_ARGS_MAX),
        exit_code: exitCode,
        duration_ms: Date.now() - startedAt,
        status,
      });
    } catch (err) {
      console.error("[CrossRemoteMCP] Failed to write audit row:", err);
    }
  };

  const callTool = async (payload: CrossRemoteTokenPayload, toolName: string, args: Record<string, unknown>) => {
    if (toolName === "list_accessible_remotes") {
      const remotes = await listAccessibleRemotes(fastify as unknown as AccessDeps, payload);
      return textResult(JSON.stringify(remotes, null, 2));
    }

    // Object.hasOwn guards against inherited members (toString, constructor, __proto__,
    // valueOf) that would otherwise read as truthy off TOOL_TIERS's prototype chain and
    // slip past a bare `if (!tier)` check.
    if (!Object.hasOwn(TOOL_TIERS, toolName)) return textResult(`Unknown tool: ${toolName}`, true);
    const tier = TOOL_TIERS[toolName];

    const isMcpTool = toolName.startsWith("remote_mcp_");
    let routedArgs = args;
    if (isMcpTool && toolName !== "remote_mcp_open") {
      if (typeof args.handle !== "string") return textResult(`Invalid arguments for ${toolName}`, true);
      const handle = verifyRemoteMcpHandle(await getSecret(), args.handle, Date.now());
      if (!handle || handle.userId !== payload.userId || handle.sessionId !== payload.sessionId) {
        return textResult("Invalid or expired remote MCP handle", true);
      }
      routedArgs = {
        ...args,
        remoteId: handle.remoteId,
        workerHandle: handle.workerHandle,
        serverLabel: handle.serverLabel,
      };
    }

    const target = buildTargetCall(toolName, routedArgs);
    if (!target) return textResult(`Invalid arguments for ${toolName}`, true);

    const startedAt = Date.now();
    const remoteId = routedArgs.remoteId as string;

    const resolved = await resolveTarget(fastify as unknown as AccessDeps, payload, remoteId, tier);
    if (!resolved.ok) {
      const status: CrossRemoteAuditStatus = resolved.reason === "offline" ? "offline" : "denied";
      await audit(payload, remoteId, toolName, target.summary, status, null, startedAt);
      return textResult(resolved.reason === "offline" ? `Remote ${remoteId} is offline` : NOT_ACCESSIBLE, true);
    }
    if (isMcpTool && !supportsRemoteMcpBroker(resolved.server)) {
      await audit(payload, remoteId, toolName, target.summary, "denied", null, startedAt);
      return textResult(`Remote ${remoteId} does not support the MCP broker; upgrade its worker.`, true);
    }

    if (!guard.acquire(payload.sessionId)) {
      return textResult("Too many concurrent cross-remote calls for this session; retry sequentially.", true);
    }

    try {
      // proxyToRemoteAuto cannot throw for outbound targets (proxyOnce catches internally
      // and returns { ok: false }), but for inbound (reverse-connect) targets it calls
      // rcm.sendHttpRequest, which can reject. Treat that rejection exactly like a
      // !result.ok response so it still gets audited and surfaced as a tool error instead
      // of escaping as a bare 500.
      let result: ProxyResult;
      try {
        const requestedSec = typeof routedArgs.timeoutSec === "number" ? routedArgs.timeoutSec : toolName === "remote_mcp_call" ? 120 : 20;
        const boundedTimeoutSec = Math.min(Math.max(requestedSec, 1), 300);
        // Opening performs initialize and tools/list sequentially on the worker;
        // budget for both so the hub never abandons a successfully opened session.
        const tunnelTimeoutMs = isMcpTool
          ? boundedTimeoutSec * 1000 * (toolName === "remote_mcp_open" ? 2 : 1) + 5_000
          : undefined;
        result = await proxyToRemoteAuto(
          resolved.server.id,
          "POST",
          target.path,
          target.body,
          { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: tunnelTimeoutMs },
        );
      } catch (err) {
        result = {
          ok: false,
          status: 0,
          data: { error: err instanceof Error ? err.message : String(err) },
          errorCode: "network_error",
        };
      }

      if (!result.ok) {
        const failedStatus: CrossRemoteAuditStatus =
          result.errorCode === "timeout" || result.status === 504 || (result.data as { timedOut?: boolean } | undefined)?.timedOut === true
            ? "timeout"
            : "error";
        await audit(payload, remoteId, toolName, target.summary, failedStatus, null, startedAt);
        const detail = (result.data as { error?: string } | undefined)?.error ?? result.errorCode ?? "unknown error";
        return textResult(`Call to remote ${remoteId} failed: ${detail}`, true);
      }

      let data = result.data as Record<string, unknown>;
      if (toolName === "remote_mcp_open") {
        const workerHandle = data.workerHandle;
        if (typeof workerHandle !== "string") return textResult("Remote returned an invalid MCP handle", true);
        const serverLabel = typeof routedArgs.serverLabel === "string" && routedArgs.serverLabel.trim()
          ? routedArgs.serverLabel
          : String(routedArgs.command);
        data = {
          ...data,
          workerHandle: undefined,
          handle: signRemoteMcpHandle(await getSecret(), {
            userId: payload.userId,
            sessionId: payload.sessionId,
            remoteId,
            workerHandle,
            serverLabel,
          }, Date.now()),
        };
      }
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
      const downstream = data.result as { isError?: boolean } | undefined;
      const status: CrossRemoteAuditStatus = data.timedOut === true ? "timeout" : downstream?.isError === true ? "error" : "ok";
      await audit(payload, remoteId, toolName, target.summary, status, exitCode, startedAt);

      return textResult(JSON.stringify(data, null, 2), downstream?.isError === true);
    } finally {
      guard.release(payload.sessionId);
    }
  };

  fastify.post(CROSS_REMOTE_MCP_PATH, async (request, reply) => {
    const payload = await authenticate(request);
    if (!payload) return reply.code(401).send({ error: "Unauthorized" });

    const rpc = request.body as JsonRpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return reply.code(400).send({ error: "Invalid JSON-RPC request" });
    }

    // Notifications carry no id and expect no body.
    if (rpc.id === undefined) return reply.code(202).send();

    const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id: rpc.id, result });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "vibedeckx-cross-remote", version: "1.0.0" },
        });
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: TOOLS });
      case "tools/call": {
        const name = rpc.params?.name;
        if (typeof name !== "string") {
          return reply.send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Missing tool name" } });
        }
        return respond(await callTool(payload, name, rpc.params?.arguments ?? {}));
      }
      default:
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        });
    }
  });
};

export default fp(routes, { name: "cross-remote-mcp-routes" });
