"use client";

import type { ReactNode } from "react";
import { AlertCircle, Ban, CheckCircle2 } from "lucide-react";
import { Loader } from "@/components/ai-elements/loader";

/**
 * Empty-state blocks for a review run's reviewer side. Shared between the
 * real reviewer conversation (AgentConversation, while the run is still
 * preparing and the prompt has not landed) and the stand-in view a user
 * reaches from the sidebar before the reviewer session exists at all
 * (PreparingReviewView).
 */

export function ReviewPreparingPlaceholder({
  phase = "distilling",
  children,
}: {
  /**
   * `distilling` — the intent brief is still being distilled (run status
   * `preparing`). `starting` — the run advanced but the reviewer session is
   * not yet listed as live, so it cannot be opened yet.
   */
  phase?: "distilling" | "starting";
  children?: ReactNode;
}) {
  return (
    <div className="text-center py-16">
      <Loader className="h-6 w-6 mx-auto mb-4" />
      <h3 className="text-sm font-semibold mb-1 text-foreground">Preparing review…</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {phase === "starting"
          ? "The reviewer is starting. This view switches to the review conversation as soon as it is ready."
          : "Summarizing the source conversation and briefing the reviewer. The review will start here automatically — you can leave this window in the meantime."}
      </p>
      {children}
    </div>
  );
}

export function ReviewFailedPlaceholder({
  error,
  title = "Review setup failed",
  children,
}: {
  error: string | null | undefined;
  /** Overridden when the failure is the status read itself, not the review. */
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="text-center py-16">
      <div className="mx-auto w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center mb-4">
        <AlertCircle className="h-6 w-6 text-destructive/70" />
      </div>
      <h3 className="text-sm font-semibold mb-1 text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {error ?? "The reviewer could not be started."}
      </p>
      {children}
    </div>
  );
}

export function ReviewEndedPlaceholder({
  status,
  children,
}: {
  status: "cancelled" | "completed" | "gone";
  children?: ReactNode;
}) {
  const Icon = status === "completed" ? CheckCircle2 : Ban;
  const title = status === "completed"
    ? "Review completed"
    : status === "cancelled"
      ? "Review cancelled"
      : "Review no longer available";
  const detail = status === "completed"
    ? "The reviewer finished before this view could open it."
    : status === "cancelled"
      ? "The review was ended before the reviewer started."
      : "The server no longer has this review run.";
  return (
    <div className="text-center py-16">
      <div className="mx-auto w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold mb-1 text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">{detail}</p>
      {children}
    </div>
  );
}
