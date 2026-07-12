/**
 * A contract item ties a protocol schema to a stable ID and the code that
 * depends on it. Compat-test failures report the ID + consumers so a drift
 * report directly names the affected code.
 */
import type { z } from "zod";

export interface ContractItem {
  /** Stable ID, e.g. "CX-NOTIF-item_completed" or "CC-OUT-task_started". */
  id: string;
  schema: z.ZodType;
  /** Repo-relative pointers to the code that reads/writes this shape. */
  consumers: string[];
}
