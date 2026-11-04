import crypto from "crypto";
import { sql, type Kysely, type RawBuilder } from "kysely";
import type { DB } from "../schema.js";
import type { Storage, LlmUsageGroupKey, LlmUsageSummaryRow } from "../types.js";

// created_at is an ISO-8601 UTC string, so its first 10 chars are the UTC day
// and lexical comparison is chronological.
const GROUP_COLUMNS: Record<LlmUsageGroupKey, RawBuilder<string>> = {
  day: sql<string>`substr(created_at, 1, 10)`,
  user: sql<string>`user_id`,
  feature: sql<string>`feature`,
  model: sql<string>`model`,
  key_source: sql<string>`key_source`,
};

export const createLlmUsageRepo = (
  kdb: Kysely<DB>,
): Pick<Storage, "llmUsage"> => ({
  llmUsage: {
    insert: async (entry) => {
      await kdb
        .insertInto("llm_usage")
        .values({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...entry })
        .execute();
    },

    costSince: async (userId, since, keySource) => {
      let query = kdb
        .selectFrom("llm_usage")
        .select(sql<number | null>`sum(cost_nanousd)`.as("cost"))
        .where("user_id", "=", userId)
        .where("created_at", ">=", since.toISOString());
      if (keySource) query = query.where("key_source", "=", keySource);
      const row = await query.executeTakeFirst();
      return Number(row?.cost ?? 0);
    },

    unpricedTokensSince: async (userId, since, keySource) => {
      let query = kdb
        .selectFrom("llm_usage")
        .select(sql<number | null>`sum(input_tokens + output_tokens)`.as("tokens"))
        .where("user_id", "=", userId)
        .where("created_at", ">=", since.toISOString())
        .where("cost_nanousd", "is", null);
      if (keySource) query = query.where("key_source", "=", keySource);
      const row = await query.executeTakeFirst();
      return Number(row?.tokens ?? 0);
    },

    summarize: async (from, to, groupBy) => {
      const keys = [...new Set(groupBy)];
      let query = kdb
        .selectFrom("llm_usage")
        .select([
          sql<number>`count(*)`.as("calls"),
          sql<number>`coalesce(sum(input_tokens), 0)`.as("input_tokens"),
          sql<number>`coalesce(sum(cached_input_tokens), 0)`.as("cached_input_tokens"),
          sql<number>`coalesce(sum(output_tokens), 0)`.as("output_tokens"),
          sql<number>`coalesce(sum(reasoning_tokens), 0)`.as("reasoning_tokens"),
          sql<number>`coalesce(sum(cost_nanousd), 0)`.as("cost_nanousd"),
          sql<number>`sum(case when cost_nanousd is null then 1 else 0 end)`.as("unknown_cost_calls"),
        ])
        .where("created_at", ">=", from.toISOString())
        .where("created_at", "<", to.toISOString());
      for (const key of keys) {
        query = query.select(GROUP_COLUMNS[key].as(key)).groupBy(GROUP_COLUMNS[key]);
      }
      for (const key of keys) query = query.orderBy(GROUP_COLUMNS[key]);
      const rows = (await query.execute()) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const out: LlmUsageSummaryRow = {
          calls: Number(row.calls),
          input_tokens: Number(row.input_tokens),
          cached_input_tokens: Number(row.cached_input_tokens),
          output_tokens: Number(row.output_tokens),
          reasoning_tokens: Number(row.reasoning_tokens),
          cost_nanousd: Number(row.cost_nanousd),
          unknown_cost_calls: Number(row.unknown_cost_calls ?? 0),
        };
        for (const key of keys) out[key] = String(row[key]);
        return out;
      });
    },
  },
});
