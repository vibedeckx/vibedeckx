"use client";

import { useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOptionalProjectRemotesContext } from "@/hooks/project-remotes-context";
import type { ExecutorDelivery } from "@/lib/api";
import { cn } from "@/lib/utils";

function failureText(delivery: ExecutorDelivery, remote: string): string {
  switch (delivery.reason) {
    case "offline": return `${remote} is offline`;
    case "connection_closed": return "the connection dropped";
    case "timeout": return "no response within 30s";
    default: return delivery.error ?? "unknown error";
  }
}

const clock = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * A remote start whose request was lost: the hub re-delivering it, or having
 * given up. Says why, what happens next, and offers the manual way out —
 * "Retry now" re-sends the same start (the worker dedupes it), "Run again"
 * starts afresh after a give-up.
 */
export function ExecutorDeliveryNotice({
  delivery,
  onRetry,
  showExecutorName = false,
  className,
}: {
  delivery: ExecutorDelivery;
  onRetry: () => Promise<unknown>;
  /** Name the executor, for surfaces that are not its own row. */
  showExecutorName?: boolean;
  className?: string;
}) {
  const remotes = useOptionalProjectRemotesContext();
  const remote = remotes?.remotes.find((r) => r.remote_server_id === delivery.remoteServerId)?.server_name
    ?? "the remote";
  const retrying = delivery.state === "retrying";
  const [busy, setBusy] = useState(false);

  const subject = showExecutorName && delivery.executorName ? `"${delivery.executorName}"` : "This start";
  const failure = failureText(delivery, remote);

  let headline: string;
  let detail: string;
  if (retrying) {
    const next = delivery.nextAttemptAt === null ? `waiting for ${remote} to reconnect` : "trying again about every 30s";
    headline = `${subject} couldn't reach ${remote} (${failure}). Retrying automatically — attempt ${delivery.attempts}, ${next}.`;
    detail = `Retries reuse the same start, so it won't run twice (unless ${remote}'s worker restarts meanwhile). Gives up at ${clock(delivery.deadlineAt)}.`;
  } else if (!delivery.mayHaveRun) {
    const minutes = Math.round((delivery.deadlineAt - delivery.firstSentAt) / 60_000);
    headline = `${subject} couldn't reach ${remote} for ${minutes} minutes (${failure}).`;
    detail = `It never reached ${remote}, so it did not run.`;
  } else {
    const minutes = Math.round((delivery.deadlineAt - delivery.firstSentAt) / 60_000);
    headline = `${subject} couldn't reach ${remote} for ${minutes} minutes (${delivery.attempts} attempts; ${failure}).`;
    detail = `It most likely did not run, but it may have — check on ${remote} before running it again.`;
  }

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="executor-delivery-notice"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        retrying ? "border-primary/30 bg-primary/5" : "border-amber-500/40 bg-amber-500/10",
        className,
      )}
    >
      {retrying
        ? <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary/70" />
        : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
      <div className="min-w-0 flex-1">
        <div className="text-foreground">{headline}</div>
        <div className="mt-0.5 text-muted-foreground">{detail}</div>
      </div>
      <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={handleRetry} disabled={busy}>
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        {retrying ? "Retry now" : "Run again"}
      </Button>
    </div>
  );
}
