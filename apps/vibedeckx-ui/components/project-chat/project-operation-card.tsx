"use client";

import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  Loader2,
  MessageSquareMore,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProjectChatOperationMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ProjectOperationPendingAction = "open_session" | "view_output" | "run_again";

export interface ProjectOperationCardProps {
  operation: Exclude<ProjectChatOperationMessage, { kind: "workspace_selection" }>;
  onOpenSession?: (operation: Extract<ProjectChatOperationMessage, { kind: "agent_session_create" }>) => void;
  onViewOutput?: (operation: Extract<ProjectChatOperationMessage, { kind: "schedule_run" }>) => void;
  onRunAgain?: (operation: Extract<ProjectChatOperationMessage, { kind: "schedule_run" }>) => void;
  pendingAction?: ProjectOperationPendingAction | null;
  actionError?: string | null;
}

const statusLabels = {
  pending: "Queued",
  resolving: "Running",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
} as const;

function presentation(operation: ProjectOperationCardProps["operation"]): {
  label: string;
  detail?: string | null;
} {
  switch (operation.kind) {
    case "task_create":
      return { label: "Task created", detail: operation.title ?? operation.taskId };
    case "task_update":
      return { label: "Task updated", detail: operation.title ?? operation.taskId };
    case "agent_session_create":
      return {
        label: "Agent session",
        detail: operation.branch
          ? `${operation.target ?? "workspace"} / ${operation.branch}`
          : operation.target ?? "main workspace",
      };
    case "agent_instruction":
      return { label: "Agent instruction", detail: operation.instruction ?? operation.sessionId };
    case "schedule_run":
      return { label: "Schedule run", detail: operation.runId };
  }
}

function statePresentation(operation: ProjectOperationCardProps["operation"]): {
  label: string;
  Icon: typeof CircleDot;
  className: string;
} {
  if (operation.failure?.code === "timeout") {
    return { label: "Timed out", Icon: Clock3, className: "text-amber-600" };
  }
  if (operation.failure?.code === "remote_offline") {
    return { label: "Remote offline", Icon: AlertCircle, className: "text-destructive" };
  }
  if (operation.failure?.code === "deleted_target") {
    return { label: "Deleted target", Icon: AlertCircle, className: "text-muted-foreground" };
  }
  if (operation.status === "completed") {
    return { label: statusLabels.completed, Icon: CheckCircle2, className: "text-emerald-600" };
  }
  if (operation.status === "failed") {
    return { label: statusLabels.failed, Icon: AlertCircle, className: "text-destructive" };
  }
  if (operation.status === "running" || operation.status === "resolving") {
    return { label: "Running", Icon: Loader2, className: "text-blue-600" };
  }
  return { label: "Queued", Icon: CircleDot, className: "text-muted-foreground" };
}

export function ProjectOperationCard({
  operation,
  onOpenSession,
  onViewOutput,
  onRunAgain,
  pendingAction,
  actionError,
}: ProjectOperationCardProps) {
  const { label, detail } = presentation(operation);
  const state = statePresentation(operation);
  const targetDeleted = operation.failure?.code === "deleted_target";
  const StateIcon = state.Icon;

  return (
    <section
      className="rounded-lg border bg-card p-3 text-card-foreground"
      aria-label={`${label}: ${state.label}`}
      data-operation-id={operation.operationId}
      data-operation-kind={operation.kind}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {detail ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div> : null}
        </div>
        <div className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium", state.className)}>
          <StateIcon
            className={cn("size-3.5", (operation.status === "running" || operation.status === "resolving") && "animate-spin")}
            aria-hidden="true"
          />
          {state.label}
        </div>
      </div>

      {operation.failure?.message ? (
        <p className="mt-2 text-xs text-muted-foreground">{operation.failure.message}</p>
      ) : null}

      {operation.kind === "agent_session_create" && onOpenSession ? (
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-busy={pendingAction === "open_session"}
            disabled={targetDeleted || pendingAction !== null && pendingAction !== undefined}
            onClick={() => onOpenSession(operation)}
          >
            {pendingAction === "open_session" ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
            Open Session
          </Button>
        </div>
      ) : null}

      {operation.kind === "schedule_run" && (onViewOutput || onRunAgain) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {onViewOutput ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-busy={pendingAction === "view_output"}
              disabled={targetDeleted || pendingAction !== null && pendingAction !== undefined}
              onClick={() => onViewOutput(operation)}
            >
              {pendingAction === "view_output" ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareMore className="size-3.5" />}
              View Output
            </Button>
          ) : null}
          {onRunAgain ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-busy={pendingAction === "run_again"}
              disabled={targetDeleted || pendingAction !== null && pendingAction !== undefined}
              onClick={() => onRunAgain(operation)}
            >
              {pendingAction === "run_again" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              {pendingAction === "run_again" ? "Running again…" : "Run Again"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {actionError ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </section>
  );
}
