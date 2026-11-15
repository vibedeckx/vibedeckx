import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { checkContract } from "../contract-check.js";
import { FX_CONTRACTS, FxEnvelopeSchema, FxInitializeResultSchema, FxNewResultSchema, FxPromptResultSchema, FxUpdateParamsSchema, FxPermissionParamsSchema } from "./schema.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
describe("fx recorded offline contracts", () => {
  it("registers unique contracts and consumers", () => {
    expect(new Set(FX_CONTRACTS.map(c => c.id)).size).toBe(FX_CONTRACTS.length);
    for (const c of FX_CONTRACTS) expect(c.consumers.length).toBeGreaterThan(0);
  });
  for (const file of readdirSync(fixtures).filter(f => f.endsWith(".jsonl") && f !== "http-mcp-server.jsonl")) {
    it(file, () => {
      const requests = new Map<string | number, string>();
      for (const line of readFileSync(new URL(file, fixtures), "utf8").trim().split("\n")) {
        const row = JSON.parse(line);
        if (row.direction === "stderr") continue;
        const msg = row.message;
        expect(FxEnvelopeSchema.safeParse(msg).success, line).toBe(true);
        if (row.direction === "stdin") {
          if (msg.method && msg.id != null) requests.set(msg.id, msg.method);
          continue;
        }
        const method = msg.method ?? requests.get(msg.id);
        if (msg.error) continue;
        const schema = msg.method === "session/update" ? FxUpdateParamsSchema
          : msg.method === "session/request_permission" ? FxPermissionParamsSchema
          : method === "initialize" ? FxInitializeResultSchema
          : method === "session/new" ? FxNewResultSchema
          : method === "session/prompt" ? FxPromptResultSchema : undefined;
        if (!schema) continue;
        const contract = FX_CONTRACTS.find(c => c.schema === schema)!;
        const report = checkContract(contract, msg.method ? msg.params : msg.result);
        expect(report.ok, `${file}: ${method}: ${report.issues.join("; ")}`).toBe(true);
      }
    });
  }
});
