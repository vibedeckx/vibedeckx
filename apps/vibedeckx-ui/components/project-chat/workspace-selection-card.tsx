"use client";

import { Loader2, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProjectChatOperationMessage } from "@/lib/api";

type WorkspaceSelectionOperation = Extract<ProjectChatOperationMessage, { kind: "workspace_selection" }>;

export interface WorkspaceSelectionCardProps {
  operation: WorkspaceSelectionOperation;
  onSelect: (selection: { requestId: string; workspaceId: string }) => void;
  pendingWorkspaceId?: string | null;
  actionError?: string | null;
}

function workspaceLabel(candidate: WorkspaceSelectionOperation["candidates"][number]): string {
  return `${candidate.target} / ${candidate.branch ?? "main"}`;
}

function selectionStatus(operation: WorkspaceSelectionOperation): string {
  switch (operation.status) {
    case "pending":
      return "Waiting for workspace selection";
    case "resolving":
      return "Workspace selected; creating agent session";
    case "running":
      return "Agent session running";
    case "completed":
      return "Agent session created";
    case "failed":
      return "Workspace selection failed";
  }
}

export function WorkspaceSelectionCard({
  operation,
  onSelect,
  pendingWorkspaceId,
  actionError,
}: WorkspaceSelectionCardProps) {
  const resolved = operation.status !== "pending";
  return (
    <section
      className="rounded-lg border bg-card p-3 text-card-foreground"
      aria-label="Select a workspace for the agent session"
      data-operation-id={operation.operationId}
      data-operation-kind={operation.kind}
    >
      <div className="text-sm font-medium">Choose a workspace</div>
      <p className="mt-0.5 text-xs text-muted-foreground">This agent session needs one of the project&apos;s offered workspaces.</p>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {selectionStatus(operation)}
      </p>
      <div className="mt-3 grid gap-2">
        {operation.candidates.map((candidate) => {
          const selecting = pendingWorkspaceId === candidate.id;
          const label = workspaceLabel(candidate);
          return (
            <Button
              key={candidate.id}
              type="button"
              variant="outline"
              className="h-auto min-h-9 justify-start whitespace-normal text-left"
              aria-label={`Select workspace: ${label}`}
              aria-busy={selecting}
              disabled={resolved || pendingWorkspaceId !== null && pendingWorkspaceId !== undefined}
              onClick={() => onSelect({ requestId: operation.requestId, workspaceId: candidate.id })}
            >
              {selecting ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
              {label}{selecting ? " · Selecting…" : ""}
            </Button>
          );
        })}
      </div>
      {resolved ? <p className="mt-2 text-xs text-muted-foreground">Workspace selection resolved.</p> : null}
      {actionError ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </section>
  );
}
