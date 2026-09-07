"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ai-elements/loader";
import { api, type WorkflowRun } from "@/lib/api";
import type { PreparingReviewEntry } from "@/hooks/preparing-reviews";
import {
  ReviewEndedPlaceholder,
  ReviewFailedPlaceholder,
  ReviewPreparingPlaceholder,
} from "./review-placeholders";

/**
 * Stand-in for the reviewer conversation of a review that is still preparing.
 *
 * The reviewer is a pending identity at this point: it has no process, is in
 * no listing, and both the session REST read and its WebSocket answer
 * "Session not found" — which the agent-session hook treats as "start a fresh
 * session here". So this view deliberately mounts NO session hook and issues
 * no session request. It renders from the preparing-review store entry, and
 * page.tsx swaps it for the real conversation once the run has advanced AND
 * `/alive` lists the reviewer (see resolvePreparingSwitch).
 *
 * When the entry is gone (the run reached a terminal state and left the
 * active listing) the one read that still sees terminal runs — by id — tells
 * the user what happened instead of leaving a spinner.
 */
export function PreparingReviewView({
  runId,
  entry,
  title,
  onOpenSource,
}: {
  runId: string;
  entry: PreparingReviewEntry | undefined;
  title: string;
  /** Navigate back to the source conversation the review was started from. */
  onOpenSource: (sourceSessionId: string, branch: string | null) => void;
}) {
  type Probe =
    | { runId: string; attempt: number; run: WorkflowRun | null }
    | { runId: string; attempt: number; error: string };
  const [probe, setProbe] = useState<Probe | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Only when the store no longer holds the run: a run that is still
  // preparing or advancing is fully described by the entry. The read can fail
  // on its own (a tunnel blip on a remote project is enough), and nothing
  // else would re-render this view afterwards — so the failure is a state of
  // its own with a retry, never a spinner that never ends.
  useEffect(() => {
    if (entry) return;
    let cancelled = false;
    api.getWorkflowRun(runId)
      .then((run) => { if (!cancelled) setProbe({ runId, attempt, run }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProbe({ runId, attempt, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [entry, runId, attempt]);

  const settled = probe?.runId === runId && probe.attempt === attempt ? probe : null;
  const resolved = settled && !("error" in settled) ? settled : null;
  const sourceRun = entry?.run ?? resolved?.run ?? null;

  let body;
  if (entry) {
    body = <ReviewPreparingPlaceholder phase={entry.run.status === "preparing" ? "distilling" : "starting"} />;
  } else if (settled && "error" in settled) {
    body = (
      <ReviewFailedPlaceholder error={settled.error} title="Could not read the review status">
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </Button>
      </ReviewFailedPlaceholder>
    );
  } else if (!resolved) {
    body = (
      <div className="text-center py-16">
        <Loader className="h-6 w-6 mx-auto mb-4" />
        <h3 className="text-sm font-semibold mb-1 text-foreground">Checking review status…</h3>
      </div>
    );
  } else if (!resolved.run) {
    body = <ReviewEndedPlaceholder status="gone" />;
  } else if (resolved.run.status === "failed") {
    body = <ReviewFailedPlaceholder error={resolved.run.error} />;
  } else if (resolved.run.status === "cancelled" || resolved.run.status === "completed") {
    body = <ReviewEndedPlaceholder status={resolved.run.status} />;
  } else {
    body = <ReviewPreparingPlaceholder phase="starting" />;
  }

  return (
    <div className="flex flex-col h-full" data-testid="preparing-review-view">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-sm font-medium truncate" title={title}>{title}</span>
        {sourceRun && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={() => onOpenSource(sourceRun.source_session_id, sourceRun.branch)}
          >
            <ArrowLeft className="h-3 w-3 mr-1" />
            Source conversation
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4">{body}</div>
    </div>
  );
}
