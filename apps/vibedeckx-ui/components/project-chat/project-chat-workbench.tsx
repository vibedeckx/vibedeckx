"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, MessageSquare, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useProjectChat } from "@/hooks/use-project-chat";
import type { ProjectChatContextRef } from "@/lib/api";
import { ProjectChatAuxiliaryRail } from "./project-chat-auxiliary-rail";
import { ProjectChatConversation } from "./project-chat-conversation";
import { projectChatThreadTitle } from "./project-chat-thread-history";

interface ProjectChatWorkbenchProps {
  projectId: string;
  threadId: string;
  projectName: string;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onOpenContext?: (ref: ProjectChatContextRef) => void;
  onOpenAgentSession?: (sessionId: string, target: string, branch: string | null) => Promise<void> | void;
  onOpenScheduleRun?: (runId: string, scheduleId: string) => Promise<void> | void;
  onRunScheduleAgain?: (runId: string) => Promise<void>;
}

export function ProjectChatWorkbench({
  projectId,
  threadId,
  projectName,
  onBack,
  onSelectThread,
  onOpenContext,
  onOpenAgentSession,
  onOpenScheduleRun,
  onRunScheduleAgain,
}: ProjectChatWorkbenchProps) {
  const chat = useProjectChat(projectId, threadId);
  const [railVisible, setRailVisible] = useState(true);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [headerThreadsOpen, setHeaderThreadsOpen] = useState(false);
  const [newThreadPending, setNewThreadPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const newThreadInFlightRef = useRef(false);
  const draftsRef = useRef(new Map<string, string>());
  const mobileRailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scopeGenerationRef = useRef(0);
  const title = projectChatThreadTitle(chat.thread);
  const activeThreads = chat.threads.filter((item) => item.archived_at === null);
  const scopeKey = `${projectId}:${threadId}`;
  const isMobile = useIsMobile();

  const setMobileRailVisibility = (open: boolean) => {
    setMobileRailOpen(open);
    if (!open) {
      requestAnimationFrame(() => mobileRailTriggerRef.current?.focus());
    }
  };

  useEffect(() => {
    scopeGenerationRef.current += 1;
    newThreadInFlightRef.current = false;
    setNewThreadPending(false);
    setActionError(null);
    setHeaderThreadsOpen(false);
    setMobileRailOpen(false);
  }, [scopeKey]);

  const newThread = async () => {
    if (newThreadInFlightRef.current) return;
    const generation = scopeGenerationRef.current;
    newThreadInFlightRef.current = true;
    setNewThreadPending(true);
    setActionError(null);
    try {
      const created = await chat.createThread();
      if (generation === scopeGenerationRef.current && created.project_id === projectId) {
        onSelectThread(created.id);
      }
    } catch (reason) {
      if (generation === scopeGenerationRef.current) {
        setActionError(reason instanceof Error ? reason.message : "Failed to create thread");
      }
    } finally {
      if (generation === scopeGenerationRef.current) {
        newThreadInFlightRef.current = false;
        setNewThreadPending(false);
      }
    }
  };

  const leaveRemovedThread = (removedId: string) => {
    if (removedId !== threadId) return;
    const next = activeThreads.find((item) => item.id !== removedId);
    if (next) onSelectThread(next.id);
    else onBack();
  };

  const archiveThread = async (id: string) => {
    const generation = scopeGenerationRef.current;
    await chat.archiveThread(id, true);
    if (generation === scopeGenerationRef.current) leaveRemovedThread(id);
  };

  const deleteThread = async (id: string) => {
    const generation = scopeGenerationRef.current;
    await chat.deleteThread(id);
    if (generation === scopeGenerationRef.current) leaveRemovedThread(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to Overview" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <MessageSquare className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-[11px] text-muted-foreground">{projectName} / Project Chat</div>
            <DropdownMenu open={headerThreadsOpen} onOpenChange={setHeaderThreadsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Current thread: ${title}`}
                  className="flex max-w-[50vw] items-center gap-1 truncate text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">{title}</span><ChevronDown className="size-3.5 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {activeThreads.slice(0, 5).map((item) => {
                  const itemTitle = projectChatThreadTitle(item);
                  return (
                    <DropdownMenuItem key={item.id} asChild>
                      <button
                        type="button"
                        aria-label={`Switch to thread: ${itemTitle}`}
                        onClick={() => onSelectThread(item.id)}
                        className="w-full truncate text-left"
                      >
                        {itemTitle}
                      </button>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuItem asChild>
                  <button type="button" disabled={newThreadPending} onClick={() => void newThread()} className="w-full border-t"><Plus className="size-3.5" />New thread</button>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <Button
          ref={mobileRailTriggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={isMobile
            ? "Open threads and context"
            : railVisible ? "Hide threads and context" : "Show threads and context"}
          onClick={() => isMobile ? setMobileRailOpen(true) : setRailVisible((value) => !value)}
        >
          {isMobile ? <PanelRightOpen className="size-4" />
            : railVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
        </Button>
      </header>
      {actionError ? <div role="alert" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{actionError}</div> : null}

      <div className="flex min-h-0 flex-1" data-testid="project-chat-workbench-columns">
        <main data-testid="project-chat-main" data-project-chat-column className="min-w-0 flex-1">
          {chat.terminalError === "thread_not_found" ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div><h2 className="font-semibold">Thread not found</h2><Button className="mt-3" variant="outline" onClick={onBack}>Back to Overview</Button></div>
            </div>
          ) : (
            <ProjectChatConversation
              key={scopeKey}
              messages={chat.messages}
              contextRefs={chat.contextRefs}
              status={chat.status}
              activeTurnId={chat.activeTurnId}
              queueLength={chat.queueLength}
              loading={chat.threadLoading}
              connected={chat.isConnected}
              error={chat.error}
              initialDraft={draftsRef.current.get(scopeKey) ?? ""}
              onDraftChange={(draft) => {
                if (draft) draftsRef.current.set(scopeKey, draft);
                else draftsRef.current.delete(scopeKey);
              }}
              onSend={chat.sendMessage}
              onStop={chat.stopTurn}
              onResolveApproval={chat.resolveToolApproval}
              onSelectWorkspace={chat.selectWorkspace}
              onOpenAgentSession={onOpenAgentSession}
              onOpenScheduleRun={onOpenScheduleRun}
              onRunScheduleAgain={onRunScheduleAgain}
            />
          )}
        </main>
        {!isMobile && railVisible ? (
          <ProjectChatAuxiliaryRail
            key={scopeKey}
            currentThreadId={threadId}
            threads={chat.threads}
            contextRefs={chat.contextRefs}
            onNewThread={newThread}
            onSelectThread={onSelectThread}
            onRenameThread={async (id, nextTitle) => { await chat.renameThread(id, nextTitle); }}
            onArchiveThread={archiveThread}
            onDeleteThread={deleteThread}
            onLoadArchived={() => chat.refetchThreads(true)}
            onOpenContext={onOpenContext}
            newThreadPending={newThreadPending}
          />
        ) : null}
      </div>
      {isMobile ? (
        <Sheet open={mobileRailOpen} onOpenChange={setMobileRailVisibility}>
          <SheetContent
            side="right"
            data-testid="project-chat-mobile-drawer"
            className="w-[min(90vw,360px)] gap-0 p-0"
            aria-label="Project Chat threads and context"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              mobileRailTriggerRef.current?.focus();
            }}
          >
            <SheetHeader className="shrink-0 border-b px-4 py-3 pr-14 text-left">
              <SheetTitle className="text-sm">Threads and context</SheetTitle>
              <SheetDescription className="text-xs">Switch conversations and open referenced project items.</SheetDescription>
            </SheetHeader>
            <ProjectChatAuxiliaryRail
              key={scopeKey}
              className="min-h-0 w-full flex-1 border-l-0"
              currentThreadId={threadId}
              threads={chat.threads}
              contextRefs={chat.contextRefs}
              onNewThread={newThread}
              onSelectThread={(id) => { setMobileRailVisibility(false); onSelectThread(id); }}
              onRenameThread={async (id, nextTitle) => { await chat.renameThread(id, nextTitle); }}
              onArchiveThread={archiveThread}
              onDeleteThread={deleteThread}
              onLoadArchived={() => chat.refetchThreads(true)}
              onOpenContext={onOpenContext ? (ref) => { setMobileRailVisibility(false); onOpenContext(ref); } : undefined}
              newThreadPending={newThreadPending}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
