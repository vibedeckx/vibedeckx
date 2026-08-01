"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, Check, Loader2, Search, Square, X } from "lucide-react";

import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  ProjectChatMessage,
  ProjectChatOperationMessage,
  ProjectChatStatus,
  ProjectChatToolApprovalMessage,
} from "@/lib/api";

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

function operationLabel(content: string): string {
  const parsed = parseObject(content) as ProjectChatOperationMessage | null;
  const labels: Record<string, string> = {
    task_create: "Task creation",
    task_update: "Task update",
    agent_session_create: "Agent session",
    agent_instruction: "Agent instruction",
    schedule_run: "Schedule run",
    workspace_selection: "Workspace selection",
  };
  return parsed && typeof parsed.kind === "string"
    ? `${labels[parsed.kind] ?? "Project operation"} · ${parsed.status}`
    : "Project operation";
}

interface ProjectChatConversationProps {
  messages: ProjectChatMessage[];
  status: ProjectChatStatus;
  queueLength: number;
  loading: boolean;
  connected: boolean;
  error: string | null;
  onSend: (content: string) => Promise<void>;
  onStop: () => Promise<boolean>;
  onResolveApproval: (approvalId: string, approved: boolean) => Promise<void>;
}

export function ProjectChatConversation({
  messages,
  status,
  queueLength,
  loading,
  connected,
  error,
  onSend,
  onStop,
  onResolveApproval,
}: ProjectChatConversationProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    try {
      await onSend(content);
      setInput("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
        {loading && messages.length === 0 ? (
          <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : null}
        {!loading && messages.length === 0 ? (
          <div className="mx-auto max-w-md py-20 text-center">
            <h2 className="text-base font-semibold">Start a project conversation</h2>
            <p className="mt-1 text-sm text-muted-foreground">Discuss tasks, schedules, sessions, and work across the whole project.</p>
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
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
              return (
                <div key={message.id} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <div className="font-medium">Approve {tool.replaceAll("_", " ")}?</div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" aria-label={`Approve ${tool}`} onClick={() => void onResolveApproval(approval.approvalId, true)}><Check className="size-3.5" />Approve</Button>
                    <Button size="sm" variant="outline" aria-label={`Deny ${tool}`} onClick={() => void onResolveApproval(approval.approvalId, false)}><X className="size-3.5" />Deny</Button>
                  </div>
                </div>
              );
            }
            if (message.type === "operation") {
              return <div key={message.id} className="rounded-md border bg-card px-3 py-2 text-sm" data-testid="project-operation-summary">{operationLabel(message.content)}</div>;
            }
            if (message.type === "error") {
              const parsed = parseObject(message.content);
              const text = typeof parsed?.message === "string" ? parsed.message : message.content;
              return <div key={message.id} role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{text}</div>;
            }
            return <div key={message.id} className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{message.content}</div>;
          })}
          {error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        </div>
      </div>

      <div className="shrink-0 border-t bg-background p-3 sm:px-6">
        <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-3xl">
          {status === "running" ? (
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{queueLength > 0 ? `${queueLength} queued` : "Project Chat is working"}</span>
              <Button type="button" variant="outline" size="sm" aria-label="Stop generating" onClick={() => void onStop()}><Square className="size-3" />Stop generating</Button>
            </div>
          ) : null}
          <div className="relative">
            <Textarea
              aria-label="Message Project Chat"
              value={input}
              onChange={(event) => setInput(event.target.value)}
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
