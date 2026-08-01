"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, Search, Square, X } from "lucide-react";

import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseProjectChatOperationMessage } from "@/lib/api";
import type {
  ProjectChatMessage,
  ProjectChatContextRef,
  ProjectChatOperationMessage,
  ProjectChatStatus,
  ProjectChatToolApprovalMessage,
} from "@/lib/api";
import { ProjectOperationCard, type ProjectOperationPendingAction } from "./project-operation-card";
import { WorkspaceSelectionCard } from "./workspace-selection-card";

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toolLabel(content: string): string {
  const parsed = parseObject(content);
  const tool = typeof parsed?.toolName === "string"
    ? parsed.toolName
    : typeof parsed?.tool === "string" ? parsed.tool : "project tool";
  return tool.replaceAll("_", " ");
}

function toolOutput(content: string): string {
  const parsed = parseObject(content);
  if (typeof parsed?.output === "string") return parsed.output;
  if (typeof parsed?.error === "string") return parsed.error;
  return content;
}

interface ProjectChatConversationProps {
  messages: ProjectChatMessage[];
  contextRefs: ProjectChatContextRef[];
  status: ProjectChatStatus;
  activeTurnId: string | null;
  pendingApprovalIds: string[];
  queueLength: number;
  loading: boolean;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  connected: boolean;
  error: string | null;
  initialDraft?: string;
  onDraftChange?: (draft: string) => void;
  onDraftSent?: (submittedDraft: string) => void;
  onSend: (content: string) => Promise<void>;
  onLoadEarlierMessages: () => Promise<void>;
  onStop: (expectedActiveTurnId: string) => Promise<boolean>;
  onResolveApproval: (approvalId: string, approved: boolean) => Promise<void>;
  onSelectWorkspace: (requestId: string, workspaceId: string) => Promise<void>;
  onOpenAgentSession?: (sessionId: string, target: string, branch: string | null) => Promise<void> | void;
  onOpenScheduleRun?: (runId: string, scheduleId: string) => Promise<void> | void;
  onRunScheduleAgain?: (runId: string) => Promise<void>;
}

function operationHasDeletedTarget(
  operation: ProjectChatOperationMessage,
  contextRefs: ProjectChatContextRef[],
): boolean {
  const deleted = (entityType: ProjectChatContextRef["entity_type"], entityId: string) => contextRefs.some(
    (ref) => ref.entity_type === entityType && ref.entity_id === entityId && ref.deleted,
  );
  if (operation.kind === "task_create" || operation.kind === "task_update") {
    return deleted("task", operation.taskId);
  }
  if (operation.kind === "agent_session_create" || operation.kind === "agent_instruction") {
    return deleted("agent_session", operation.sessionId);
  }
  if (operation.kind === "schedule_run") {
    return deleted("schedule", operation.scheduleId) || deleted("schedule_run", operation.runId);
  }
  return false;
}

function operationAnnouncement(operation: ProjectChatOperationMessage): string {
  if (operation.kind === "workspace_selection") {
    switch (operation.status) {
      case "pending": return "Waiting for workspace selection";
      case "resolving": return "Creating agent session";
      case "running": return "Agent session running";
      case "completed": return "Agent session completed";
      case "failed": return "Workspace selection failed";
    }
  }

  if (operation.kind === "agent_session_create") {
    if (operation.status === "resolving") return "Creating agent session";
    if (operation.status === "running") return "Agent session running";
    if (operation.status === "completed") return "Agent session completed";
  }
  switch (operation.status) {
    case "pending": return "Queued";
    case "resolving":
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
  }
}

export function ProjectChatConversation({
  messages,
  contextRefs,
  status,
  activeTurnId,
  pendingApprovalIds,
  queueLength,
  loading,
  hasEarlierMessages,
  loadingEarlierMessages,
  connected,
  error,
  initialDraft = "",
  onDraftChange,
  onDraftSent,
  onSend,
  onLoadEarlierMessages,
  onStop,
  onResolveApproval,
  onSelectWorkspace,
  onOpenAgentSession,
  onOpenScheduleRun,
  onRunScheduleAgain,
}: ProjectChatConversationProps) {
  const [input, setInput] = useState(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<Set<string>>(new Set());
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const sendInFlightRef = useRef(false);
  const stopInFlightRef = useRef<string | null>(null);
  const approvalInFlightRef = useRef<Set<string>>(new Set());
  const operationInFlightRef = useRef<Set<string>>(new Set());
  const [pendingOperationActions, setPendingOperationActions] = useState<Map<string, string>>(new Map());
  const [operationErrors, setOperationErrors] = useState<Map<string, string>>(new Map());

  const parsedOperations = useMemo(() => {
    const byMessageId = new Map<string, ProjectChatOperationMessage>();
    const latestMessageIdByOperation = new Map<string, string>();
    for (const message of messages) {
      if (message.type !== "operation") continue;
      const operation = parseProjectChatOperationMessage(message.content);
      if (!operation) continue;
      byMessageId.set(message.id, operation);
      latestMessageIdByOperation.set(operation.operationId, message.id);
    }
    return { byMessageId, latestMessageIdByOperation };
  }, [messages]);

  const runOperationAction = async (
    operationId: string,
    action: ProjectOperationPendingAction | "select_workspace",
    work: () => Promise<void> | void,
  ) => {
    if (operationInFlightRef.current.has(operationId)) return;
    operationInFlightRef.current.add(operationId);
    setPendingOperationActions((current) => new Map(current).set(operationId, action));
    setOperationErrors((current) => {
      const next = new Map(current);
      next.delete(operationId);
      return next;
    });
    try {
      await work();
    } catch (reason) {
      setOperationErrors((current) => new Map(current).set(
        operationId,
        reason instanceof Error ? reason.message : "Project operation failed",
      ));
    } finally {
      operationInFlightRef.current.delete(operationId);
      setPendingOperationActions((current) => {
        const next = new Map(current);
        next.delete(operationId);
        return next;
      });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedDraft = input;
    const content = submittedDraft.trim();
    if (!content || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSubmitting(true);
    setActionError(null);
    try {
      await onSend(content);
      setInput("");
      onDraftSent?.(submittedDraft);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Failed to send message");
    } finally {
      sendInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const expected = stopInFlightRef.current;
    if (!expected || (status === "running" && activeTurnId === expected)) return;
    stopInFlightRef.current = null;
    setStoppingTurnId(null);
  }, [activeTurnId, status]);

  const stop = async () => {
    const expectedActiveTurnId = activeTurnId;
    if (!expectedActiveTurnId || stopInFlightRef.current) return;
    stopInFlightRef.current = expectedActiveTurnId;
    setStoppingTurnId(expectedActiveTurnId);
    setActionError(null);
    try {
      await onStop(expectedActiveTurnId);
    } catch (reason) {
      if (stopInFlightRef.current === expectedActiveTurnId) {
        setActionError(reason instanceof Error ? reason.message : "Failed to stop generation");
      }
    }
  };

  const resolveApproval = async (approvalId: string, approved: boolean) => {
    if (approvalInFlightRef.current.has(approvalId)) return;
    approvalInFlightRef.current.add(approvalId);
    setPendingApprovals((current) => new Set(current).add(approvalId));
    setActionError(null);
    try {
      await onResolveApproval(approvalId, approved);
      setResolvedApprovals((current) => new Set(current).add(approvalId));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Failed to resolve approval");
    } finally {
      approvalInFlightRef.current.delete(approvalId);
      setPendingApprovals((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
    }
  };

  useEffect(() => {
    setResolvedApprovals((current) => {
      const next = new Set([...current].filter((id) => pendingApprovalIds.includes(id)));
      return next.size === current.size ? current : next;
    });
  }, [pendingApprovalIds]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0" initial="instant" resize="smooth" data-testid="project-chat-scroll">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-5 sm:px-6">
        {hasEarlierMessages ? (
          <div className="flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingEarlierMessages}
              onClick={() => void onLoadEarlierMessages()}
            >
              {loadingEarlierMessages ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Load earlier messages
            </Button>
          </div>
        ) : null}
        {loading && messages.length === 0 ? (
          <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : null}
        {!loading && messages.length === 0 ? (
          <div className="mx-auto max-w-md py-20 text-center">
            <h2 className="text-base font-semibold">Start a project conversation</h2>
            <p className="mt-1 text-sm text-muted-foreground">Discuss tasks, schedules, sessions, and work across the whole project.</p>
          </div>
        ) : null}
        <div className="flex w-full flex-col gap-4">
          {messages.map((message) => {
            if (message.type === "turn_end") {
              return <div key={message.id} data-testid="turn-boundary" className="my-2 flex items-center gap-2" aria-label="Turn complete"><span className="h-px flex-1 bg-border" /><span className="size-1 rounded-full bg-border" /><span className="h-px flex-1 bg-border" /></div>;
            }
            if (message.type === "user" || message.type === "assistant") {
              return (
                <Message key={message.id} from={message.type}>
                  <MessageContent>
                    {message.type === "assistant" ? <MessageResponse>{message.content}</MessageResponse> : message.content}
                  </MessageContent>
                </Message>
              );
            }
            if (message.type === "tool_use") {
              return <div key={message.id} className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"><Search className="size-3.5" />Running {toolLabel(message.content)}…</div>;
            }
            if (message.type === "tool_result") {
              return <details key={message.id} className="rounded-md border px-3 py-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Tool result</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{toolOutput(message.content)}</pre></details>;
            }
            if (message.type === "tool_approval_request") {
              const approval = parseObject(message.content) as ProjectChatToolApprovalMessage | null;
              if (!approval || typeof approval.approvalId !== "string") return null;
              const tool = typeof approval.tool === "string" ? approval.tool : "project tool";
              const isPending = pendingApprovalIds.includes(approval.approvalId)
                && !resolvedApprovals.has(approval.approvalId);
              return (
                <div key={message.id} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <div className="font-medium">Approve {tool.replaceAll("_", " ")}?</div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
                  {isPending ? <div className="mt-3 flex gap-2">
                    <Button size="sm" aria-label={`Approve ${tool}`} disabled={pendingApprovals.has(approval.approvalId)} onClick={() => void resolveApproval(approval.approvalId, true)}><Check className="size-3.5" />Approve</Button>
                    <Button size="sm" variant="outline" aria-label={`Deny ${tool}`} disabled={pendingApprovals.has(approval.approvalId)} onClick={() => void resolveApproval(approval.approvalId, false)}><X className="size-3.5" />Deny</Button>
                  </div> : <div className="mt-3 text-xs text-muted-foreground">Approval expired or resolved</div>}
                </div>
              );
            }
            if (message.type === "operation") {
              const parsed = parsedOperations.byMessageId.get(message.id);
              if (!parsed) {
                return <div key={message.id} className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">Project operation unavailable</div>;
              }
              if (parsedOperations.latestMessageIdByOperation.get(parsed.operationId) !== message.id) return null;
              const operation = operationHasDeletedTarget(parsed, contextRefs)
                ? { ...parsed, failure: {
                  code: "deleted_target" as const,
                  message: "The target no longer exists or is unavailable.",
                } }
                : parsed;
              const pendingAction = pendingOperationActions.get(operation.operationId);
              const operationError = operationErrors.get(operation.operationId);
              if (operation.kind === "workspace_selection") {
                const pendingWorkspaceId = pendingAction?.startsWith("workspace:")
                  ? pendingAction.slice("workspace:".length)
                  : null;
                return (
                  <div
                    key={`operation:${operation.operationId}`}
                    data-operation-id={operation.operationId}
                    data-operation-kind={operation.kind}
                  >
                    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                      {operationAnnouncement(operation)}
                    </p>
                    <WorkspaceSelectionCard
                      operation={operation}
                      pendingWorkspaceId={pendingWorkspaceId}
                      actionError={operationError}
                      onSelect={({ requestId, workspaceId }) => {
                        void runOperationAction(operation.operationId, "select_workspace", async () => {
                          setPendingOperationActions((current) => new Map(current).set(
                            operation.operationId, `workspace:${workspaceId}`,
                          ));
                          await onSelectWorkspace(requestId, workspaceId);
                        });
                      }}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={`operation:${operation.operationId}`}
                  data-operation-id={operation.operationId}
                  data-operation-kind={operation.kind}
                >
                  <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                    {operationAnnouncement(operation)}
                  </p>
                  <ProjectOperationCard
                    operation={operation}
                    pendingAction={pendingAction as ProjectOperationPendingAction | undefined}
                    actionError={operationError}
                    onOpenSession={operation.kind === "agent_session_create" && onOpenAgentSession
                      ? (selected) => { void runOperationAction(selected.operationId, "open_session", () => (
                        onOpenAgentSession(selected.sessionId, selected.target ?? "local", selected.branch ?? null)
                      )); }
                      : undefined}
                    onViewOutput={operation.kind === "schedule_run" && onOpenScheduleRun
                      ? (selected) => { void runOperationAction(selected.operationId, "view_output", () => (
                        onOpenScheduleRun(selected.runId, selected.scheduleId)
                      )); }
                      : undefined}
                    onRunAgain={operation.kind === "schedule_run" && onRunScheduleAgain
                      ? (selected) => { void runOperationAction(selected.operationId, "run_again", () => (
                        onRunScheduleAgain(selected.runId)
                      )); }
                      : undefined}
                  />
                </div>
              );
            }
            if (message.type === "error") {
              const parsed = parseObject(message.content);
              const text = typeof parsed?.message === "string" ? parsed.message : message.content;
              return <div key={message.id} role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{text}</div>;
            }
            return <div key={message.id} className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{message.content}</div>;
          })}
          {error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          {actionError ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div> : null}
        </div>
        </ConversationContent>
        <ConversationScrollButton aria-label="Jump to latest message" />
      </Conversation>

      <div className="shrink-0 border-t bg-background p-3 sm:px-6">
        <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-3xl">
          {status === "running" ? (
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{queueLength > 0 ? `${queueLength} queued` : "Project Chat is working"}</span>
              <Button type="button" variant="outline" size="sm" aria-label="Stop generating" disabled={!activeTurnId || stoppingTurnId !== null} onClick={() => void stop()}><Square className="size-3" />{stoppingTurnId ? "Stopping…" : "Stop generating"}</Button>
            </div>
          ) : null}
          {status === "queued" ? (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Clock className="size-3.5" />
              <span>Waiting to start…</span>
            </div>
          ) : null}
          <div className="relative">
            <Textarea
              aria-label="Message Project Chat"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                onDraftChange?.(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={connected ? "Message Project Chat…" : "Reconnecting to Project Chat…"}
              disabled={!connected || submitting}
              rows={2}
              className="min-h-20 resize-none pr-16"
            />
            <Button type="submit" size="sm" aria-label="Send message" disabled={!connected || submitting || !input.trim()} className="absolute bottom-2 right-2">Send</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
