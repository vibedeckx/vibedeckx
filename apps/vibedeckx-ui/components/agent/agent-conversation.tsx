"use client";

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, createContext, useContext } from "react";
import { useAgentSession } from "@/hooks/use-agent-session";
import type { AgentMessage, ContentPart } from "@/hooks/use-agent-session";
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
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Bot, Square, AlertCircle, Wifi, WifiOff, RotateCcw, Monitor, Cloud } from "lucide-react";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import { PermissionModeToggle } from "@/components/ui/permission-mode-toggle";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type { Project, ExecutionMode, AgentType, AgentProviderInfo } from "@/lib/api";
import { getAgentProviders } from "@/lib/api";

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
  project?: Project | null;
  onAgentModeChange?: (mode: ExecutionMode) => void;
  onTaskCompleted?: () => void;
  onSessionStarted?: () => void;
  onStatusChange?: () => void;
}

export interface AgentConversationHandle {
  submitMessage: (content: string) => Promise<void>;
}

export const AgentConversation = forwardRef<AgentConversationHandle, AgentConversationProps>(
  function AgentConversation({ projectId, branch, project, onAgentModeChange, onTaskCompleted, onSessionStarted, onStatusChange }, ref) {
  const [input, setInput] = useState("");
  const [permissionMode, setPermissionMode] = useState<"plan" | "edit">("edit");
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
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
    stopSession,
    restartSession,
    switchMode,
    acceptPlan,
  } = useAgentSession(projectId, branch, project?.agent_mode, agentType, { onTaskCompleted, onSessionStarted });

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

  // Notify parent when agent starts working (status "running" + user has sent messages).
  // Skips auto-started idle sessions that have no messages yet.
  const prevWorkingRef = useRef(false);
  useEffect(() => {
    const isWorking = status === "running" && messages.length > 0;
    if (isWorking && !prevWorkingRef.current) {
      onStatusChange?.();
    }
    prevWorkingRef.current = isWorking;
  }, [status, messages.length, onStatusChange]);

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

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    const hasFiles = message.files.length > 0;
    if (!text && !hasFiles) return;

    setInput("");

    // Build content: plain string when no files, ContentPart[] when files are attached
    let content: string | ContentPart[];
    if (!hasFiles) {
      content = text;
    } else {
      const parts: ContentPart[] = [];
      if (text) {
        parts.push({ type: "text", text });
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

    if (!session || status !== "running") {
      console.log(`[AgentConversation] handleSubmit: no session or not running (session=${session?.id}, status=${status}), starting new session...`);
      onStatusChange?.();
      const newSession = await startSession(permissionMode);
      console.log(`[AgentConversation] handleSubmit: startSession returned`, newSession?.id ?? 'null');
      if (newSession) {
        sendMessage(content, newSession.id);
      }
    } else {
      console.log(`[AgentConversation] handleSubmit: existing session ${session.id}, status=${status}`);
      sendMessage(content);
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
          <Bot className={`h-4 w-4 ${agentType === "codex" ? "text-green-500" : "text-violet-500"}`} />
          {providers.length > 1 ? (
            <select
              className="text-sm font-medium bg-transparent border border-border rounded px-1.5 py-0.5 outline-none"
              value={agentType}
              onChange={(e) => {
                const newType = e.target.value as AgentType;
                setAgentType(newType);
                if (session) {
                  restartSession(newType);
                }
              }}
              disabled={session !== null && messages.length > 0}
            >
              {providers.map((p) => (
                <option key={p.type} value={p.type} disabled={!p.available}>
                  {p.displayName}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-medium">
              {agentType === "codex" ? "Codex" : "Claude Code"}
            </span>
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => restartSession()}
              disabled={isLoading}
              className="h-7 w-7"
              title="New Conversation"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            {session.status === "running" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => stopSession()}
                className="h-7 text-xs"
              >
                <Square className="h-3 w-3 mr-1" />
                Stop
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Messages area */}
      <Conversation className="flex-1 min-h-0" initial="instant">
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
              <div className="space-y-1">
                {messages.map((msg, index) => (
                  <AgentMessageItem key={index} message={msg} messageIndex={index} />
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

      {/* Input area */}
      <div className="flex-shrink-0 border-t p-4">
        <PromptInput
          onSubmit={handleSubmit}
          accept="image/*"
          className="w-full"
        >
          {/* Attachment thumbnails — only rendered when images are attached */}
          <AttachmentHeader />
          {/* Single row: [+ button] [textarea] [submit button] */}
          <div className="relative flex w-full items-start">
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger className="mt-2.5 ml-1" />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments label="Add images" />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                session
                  ? "Ask the agent to help with your code..."
                  : "Type your first message to start..."
              }
              className="pr-12"
            />
            <PromptInputSubmit
              className="absolute bottom-1 right-1"
              disabled={!input.trim() && !isLoading}
              status={isLoading ? "streaming" : "ready"}
            />
          </div>
        </PromptInput>
      </div>
    </div>
  );
});
