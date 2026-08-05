export type WorkspaceBindingReadOutcome =
  | "checkout-hit"
  | "legacy-fallback"
  | "dangling"
  | "mismatch";

export type WorkspaceBindingReadConsumer =
  | "runtime"
  | "session-list"
  | "session-detail"
  | "search"
  | "notification"
  | "project-activity"
  | "project-chat"
  | "workflow-reviewer";

export interface WorkspaceBindingReadMetric {
  consumer: WorkspaceBindingReadConsumer;
  outcome: WorkspaceBindingReadOutcome;
  count: number;
}

const counters = new Map<string, number>();

const key = (consumer: WorkspaceBindingReadConsumer, outcome: WorkspaceBindingReadOutcome) =>
  `${consumer}:${outcome}`;

export function recordWorkspaceBindingRead(
  consumer: WorkspaceBindingReadConsumer,
  outcome: WorkspaceBindingReadOutcome,
  count = 1,
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  const metricKey = key(consumer, outcome);
  counters.set(metricKey, (counters.get(metricKey) ?? 0) + count);
}

export function getWorkspaceBindingReadMetrics(): WorkspaceBindingReadMetric[] {
  const outcomes: WorkspaceBindingReadOutcome[] = [
    "checkout-hit", "legacy-fallback", "dangling", "mismatch",
  ];
  const consumers: WorkspaceBindingReadConsumer[] = [
    "runtime", "session-list", "session-detail", "search", "notification",
    "project-activity", "project-chat", "workflow-reviewer",
  ];
  return consumers.flatMap((consumer) => outcomes.map((outcome) => ({
    consumer,
    outcome,
    count: counters.get(key(consumer, outcome)) ?? 0,
  })));
}

/** Test/process-lifecycle hook. Production callers should read cumulative values. */
export function resetWorkspaceBindingReadMetrics(): void {
  counters.clear();
}
