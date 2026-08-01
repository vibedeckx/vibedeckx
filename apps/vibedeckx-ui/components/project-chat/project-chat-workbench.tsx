"use client";

import { useState } from "react";
import { ArrowLeft, ChevronDown, MessageSquare, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
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
}

export function ProjectChatWorkbench({
  projectId,
  threadId,
  projectName,
  onBack,
  onSelectThread,
  onOpenContext,
}: ProjectChatWorkbenchProps) {
  const chat = useProjectChat(projectId, threadId);
  const [railVisible, setRailVisible] = useState(true);
  const [headerThreadsOpen, setHeaderThreadsOpen] = useState(false);
  const title = projectChatThreadTitle(chat.thread);
  const activeThreads = chat.threads.filter((item) => item.archived_at === null);

  const newThread = async () => {
    const created = await chat.createThread();
    onSelectThread(created.id);
  };

  const leaveRemovedThread = (removedId: string) => {
    if (removedId !== threadId) return;
    const next = activeThreads.find((item) => item.id !== removedId);
    if (next) onSelectThread(next.id);
    else onBack();
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
            <div className="relative">
              <button
                type="button"
                aria-label={`Current thread: ${title}`}
                aria-expanded={headerThreadsOpen}
                onClick={() => setHeaderThreadsOpen((value) => !value)}
                className="flex max-w-[50vw] items-center gap-1 truncate text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate">{title}</span><ChevronDown className="size-3.5 shrink-0" />
              </button>
              {headerThreadsOpen ? (
                <div className="absolute left-0 top-7 z-30 w-64 rounded-md border bg-popover p-1 shadow-md">
                  {activeThreads.slice(0, 5).map((item) => {
                    const itemTitle = projectChatThreadTitle(item);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={`Switch to thread: ${itemTitle}`}
                        onClick={() => {
                          setHeaderThreadsOpen(false);
                          onSelectThread(item.id);
                        }}
                        className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        {itemTitle}
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => void newThread()} className="mt-1 flex w-full items-center gap-2 border-t px-2 py-2 text-sm hover:bg-muted"><Plus className="size-3.5" />New thread</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={railVisible ? "Hide threads and context" : "Show threads and context"}
          onClick={() => setRailVisible((value) => !value)}
        >
          {railVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1" data-testid="project-chat-workbench-columns">
        <main data-testid="project-chat-main" data-project-chat-column className="min-w-0 flex-1">
          {chat.terminalError === "thread_not_found" ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div><h2 className="font-semibold">Thread not found</h2><Button className="mt-3" variant="outline" onClick={onBack}>Back to Overview</Button></div>
            </div>
          ) : (
            <ProjectChatConversation
              messages={chat.messages}
              status={chat.status}
              queueLength={chat.queueLength}
              loading={chat.threadLoading}
              connected={chat.isConnected}
              error={chat.error}
              onSend={chat.sendMessage}
              onStop={chat.stopTurn}
              onResolveApproval={chat.resolveToolApproval}
            />
          )}
        </main>
        {railVisible ? (
          <ProjectChatAuxiliaryRail
            currentThreadId={threadId}
            threads={chat.threads}
            contextRefs={chat.contextRefs}
            onNewThread={newThread}
            onSelectThread={onSelectThread}
            onRenameThread={async (id, nextTitle) => { await chat.renameThread(id, nextTitle); }}
            onArchiveThread={async (id) => { await chat.archiveThread(id, true); leaveRemovedThread(id); }}
            onDeleteThread={async (id) => { await chat.deleteThread(id); leaveRemovedThread(id); }}
            onLoadArchived={() => chat.refetchThreads(true)}
            onOpenContext={onOpenContext}
          />
        ) : null}
      </div>
    </div>
  );
}
