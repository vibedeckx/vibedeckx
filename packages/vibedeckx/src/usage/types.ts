import type { LlmKeySource, LlmUsageEntry, Storage } from "../storage/types.js";

/**
 * Hub-side features that call a model. Every model the chat registry hands
 * out is tagged with one, so usage can be attributed (and limited) per feature.
 */
export type LlmFeature =
  | "chat-session"
  | "chat-summary"
  | "project-chat"
  | "conversation-title"
  | "review-intent-brief"
  | "task-suggest"
  | "translate";

/** Who is calling which model, and whose key pays — fixed when the model is resolved. */
export interface LlmCallMeta {
  userId: string;
  feature: LlmFeature;
  provider: string;
  model: string;
  /** 'platform' = the server's env key (the operator pays); 'byok' = the user's own key. */
  keySource: LlmKeySource;
}

export interface UsageCheckContext extends LlmCallMeta {
  /** Read side of the usage ledger, for spend-based policies. */
  ledger: Pick<Storage["llmUsage"], "costSince" | "unpricedTokensSince">;
  now: Date;
}

export type UsageDecision =
  | { allow: true }
  | {
      allow: false;
      /** Stable machine-readable reason, e.g. "rate_limit" / "daily_cost_limit". */
      reason: string;
      /** User-facing explanation. */
      message: string;
      retryAfterMs?: number;
    };

/**
 * A usage policy decides whether a model call may proceed. The metering
 * framework knows exactly one policy; how many guards there are and in which
 * order is the policy's business (see `composePolicies`). Implementations are
 * swappable via `setUsagePolicy` — the SaaS build can install its own.
 */
export interface UsagePolicy {
  readonly name: string;
  check(ctx: UsageCheckContext): UsageDecision | Promise<UsageDecision>;
  /** Called after a call's usage is recorded, for policies that keep state. */
  onUsage?(entry: LlmUsageEntry): void | Promise<void>;
}

/** Thrown from the model when a policy denies the call; its message is user-facing. */
export class UsageLimitError extends Error {
  readonly code = "usage_limit";

  constructor(
    readonly reason: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "UsageLimitError";
  }
}

export function isUsageLimitError(error: unknown): error is UsageLimitError {
  return error instanceof UsageLimitError;
}
