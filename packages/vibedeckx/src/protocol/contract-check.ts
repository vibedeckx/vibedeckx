/**
 * Strict contract validation used by offline fixture tests and (phase 2)
 * the live compat probes. Failure semantics per the design spec:
 *   - a field we consume that is missing or type-changed -> ok: false (FAIL)
 *   - upstream-added fields we don't consume -> unknownKeys (WARN, never fails)
 */
import { z } from "zod";
import type { ContractItem } from "./contracts.js";

export interface ContractReport {
  ok: boolean;
  /** Human-readable schema violations: "<contract-id> <path>: <message>". */
  issues: string[];
  /** Top-level keys present in the value but absent from the schema shape. */
  unknownKeys: string[];
}

export function checkContract(item: ContractItem, value: unknown): ContractReport {
  const result = item.schema.safeParse(value);
  const issues = result.success
    ? []
    : result.error.issues.map((i) => `${item.id} ${i.path.join(".") || "(root)"}: ${i.message}`);

  const unknownKeys: string[] = [];
  const shape = shapeOf(item.schema);
  if (shape && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) unknownKeys.push(key);
    }
  }

  return { ok: result.success, issues, unknownKeys };
}

/** Extract the top-level shape of an object schema; null for unions etc. */
function shapeOf(schema: z.ZodType): Record<string, unknown> | null {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ?? null;
}
