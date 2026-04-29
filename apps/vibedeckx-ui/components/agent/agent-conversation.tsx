"use client";

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle, createContext, useContext, type ClipboardEvent } from "react";
import { useAgentSession } from "@/hooks/use-agent-session";
import type { AgentMessage, ContentPart, UploadedPaste, AgentSession } from "@/hooks/use-agent-session";
import { AgentMessageItem } from "./agent-message";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputActionMenuItem,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Bot, Square, AlertCircle, Wifi, WifiOff, SquarePen, Monitor, Cloud, Languages, X, Loader2, ChevronDown } from "lucide-react";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PermissionModeToggle } from "@/components/ui/permission-mode-toggle";
import { useInputHistory } from "@/hooks/use-input-history";
import { useWorkspaceDraft } from "@/hooks/use-workspace-draft";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type { Project, ExecutionMode, AgentType, AgentProviderInfo } from "@/lib/api";
import { getAgentProviders, translateText } from "@/lib/api";
import { toast } from "sonner";
import { UserInputMarkers } from "./user-input-markers";
import { SessionHistoryDropdown } from "./session-history-dropdown";
import { QuotePopover, formatAsQuote } from "./quote-popover";

/** Only renders the attachment header when there are files attached */
function AttachmentHeader() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader>
      <PromptInputAttachments>
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
    </PromptInputHeader>
  );
}

interface AgentConversationContextValue {
  sendMessage: (content: string | ContentPart[], sessionId?: string) => Promise<void>;
  messages: AgentMessage[];
  acceptPlan: (planContent: string) => Promise<void>;
  permissionMode: "plan" | "edit";
  agentType: AgentType;
  sessionId: string | null;
}

const AgentConversationContext = createContext<AgentConversationContextValue | null>(null);

export function useAgentConversation() {
  const ctx = useContext(AgentConversationContext);
  if (!ctx) throw new Error("useAgentConversation must be used within AgentConversationContext");
  return ctx;
}

interface AgentConversationProps {
  projectId: string | null;
  branch: string | null;
  sessionId?: string | null;
  setSessionUrlParam?: (id: string | null) => void;
  project?: Project | null;
  onAgentModeChange?: (mode: ExecutionMode) => void;
  onTaskCompleted?: () => void;
  onSessionStarted?: () => void;
  onStatusChange?: () => void;
  onNewConversation?: () => void;
}

export interface AgentConversationHandle {
  submitMessage: (content: string) => Promise<void>;
}

// TODO(paste): expose as configurable setting
const PASTE_TO_FILE_THRESHOLD = 2000;
// Match any size label inside the parens (e.g. "1.2KB", "42KB", "900B") so the
// regex stays in sync with formatPasteSize without coupling the two.
const PASTE_TOKEN_RE = /\[📎 paste #(\d+) \([^)]+\)\]/g;

interface PasteEntry {
  id: number;
  content: string;
  size: number; // bytes, UTF-8
}

function formatPasteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  return `${Math.round(kb)}KB`;
}

function pasteTokenFor(id: number, bytes: number): string {
  return `[📎 paste #${id} (${formatPasteSize(bytes)})]`;
}

export const AgentConversation = forwardRef<AgentConversationHandle, AgentConversationProps>(
  function AgentConversation({ projectId, branch, sessionId, setSessionUrlParam, project, onAgentModeChange, onTaskCompleted, onSessionStarted, onStatusChange, onNewConversation }, ref) {
  const [input, setInput] = useWorkspaceDraft(projectId, branch);
  const [pastes, setPastes] = useState<PasteEntry[]>([]);
  const [nextPasteId, setNextPasteId] = useState(1);
  const [permissionMode, setPermissionMode] = useState<"plan" | "edit">("edit");
  const [translateEnabled, setTranslateEnabled] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaWrapperRef = useRef<HTMLDivElement>(null);
  const inputHistory = useInputHistory(setInput, projectId, branch);
  const { remotes } = useProjectRemotes(project?.id ?? undefined);

  // Build execution mode targets from local path + project remotes
  const agentTargets: ExecutionModeTarget[] = [];
  if (project?.path) agentTargets.push({ id: "local", label: "Local", icon: Monitor });
  for (const r of remotes) {
    agentTargets.push({ id: r.remote_server_id, label: r.server_name, icon: Cloud });
  }

  const {
    session,
    messages,
    status,
    isConnected,
    isInitialized,
    isLoading,
    error,
    remoteStatus,
    startSession,
    sendMessage,
    uploadPaste,
    stopSession,
    restartSession,
    startNewConversation,
    switchMode,
    acceptPlan,
  } = useAgentSession(projectId, branch, project?.agent_mode, agentType, { sessionId, onTaskCompleted, onSessionStarted });

  // Fetch available agent providers on mount
  useEffect(() => {
    getAgentProviders().then(setProviders).catch(() => {});
  }, []);

  // Sync local permissionMode from session (e.g. after workspace switch restores cached session)
  useEffect(() => {
    if (session?.permissionMode) {
      setPermissionMode(session.permissionMode);
    }
  }, [session?.permissionMode]);

  // Sync local agentType from session (e.g. after workspace switch restores cached session)
  useEffect(() => {
    if (session?.agentType) {
      setAgentType(session.agentType);
    }
  }, [session?.agentType]);

  // Reset paste state when workspace changes — pastes are scoped to a single draft.
  useEffect(() => {
    setPastes([]);
    setNextPasteId(1);
  }, [projectId, branch]);

  const handlePermissionModeChange = async (newMode: "plan" | "edit") => {
    setPermissionMode(newMode);
    if (session) {
      await switchMode(newMode);
    }
    // If no session yet, the mode will be used when startSession is called
  };

  const handleAcceptPlan = async (planContent: string) => {
    await acceptPlan(planContent);
    setPermissionMode("edit");
    onStatusChange?.();  // Agent will now implement the plan → signal "working"
  };

  const handleQuote = useCallback((text: string) => {
    setInput(formatAsQuote(text) + input);
    requestAnimationFrame(() => {
      const ta = textareaWrapperRef.current?.querySelector("textarea");
      if (!ta) return;
      ta.focus();
      const len = ta.value.length;
      try {
        ta.setSelectionRange(len, len);
      } catch {
        // ignore — textarea may have been unmounted
      }
    });
  }, [setInput, input]);

  useImperativeHandle(ref, () => ({
    submitMessage: async (content: string) => {
      if (!session || status !== "running") {
        onStatusChange?.();  // Immediate visual feedback before async session start
        const newSession = await startSession(permissionMode);
        if (newSession) {
          sendMessage(content, newSession.id);
        }
      } else {
        sendMessage(content);
      }
    }
  }), [session, status, startSession, sendMessage, permissionMode]);

  const handlePasteText = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>, text: string) => {
      if (text.length <= PASTE_TO_FILE_THRESHOLD) return;

      event.preventDefault();

      const textarea = event.currentTarget;
      const start = textarea.selectionStart ?? input.length;
      const end = textarea.selectionEnd ?? input.length;
      const size = new TextEncoder().encode(text).length;

      const id = nextPasteId;
      const token = pasteTokenFor(id, size);
      const newValue = input.slice(0, start) + token + input.slice(end);

      setInput(newValue);
      setPastes((prev) => [...prev, { id, content: text, size }]);
      setNextPasteId(id + 1);

      // Restore caret after the inserted token.
      const caret = start + token.length;
      requestAnimationFrame(() => {
        try {
          textarea.setSelectionRange(caret, caret);
        } catch {
          // ignore — textarea may have been unmounted
        }
      });
    },
    [input, nextPasteId, setInput]
  );

  async function materializePastes(
    rawText: string,
    pastes: PasteEntry[],
    upload: (content: string, sessionId?: string) => Promise<UploadedPaste>,
    sessionId?: string
  ): Promise<string> {
    const presentIds = new Set<number>();
    for (const match of rawText.matchAll(PASTE_TOKEN_RE)) {
      presentIds.add(Number(match[1]));
    }
    const surviving = pastes.filter((p) => presentIds.has(p.id));
    if (surviving.length === 0) return rawText;

    let result = rawText;
    for (const paste of surviving) {
      const uploaded = await upload(paste.content, sessionId);
      const token = pasteTokenFor(paste.id, paste.size);
      const marker = `<vpaste path="${uploaded.path}" size="${uploaded.size}" />`;
      // Replace every occurrence of this token (should be exactly one, but be safe).
      result = result.split(token).join(marker);
    }
    return result;
  }

  const handleSubmit = async (message: PromptInputMessage) => {
    const rawText = message.text;
    const hasFiles = message.files.length > 0;
    const hasPastes = pastes.length > 0;
    const trimmedRaw = rawText.trim();
    if (!trimmedRaw && !hasFiles) return;

    setIsSubmitting(true);
    try {
    setInput("");
    inputHistory.push(trimmedRaw);

    // Resolve which session id to use. If no session yet, the session will be
    // created below and materialization must happen against that new id.
    let targetSessionId: string | undefined = session?.id;
    let startedSession: AgentSession | null = null;
    if (!session || status !== "running") {
      onStatusChange?.();
      startedSession = await startSession(permissionMode);
      if (!startedSession) {
        // Restore input on failure so the user doesn't lose their pastes.
        setInput(rawText);
        return;
      }
      targetSessionId = startedSession.id;
    }

    // Upload pastes (if any) and replace tokens with <vpaste/> markers.
    let processedText = trimmedRaw;
    if (hasPastes) {
      try {
        processedText = (await materializePastes(rawText, pastes, uploadPaste, targetSessionId)).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to upload paste";
        toast.error("Paste upload failed", { description: msg });
        setInput(rawText);
        return;
      }
    }

    // If the resulting message text is still over the threshold (typed long
    // content, accumulated small pastes, etc.), wrap the whole thing into a
    // single paste file so the conversation/UI doesn't carry the bulk inline.
    if (processedText.length > PASTE_TO_FILE_THRESHOLD) {
      try {
        const uploaded = await uploadPaste(processedText, targetSessionId);
        processedText = `<vpaste path="${uploaded.path}" size="${uploaded.size}" />`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to upload paste";
        toast.error("Paste upload failed", { description: msg });
        setInput(rawText);
        return;
      }
    }

    // Clear pastes state now that they've been materialized into the outgoing message.
    const capturedPastes = pastes;
    const capturedNextPasteId = nextPasteId;
    setPastes([]);
    setNextPasteId(1);

    // Build content: plain string when no files, ContentPart[] when files are attached
    let content: string | ContentPart[];
    if (!hasFiles) {
      content = processedText;
    } else {
      const parts: ContentPart[] = [];
      if (processedText) {
        parts.push({ type: "text", text: processedText });
      }
      for (const file of message.files) {
        if (file.mediaType && file.url) {
          // Extract base64 data from data URL (format: "data:mediaType;base64,DATA")
          const base64Match = file.url.match(/^data:[^;]+;base64,(.+)$/);
          if (base64Match) {
            parts.push({ type: "image", mediaType: file.mediaType, data: base64Match[1] });
          }
        }
      }
      content = parts;
    }

    if (translateEnabled) {
      const textToTranslate = typeof content === "string"
        ? content
        : content.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("\n");

      if (textToTranslate.trim()) {
        setIsTranslating(true);
        try {
          const result = await translateText(textToTranslate);
          if (result.error) {
            setInput(rawText);
            setPastes(capturedPastes);
            setNextPasteId(capturedNextPasteId);
            toast.error("Translation failed", { description: "Disable translation to send the original text." });
            return;
          }
          if (typeof content === "string") {
            content = result.translatedText;
          } else {
            content = content.map(p =>
              p.type === "text" ? { ...p, text: result.translatedText } : p
            );
          }
        } catch {
          setInput(rawText);
          setPastes(capturedPastes);
          setNextPasteId(capturedNextPasteId);
          toast.error("Translation failed", { description: "Disable translation to send the original text." });
          return;
        } finally {
          setIsTranslating(false);
        }
      }
    }

    if (startedSession) {
      console.log(`[AgentConversation] handleSubmit: using freshly started session ${startedSession.id}`);
      await sendMessage(content, startedSession.id);
    } else {
      console.log(`[AgentConversation] handleSubmit: existing session ${session!.id}, status=${status}`);
      await sendMessage(content);
    }
    } finally {
      setIsSubmitting(false);
    }
  };

  // No project selected
  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Bot className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to start coding</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 h-10 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-2">
          {providers.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={session !== null && messages.length > 0}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted",
                    session !== null && messages.length > 0 && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Bot className={`h-3 w-3 ${agentType === "codex" ? "text-green-500" : "text-violet-500"}`} />
                  {providers.find(p => p.type === agentType)?.displayName ?? (agentType === "codex" ? "Codex" : "Claude Code")}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={agentType}
                  onValueChange={(v) => {
                    const newType = v as AgentType;
                    setAgentType(newType);
                    if (session) {
                      restartSession(newType);
                    }
                  }}
                >
                  {providers.map((p) => (
                    <DropdownMenuRadioItem key={p.type} value={p.type} disabled={!p.available} className="text-xs">
                      <Bot className={`h-3 w-3 ${p.type === "codex" ? "text-green-500" : "text-violet-500"}`} />
                      {p.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Bot className={`h-4 w-4 ${agentType === "codex" ? "text-green-500" : "text-violet-500"}`} />
              <span className="text-sm font-medium">
                {agentType === "codex" ? "Codex" : "Claude Code"}
              </span>
            </>
          )}
          <PermissionModeToggle
            mode={permissionMode}
            onModeChange={handlePermissionModeChange}
            disabled={isLoading}
          />
          {agentTargets.length >= 1 && onAgentModeChange && (
            <ExecutionModeToggle
              targets={agentTargets}
              activeTarget={project?.agent_mode ?? "local"}
              onTargetChange={onAgentModeChange}
            />
          )}
          {session && (() => {
            // For remote sessions, combine frontend WS status with remote WS status
            const isRemote = session.id.startsWith("remote-");
            let statusColor = "text-muted-foreground";
            let statusIcon = <WifiOff className="h-3 w-3" />;
            let statusText = "Disconnected";

            if (!isConnected) {
              // Frontend WS is down — always show disconnected
            } else if (!isRemote || remoteStatus === "connected" || remoteStatus === null) {
              // Local session connected, or remote session fully connected
              statusColor = "text-green-500";
              statusIcon = <Wifi className="h-3 w-3" />;
              statusText = "Connected";
            } else if (remoteStatus === "reconnecting") {
              // Remote link is reconnecting
              statusColor = "text-amber-500";
              statusIcon = <Wifi className="h-3 w-3 animate-pulse" />;
              statusText = "Reconnecting...";
            } else if (remoteStatus === "disconnected") {
              // Remote link gave up
              statusColor = "text-red-500";
              statusIcon = <WifiOff className="h-3 w-3" />;
              statusText = "Remote disconnected";
            }

            return (
              <span className={`flex items-center gap-1 text-xs ${statusColor}`}>
                {statusIcon}
                {statusText}
              </span>
            );
          })()}
        </div>
        {session && (
          <div className="flex items-center gap-1">
            {projectId && (
              <SessionHistoryDropdown
                projectId={projectId}
                branch={branch}
                currentSessionId={session?.id ?? null}
                currentEntryCount={messages.length}
                onSwitch={(id) => {
                  setSessionUrlParam?.(id);
                }}
                onDelete={(id, remaining) => {
                  if (id === session?.id) {
                    // Current was deleted — redirect to most-recent remaining, or clear URL
                    const next = remaining[0];  // remaining is already sorted updated_at DESC
                    setSessionUrlParam?.(next ? next.id : null);
                  }
                }}
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={async () => {
                console.log("[NewConv] click", { liveStatus: status, sessionStatus: session?.status, sessionId: session?.id });
                if (status === "running") {
                  const ok = window.confirm("Current conversation is running. Stop it and start a new conversation?");
                  if (!ok) return;
                }
                const newId = await startNewConversation();
                onNewConversation?.();
                if (newId && setSessionUrlParam) {
                  setSessionUrlParam(newId);
                }
              }}
              disabled={isLoading}
              className="h-7 w-7"
              title="New Conversation"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => stopSession()}
              disabled={session.status !== "running"}
              className="h-7 text-xs"
            >
              <Square className="h-3 w-3 mr-1" />
              Stop
            </Button>
          </div>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 min-h-0 relative">
        <Conversation className="h-full" initial="instant">
          <ConversationContent className="gap-1 p-4">
            {!session && messages.length === 0 ? (
              <div className="text-center py-16">
                {isLoading || (projectId && !isInitialized) ? (
                  <>
                    <Loader className="h-6 w-6 mx-auto mb-4" />
                    <h3 className="text-sm font-semibold mb-1 text-foreground">Connecting to agent...</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Setting up the session for this worktree
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mx-auto w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <Bot className="h-6 w-6 text-primary/60" />
                    </div>
                    <h3 className="text-sm font-semibold mb-1 text-foreground">Start a conversation</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Ask the agent to help you with coding tasks in this worktree
                    </p>
                  </>
                )}
              </div>
            ) : (
              <AgentConversationContext.Provider value={{ sendMessage, messages, acceptPlan: handleAcceptPlan, permissionMode: session?.permissionMode ?? permissionMode, agentType: session?.agentType ?? agentType, sessionId: session?.id ?? null }}>
                <div className="space-y-1" ref={messagesRef}>
                  {messages.map((msg, index) => (
                    <div
                      key={index}
                      data-message-idx={index}
                      {...(msg.type === "user" ? { "data-user-msg-idx": index } : {})}
                    >
                      <AgentMessageItem message={msg} messageIndex={index} />
                    </div>
                  ))}
                  {isLoading && (
                    <div className="flex items-center gap-2 py-4 text-muted-foreground">
                      <Loader className="h-4 w-4" />
                      <span className="text-sm">Connecting to agent...</span>
                    </div>
                  )}
                </div>
              </AgentConversationContext.Provider>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-500 text-sm mt-4">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <UserInputMarkers messages={messages} contentRef={messagesRef} />
        <QuotePopover containerRef={messagesRef} onQuote={handleQuote} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-border/60 p-3">
        <PromptInput
          onSubmit={handleSubmit}
          accept="image/*"
          className="w-full"
        >
          {/* Attachment thumbnails — only rendered when images are attached */}
          <AttachmentHeader />
          <div className="relative flex w-full flex-col">
            {/* Translate badge row — only when enabled */}
            {translateEnabled && (
              <div className="flex items-center pl-12 pr-2 pt-1.5 pb-0.5">
                <button
                  type="button"
                  onClick={() => setTranslateEnabled(false)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2.5 py-0.5 text-xs font-medium hover:bg-blue-500/20 transition-colors"
                >
                  {isTranslating ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />}
                  Translate
                  <X className="size-3" />
                </button>
              </div>
            )}
            {/* Input row: [+ button] [textarea] [submit button] */}
            <div className="flex w-full items-center">
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger className="ml-1" />

                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments label="Add images" />
                  <PromptInputActionMenuItem
                    onSelect={() => {
                      setTranslateEnabled(!translateEnabled);
                    }}
                  >
                    <Languages className="mr-2 size-4" />
                    {translateEnabled ? "Disable translation" : "Translate"}
                  </PromptInputActionMenuItem>
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <div ref={textareaWrapperRef} className="contents">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPasteText={handlePasteText}
                  onKeyDown={inputHistory.handleKeyDown}
                  placeholder={
                    session
                      ? "Ask the agent to help with your code..."
                      : "Type your first message to start..."
                  }
                  className="pr-12"
                />
              </div>
              <PromptInputSubmit
                className="absolute bottom-1 right-1"
                disabled={(!input.trim() && !isLoading) || isTranslating || isSubmitting}
                status={isSubmitting || isTranslating ? "submitted" : isLoading ? "streaming" : "ready"}
              />
            </div>
          </div>
        </PromptInput>
      </div>
    </div>
  );
});
