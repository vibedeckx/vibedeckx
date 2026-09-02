/**
 * Observability for the prepared-session lifecycle
 * (docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md §12).
 *
 * One grep-able line per lifecycle transition. Phase 0 events come from the
 * legacy create / first-send / discard paths; Phase 1 events come from
 * AgentSessionLifecycleService. Reading the log: a legacy `created` with no
 * matching `first_instruction_accepted` within a few minutes is exactly the
 * window the design removes, and after migration those pairs should be
 * replaced by `prepared` → `activated` (or a named `activation_*` outcome).
 * `discard` outcomes say whether the compensation landed; `discard_remote`
 * says whether it even reached the worker.
 */

/** Business origin of a session (design §5.3). Server-assigned, never client-controlled. */
export type SessionPurpose =
  | "interactive"
  | "interactive_upload"
  | "commander"
  | "project_chat"
  | "workflow_review";

export const SESSION_PURPOSES: readonly SessionPurpose[] = [
  "interactive", "interactive_upload", "commander", "project_chat", "workflow_review",
];

export function isSessionPurpose(value: unknown): value is SessionPurpose {
  return typeof value === "string" && (SESSION_PURPOSES as readonly string[]).includes(value);
}

export type SessionLifecycleEvent =
  | {
    event: "created";
    sessionId: string;
    projectId: string;
    branch: string | null;
    purpose: SessionPurpose;
    operationId?: string;
    /** True when an explicit id re-entered the manager via a stored row (exact-id recovery). */
    recovered: boolean;
  }
  | {
    event: "first_instruction_accepted";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    /** Wall time between `created` and the provider accepting the first send. */
    msSinceCreated: number;
  }
  | {
    event: "first_instruction_rejected";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    reason: "provider_rejected" | "send_threw" | "lease_lost";
  }
  | {
    event: "discard";
    sessionId: string;
    outcome:
      | "discarded"
      | "retained_in_flight"
      | "retained_has_entries"
      | "retained_deleting"
      | "retained_skip_db"
      | "retained_db_not_empty";
  }
  | {
    event: "discard_remote";
    localSessionId: string;
    remoteServerId: string;
    outcome: "ok" | "worker_404" | "network_error" | "timeout" | `http_${number}`;
  }
  | {
    /** Startup baseline: rows `restoreSessionsFromDb` skipped as zero-entry metadata. */
    event: "boot_zero_entry_rows";
    count: number;
  }
  // ---- Phase 1: AgentSessionLifecycleService ----
  | {
    /** A pending identity was persisted: no process, no projection. */
    event: "prepared";
    sessionId: string;
    projectId: string;
    branch: string | null;
    purpose: SessionPurpose;
    operationId: string;
  }
  | {
    /** pending → active; `recovered` when startup recovery promoted it from entry evidence. */
    event: "activated";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    attempt: number;
    recovered?: boolean;
  }
  | {
    /** pending → activation_uncertain: user entry durable, delivery unprovable. Never auto-resent. */
    event: "activation_uncertain";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    reason: "stdin_write_failed" | "send_threw" | "commit_lost" | "crash_during_activation" | "lease_lost_after_entry";
  }
  | {
    /** Activation gave the row back to pending with no side effect; same key retries. */
    event: "activation_retryable";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    reason: "provider_rejected" | "send_threw" | "lease_lost";
  }
  | {
    /** pending → expired tombstone. */
    event: "expired";
    sessionId: string;
    purpose: SessionPurpose;
    operationId?: string;
    reason: "cancelled" | "ttl" | "owner_failed";
  };

export const SESSION_LIFECYCLE_LOG_PREFIX = "[SessionLifecycle]";

/** `[SessionLifecycle] event=created session=… key=value …` — stable key order, values quoted only when needed. */
export function formatSessionLifecycleLog(event: SessionLifecycleEvent): string {
  const parts: string[] = [`event=${event.event}`];
  for (const [key, value] of Object.entries(event)) {
    if (key === "event" || value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return `${SESSION_LIFECYCLE_LOG_PREFIX} ${parts.join(" ")}`;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  const text = String(value);
  return /[\s=]/.test(text) ? JSON.stringify(text) : text;
}

export function logSessionLifecycle(
  event: SessionLifecycleEvent,
  sink: (line: string) => void = (line) => console.log(line),
): void {
  sink(formatSessionLifecycleLog(event));
}
