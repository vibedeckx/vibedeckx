import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { proxyToRemoteAuto, type ProxyResult } from "../utils/remote-proxy.js";
import { getCrossRemoteSecret, verifyCrossRemoteToken, type CrossRemoteTokenPayload } from "../utils/cross-remote-token.js";
import {
  CROSS_REMOTE_MCP_PATH,
  TOOL_TIERS,
  isSessionUsable,
  resolveTarget,
  listAccessibleRemotes,
  SessionConcurrencyGuard,
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

  const authenticate = async (request: FastifyRequest): Promise<CrossRemoteTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    const secret = await getCrossRemoteSecret(fastify.storage);
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

    const target = buildTargetCall(toolName, args);
    if (!target) return textResult(`Invalid arguments for ${toolName}`, true);

    const startedAt = Date.now();
    const remoteId = args.remoteId as string;

    const resolved = await resolveTarget(fastify as unknown as AccessDeps, payload, remoteId, tier);
    if (!resolved.ok) {
      const status: CrossRemoteAuditStatus = resolved.reason === "offline" ? "offline" : "denied";
      await audit(payload, remoteId, toolName, target.summary, status, null, startedAt);
      return textResult(resolved.reason === "offline" ? `Remote ${remoteId} is offline` : NOT_ACCESSIBLE, true);
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
        result = await proxyToRemoteAuto(
          resolved.server.id,
          resolved.server.url ?? "",
          resolved.server.api_key ?? "",
          "POST",
          target.path,
          target.body,
          { reverseConnectManager: fastify.reverseConnectManager },
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
        await audit(payload, remoteId, toolName, target.summary, "error", null, startedAt);
        const detail = (result.data as { error?: string } | undefined)?.error ?? result.errorCode ?? "unknown error";
        return textResult(`Call to remote ${remoteId} failed: ${detail}`, true);
      }

      const data = result.data as Record<string, unknown>;
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
      const status: CrossRemoteAuditStatus = data.timedOut === true ? "timeout" : "ok";
      await audit(payload, remoteId, toolName, target.summary, status, exitCode, startedAt);

      return textResult(JSON.stringify(data, null, 2));
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
