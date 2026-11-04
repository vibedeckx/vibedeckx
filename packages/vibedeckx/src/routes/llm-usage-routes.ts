import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { LlmUsageGroupKey } from "../storage/types.js";
import "../server-types.js";

// Operator-only view of the hub-side LLM usage ledger (llm_usage): cost
// estimation and per-user / per-feature breakdowns. Cross-tenant, so it sits
// behind the same operator gate as the fleet stats in worker-stats-routes.ts.

// Empty means unset, matching server.ts's gate — see the note there.
const API_KEY = process.env.VIBEDECKX_API_KEY || undefined;

const GROUP_KEYS: readonly LlmUsageGroupKey[] = ["day", "user", "feature", "model", "key_source"];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseGroupBy(raw: string | undefined): LlmUsageGroupKey[] | null {
  if (!raw) return [];
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  return keys.every((k): k is LlmUsageGroupKey => (GROUP_KEYS as readonly string[]).includes(k)) ? keys : null;
}

function parseDate(raw: string | undefined, fallback: Date): Date | null {
  if (!raw) return fallback;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

const routes: FastifyPluginAsync = async (fastify) => {
  const isOperatorRequest = (request: { headers: Record<string, unknown> }) => {
    const apiKeyHeader = request.headers["x-vibedeckx-api-key"];
    return (API_KEY !== undefined && apiKeyHeader !== undefined)
      || (!fastify.authEnabled && API_KEY === undefined);
  };

  // GET /api/admin/llm-usage?from=&to=&groupBy=day,user,feature,model,key_source
  // from/to are ISO dates or timestamps, [from, to); default = the last 30 days.
  fastify.get<{ Querystring: { from?: string; to?: string; groupBy?: string } }>(
    "/api/admin/llm-usage",
    async (request, reply) => {
      if (!isOperatorRequest(request)) return reply.code(404).send({ error: "Not found" });

      const now = new Date();
      const to = parseDate(request.query.to, now);
      const from = parseDate(request.query.from, new Date(now.getTime() - 30 * DAY_MS));
      if (!from || !to) return reply.code(400).send({ error: "from/to must be ISO dates" });
      const groupBy = parseGroupBy(request.query.groupBy);
      if (!groupBy) {
        return reply.code(400).send({ error: `groupBy must be a comma list of: ${GROUP_KEYS.join(", ")}` });
      }

      const rows = await fastify.storage.llmUsage.summarize(from, to, groupBy);
      return reply.send({
        from: from.toISOString(),
        to: to.toISOString(),
        group_by: groupBy,
        rows: rows.map(({ cost_nanousd, ...row }) => ({ ...row, cost_usd: cost_nanousd / 1e9 })),
      });
    },
  );
};

export default fp(routes, { name: "llm-usage-routes" });
