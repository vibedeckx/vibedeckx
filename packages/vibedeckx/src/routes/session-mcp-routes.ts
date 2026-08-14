import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  getSessionToolsSecret,
  verifySessionToolsToken,
  type SessionToolsTokenPayload,
} from "../utils/session-tools-token.js";
import {
  PROPOSE_SCHEDULE_ACK,
  PROPOSE_SCHEDULE_DESCRIPTION,
  PROPOSE_SCHEDULE_INPUT_SCHEMA,
  PROPOSE_SCHEDULE_TOOL,
  SESSION_TOOLS_MCP_PATH,
  parseProposeScheduleArgs,
} from "../session-tools-mcp.js";
import { validateCron } from "../scheduler.js";
import "../server-types.js";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const TOOLS = [
  {
    name: PROPOSE_SCHEDULE_TOOL,
    description: PROPOSE_SCHEDULE_DESCRIPTION,
    inputSchema: PROPOSE_SCHEDULE_INPUT_SCHEMA,
  },
];

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * The agent-facing tool endpoint. Fire-and-forget by design: propose_schedule
 * validates and returns, leaving the tool_use message in the conversation as
 * the only artifact. The user confirms it in the UI, which calls the hub's
 * existing create-schedule REST — so nothing here ever touches storage or the
 * reverse-connect tunnel. See docs/schedule-proposal-tool-design.md §3.
 */
const routes: FastifyPluginAsync = async (fastify) => {
  // Memoized lazily for the same reason as the cross-remote gateway: the secret
  // is bootstrapped once and never rotates, and reading it at registration time
  // would miss secrets created after the app is built (tests).
  let cachedSecret: Promise<string> | undefined;
  const getSecret = (): Promise<string> => {
    if (!cachedSecret) cachedSecret = getSessionToolsSecret(fastify.storage);
    return cachedSecret;
  };

  const authenticate = async (request: FastifyRequest): Promise<SessionToolsTokenPayload | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    const secret = await getSecret();
    const payload = verifySessionToolsToken(secret, header.slice("Bearer ".length), Date.now());
    if (!payload) return null;
    // The token is only ever presented by the process this server spawned, so a
    // live local session is the whole authorization story. A token outliving its
    // session authorizes nothing.
    if (!fastify.agentSessionManager.getSessionProcessAlive(payload.sessionId)) return null;
    return payload;
  };

  const callTool = (toolName: string, args: Record<string, unknown>) => {
    if (toolName !== PROPOSE_SCHEDULE_TOOL) return textResult(`Unknown tool: ${toolName}`, true);

    const parsed = parseProposeScheduleArgs(args);
    if (!parsed.ok) return textResult(parsed.error, true);

    // Validate here rather than only at confirm time: a bad cron caught now is
    // something the agent can fix in the same turn, instead of a card the user
    // cannot accept.
    const cronError = validateCron(parsed.value.cron_expr, parsed.value.timezone);
    if (cronError) return textResult(`Invalid cron expression: ${cronError}`, true);

    return textResult(PROPOSE_SCHEDULE_ACK);
  };

  fastify.post(SESSION_TOOLS_MCP_PATH, async (request, reply) => {
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
          serverInfo: { name: "vibedeckx-session-tools", version: "1.0.0" },
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
        return respond(callTool(name, rpc.params?.arguments ?? {}));
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

export default fp(routes, { name: "session-mcp-routes" });
