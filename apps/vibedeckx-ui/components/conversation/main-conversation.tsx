"use client";

import { useCallback, useEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle, type RefObject } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { useChatSession, type AgentMessage } from "@/hooks/use-chat-session";
import { TaskPlanCard, readPlanResult } from "./task-plan-card";
import { COMMANDER_STALLED_PREFIX, PLAN_CONTINUATION_PREFIX, PLAN_STALLED_PREFIX, TaskPlanPanel, collectTaskPlans } from "./task-plan-panel";
import { ToolApprovalCard } from "./tool-approval-card";
import { ReviewRunPanel } from "./review-run-panel";
import { NewLoopDialog } from "./new-loop-dialog";
import { useConversationSettings } from "@/hooks/use-conversation-settings";
import { useCommands } from "@/hooks/use-commands";
import { useFocusRegion } from "@/components/locate/focus-region";
import { CommandsMenu } from "@/components/commands/commands-menu";
import { MessageSquare, Loader2, Square, Search, Radio, SquarePen, TriangleAlert, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ExecutorProcessRequestError, type ExecutorDelivery, type WorkflowRun } from "@/lib/api";
import { useExecutorDeliveries } from "@/hooks/use-executor-deliveries";
import { ExecutorDeliveryNotice } from "@/components/executor/executor-delivery-notice";
import { toast } from "sonner";

/**
 * Re-engage stick-to-bottom when programmatic messages (executor events) arrive.
 *
 * The use-stick-to-bottom library's ResizeObserver path uses
 * `preserveScrollPosition: true`, which silently no-ops if the internal
 * `isAtBottom` flag has already been flipped to false (a tall executor-event
 * message exceeds the 70px nearBottom threshold and the lib gives up). We
 * detect newly-added executor events here and force a re-stick.
 */
function ExecutorEventReStick({ messages }: { messages: AgentMessage[] }) {
  const { scrollToBottom } = useStickToBottomContext();
  const prevLengthRef = useRef(messages.length);

  useEffect(() => {
    const prev = prevLengthRef.current;
    prevLengthRef.current = messages.length;
    if (messages.length <= prev) return;

    for (let i = prev; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === "user" && msg.content.startsWith("[Executor Event:")) {
        scrollToBottom({ animation: "instant" });
        return;
      }
    }
  }, [messages, scrollToBottom]);

  return null;
}

/**
 * Whether `text` fits on one line of the textarea's content box. A placeholder
 * that wraps grows the auto-sized textarea to two lines, so narrow panels fall
 * back to a shorter one. Measured against the textarea's own font, so it
 * tracks the conversation font-size setting as well as the panel width.
 */
function useFitsOnOneLine(ref: RefObject<HTMLTextAreaElement | null>, text: string): boolean {
  const [fits, setFits] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const measure = () => {
      const style = getComputedStyle(el);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setFits(ctx.measureText(text).width <= available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, text]);

  return fits;
}

function getToolLabel(tool: string): string {
  switch (tool) {
    case "getExecutorStatus":
      return "Checking executor status...";
    case "getAgentConversation":
      return "Checking agent conversation...";
    case "listTerminals":
      return "Listing terminals...";
    case "runInTerminal":
      return "Sending command to terminal...";
    case "spawnAgentSession":
      return "Starting a coding agent...";
    case "sendToAgentSession":
      return "Sending a message to the agent...";
    default:
      return `Running ${tool}...`;
  }
}

export interface MainConversationHandle {
  sendMessage: (text: string) => Promise<void>;
}

interface MainConversationProps {
  projectId: string | null;
  branch: string | null;
}

export const MainConversation = forwardRef<MainConversationHandle, MainConversationProps>(function MainConversation({ projectId, branch }, ref) {
  const {
    session,
    messages,
    status,
    isInitialized,
    isLoading,
    error,
    sendMessage,
    stopGeneration,
    restartSession,
    workflowRunUpdate,
    turnState,
    streamEpoch,
    draft,
    setDraft,
    setEventListening,
  } = useChatSession(projectId, branch);

  const { settings: convSettings } = useConversationSettings();
  const { region: focusRegion } = useFocusRegion();
  const { commands, createCommand, updateCommand, deleteCommand } = useCommands(projectId, branch);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeRuns, setActiveRuns] = useState<WorkflowRun[]>([]);
  const taskPlans = useMemo(() => collectTaskPlans(messages), [messages]);

  useImperativeHandle(ref, () => ({
    sendMessage: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await sendMessage(trimmed);
    },
  }), [sendMessage]);

  // Draft and the listening flag live in the chat store, not here: this
  // component is keyed on the workspace and remounts on switch, and neither
  // may be lost (draft) or reset to a guess (flag) when that happens.
  const eventListeningEnabled = session?.eventListeningEnabled ?? false;

  const isGenerating = status === "running";
  // Between replies, still on the task: results (or your answer) are owed. You
  // can speak into it — your message joins the same task — or stop it.
  const isWaiting = status === "waiting";

  // [full, short] — the short form is used when the full one would wrap.
  const [fullPlaceholder, shortPlaceholder] = !isInitialized
    ? ["Connecting...", "Connecting..."]
    : isGenerating
      ? ["Waiting for response...", "Waiting for response..."]
      : isWaiting
        ? ["Still on it — add to the task...", "Add to the task..."]
        : ["Type a message, / for commands...", "Type a message..."];
  const fitsFullPlaceholder = useFitsOnOneLine(textareaRef, fullPlaceholder);

  // Remote starts of this workspace whose request was lost: the hub is
  // re-delivering them (or gave up). Shown here because a Main Chat run is
  // otherwise just "waiting", with no word on why or what the user can do.
  const deliveries = useExecutorDeliveries(projectId);
  const branchDeliveries = useMemo(
    () => [...deliveries.values()].filter((delivery) => (delivery.branch ?? null) === (branch ?? null)),
    [deliveries, branch],
  );
  const retryDelivery = useCallback(async (delivery: ExecutorDelivery) => {
    try {
      // "Retry now" names the start it retries; "Run again" (after a give-up) is a fresh start.
      await api.startExecutor(delivery.executorId, delivery.remoteServerId, delivery.state === "retrying" ? delivery.processId : undefined);
    } catch (e) {
      // Still undelivered: the notice keeps showing the retry.
      if (e instanceof ExecutorProcessRequestError && e.body.code === "start_unknown" && e.body.retrying) return;
      if (e instanceof ExecutorProcessRequestError && e.body.code === "retry_ended") {
        toast.info("Already settled", { description: e.message });
        return;
      }
      toast.error("Executor not started", { description: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const handleSubmit = useCallback(
    async (message: { text: string }) => {
      const text = message.text.trim();
      if (!text) return;
      setDraft("");
      await sendMessage(text);
    },
    [sendMessage, setDraft]
  );

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <MessageSquare className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col min-h-0"
      style={{ "--conv-font-size": `${convSettings.chatFontSize}px` } as React.CSSProperties}
    >
      {/* Tab bar — the same row as the right panel's tab bar, so both panels'
          two header rows line up. A single tab is the panel's title, not a
          switch: no hover, no click. Its underline follows the focus region
          the same way the right panel's does. */}
      <div className="flex-shrink-0 flex items-center px-3 gap-4 border-b border-border">
        <span
          className={`flex items-center gap-0.5 py-2.5 text-xs font-medium border-b-2 text-foreground ${
            focusRegion === "default" ? "border-primary" : "border-foreground/25"
          }`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Main Chat
        </span>
      </div>

      {/* Toolbar — matches the h-10 toolbar every right-panel tab carries */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 h-10 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {isGenerating && (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-primary/60" />
              Working…
            </>
          )}
          {isWaiting && (
            <>
              <Hourglass className="h-3 w-3 text-primary/60" aria-label="Waiting for results" />
              Waiting for results
            </>
          )}
        </div>
        {session && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={async () => {
                try {
                  await setEventListening(!eventListeningEnabled);
                } catch {
                  toast.error("Failed to toggle event listening");
                }
              }}
              className={`h-7 w-7 ${eventListeningEnabled ? "text-amber-500" : ""}`}
              title={eventListeningEnabled ? "Listening to events from runs Commander did not start (click to disable)" : "Also listen to events from runs Commander did not start (click to enable)"}
            >
              <Radio className="h-3.5 w-3.5" />
            </Button>
            <NewLoopDialog
              projectId={projectId}
              branch={branch}
              disabled={activeRuns.some((r) => r.kind === "repeat")}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => restartSession()}
              disabled={isGenerating}
              className="h-7 w-7"
              title="New Conversation"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <ReviewRunPanel
        projectId={projectId}
        branch={branch}
        runUpdate={workflowRunUpdate}
        streamEpoch={streamEpoch}
        onRunsChange={setActiveRuns}
      />

      {/* Messages area */}
      <Conversation className="flex-1 min-h-0" initial="instant">
        <ExecutorEventReStick messages={messages} />
        <ConversationContent className="gap-4 p-4">
          {isLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && isInitialized && messages.length === 0 && (
            <div className="text-center py-16">
              <div className="mx-auto w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <MessageSquare className="h-6 w-6 text-primary/60" />
              </div>
              <h3 className="text-sm font-semibold mb-1 text-foreground">Start a conversation</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Chat with the AI assistant about your project
              </p>
            </div>
          )}

          {messages.map((msg, index) => {
            // Turn boundary — the backend pushes one after every stream
            // finalizes (see sendMessage's finally in chat-session-manager),
            // so a divider here marks where each turn ended, including the
            // most recent one at the bottom.
            if (msg.type === "turn_end") {
              return (
                <div key={index} className="mx-4 my-3 flex items-center gap-2" aria-hidden>
                  <div className="h-px flex-1 bg-border" />
                  <div className="h-1 w-1 shrink-0 rounded-full bg-border" />
                  <div className="h-px flex-1 bg-border" />
                </div>
              );
            }

            // System-injected watchdog correction — render as a distinct
            // warning row, not a plain user bubble, so it's obvious this came
            // from the system, not the user.
            if (msg.type === "user" && (msg.content.startsWith("[System Invariant Violation]") || msg.content.startsWith(PLAN_CONTINUATION_PREFIX))) {
              const continuation = msg.content.startsWith(PLAN_CONTINUATION_PREFIX);
              const body = msg.content.replace(/^\[(System Invariant Violation|Plan Continuation)\]\n?/, "");
              return (
                <div
                  key={index}
                  className="mx-4 my-2 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      {continuation ? "Plan continuation" : "System invariant correction"}
                    </div>
                    <div
                      className="mt-0.5 whitespace-pre-wrap text-muted-foreground"
                      style={{ fontSize: "var(--conv-font-size, 12px)" }}
                    >
                      {body}
                    </div>
                  </div>
                </div>
              );
            }

            if (msg.type === "user") {
              const evt = msg.event;
              const sessionBusy = evt?.kind === "agent_task_completed" && activeRuns.some(
                (r) => r.source_session_id === evt.sessionId || r.reviewer_session_id === evt.sessionId,
              );
              return (
                <div key={index}>
                  <Message from="user">
                    <MessageContent style={{ fontSize: "var(--conv-font-size, 14px)" }}>
                      {msg.content}
                    </MessageContent>
                  </Message>
                  {evt?.kind === "agent_task_completed" && (
                    <div className="mt-1 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={sessionBusy}
                        title={sessionBusy ? "该 session 已在一个进行中的 review 里" : undefined}
                        onClick={async () => {
                          if (!projectId) return;
                          try {
                            await api.createWorkflowRun({
                              projectId,
                              branch,
                              sourceSessionId: evt.sessionId,
                              sourceTurnEndIndex: evt.turnEndEntryIndex,
                            });
                          } catch (e) {
                            alert(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        Review
                      </Button>
                    </div>
                  )}
                </div>
              );
            }

            if (msg.type === "assistant") {
              return (
                <Message key={index} from="assistant">
                  <MessageContent style={{ fontSize: "var(--conv-font-size, 14px)" }}>
                    <MessageResponse>{msg.content}</MessageResponse>
                  </MessageContent>
                </Message>
              );
            }

            if (msg.type === "tool_use") {
              if (msg.tool === "setPlan") return null;
              return (
                <div key={index} className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                  <Search className="w-3.5 h-3.5 animate-pulse" />
                  <span>{getToolLabel(msg.tool)}</span>
                </div>
              );
            }

            if (msg.type === "tool_result") {
              if (msg.tool === "setPlan") {
                const original = readPlanResult(msg.output);
                if (original?.planId) {
                  if (taskPlans.current?.plan.planId === original.planId) return null;
                  const saved = taskPlans.history.get(original.planId);
                  if (!saved || saved.firstIndex !== index) return null;
                  return <div key={index} className="mx-4 my-2"><TaskPlanCard plan={saved.plan} /></div>;
                }
              }
              return (
                <div key={index} className="px-4 py-2">
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">
                      Tool result
                    </summary>
                    <pre
                      className="mt-1 p-2 bg-muted/50 rounded overflow-x-auto whitespace-pre-wrap"
                      style={{ fontSize: "var(--conv-font-size, 12px)" }}
                    >
                      {msg.output}
                    </pre>
                  </details>
                </div>
              );
            }

            if (msg.type === "tool_approval_request") {
              if (msg.tool === "setPlan" && (
                msg.resolved === "approved" || taskPlans.current?.approval?.approvalId === msg.approvalId
              )) return null;
              if (!session) return null;
              return (
                <ToolApprovalCard
                  key={index}
                  sessionId={session.id}
                  approvalId={msg.approvalId}
                  tool={msg.tool}
                  input={msg.input}
                  resolved={msg.resolved}
                />
              );
            }

            if (msg.type === "system" && (msg.content.startsWith(PLAN_STALLED_PREFIX) || msg.content.startsWith(COMMANDER_STALLED_PREFIX))) {
              const prefix = msg.content.startsWith(PLAN_STALLED_PREFIX) ? PLAN_STALLED_PREFIX : COMMANDER_STALLED_PREFIX;
              return (
                <div
                  key={index}
                  className="mx-4 my-2 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400">{prefix === PLAN_STALLED_PREFIX ? "Plan stalled" : "Commander stalled"}</div>
                    <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground" style={{ fontSize: "var(--conv-font-size, 12px)" }}>
                      {msg.content.slice(prefix.length).trim()}
                    </div>
                  </div>
                </div>
              );
            }

            if (msg.type === "error") {
              return (
                <div
                  key={index}
                  className="mx-auto max-w-[90%] rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-destructive"
                  style={{ fontSize: "var(--conv-font-size, 14px)" }}
                >
                  {msg.message}
                </div>
              );
            }

            return null;
          })}

          {error && (
            <div className="mx-auto max-w-[90%] rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input area */}
      {/* Horizontal padding mirrors the message list so the composer lines up
          with the conversation content: the scroller carries an inline
          `scrollbar-gutter: stable both-edges` (set by use-stick-to-bottom,
          not overridable from a class) reserving 6px per side, plus the
          content's own p-4 — 22px per side. */}
      <div className="flex-shrink-0 py-3 px-[22px]">
        {branchDeliveries.map((delivery) => (
          <ExecutorDeliveryNotice
            key={delivery.processId}
            delivery={delivery}
            showExecutorName
            onRetry={() => retryDelivery(delivery)}
            className="mb-2"
          />
        ))}
        {isWaiting && turnState.waitingFor.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="turn-waiting-for">
            <Hourglass className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Waiting for {turnState.waitingFor.join(", ")}</span>
          </div>
        )}
        {taskPlans.current && session && (
          <TaskPlanPanel key={taskPlans.current.key} task={taskPlans.current} sessionId={session.id} />
        )}
        <PromptInput
          onSubmit={handleSubmit}
          className="w-full"
        >
          {/* Input row: [commands button] [textarea] [submit button]. A size
              container so the commands button can show its label only when
              the panel is wide enough. */}
          <div className="@container flex w-full items-center">
            <CommandsMenu
              commands={commands}
              open={commandsOpen}
              onOpenChange={setCommandsOpen}
              disabled={!isInitialized || isGenerating}
              onExecute={(content) => { void sendMessage(content); }}
              onCreate={createCommand}
              onUpdate={updateCommand}
              onDelete={deleteCommand}
              onCloseFocus={() => textareaRef.current?.focus()}
            />
            <PromptInputTextarea
              ref={textareaRef}
              disabled={!isInitialized || isGenerating}
              placeholder={fitsFullPlaceholder ? fullPlaceholder : shortPlaceholder}
              className="pr-12"
              style={{ fontSize: "var(--conv-font-size, 14px)" }}
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                // "/" in an empty draft opens the commands menu instead of typing.
                if (e.key === "/" && draft === "" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  setCommandsOpen(true);
                }
              }}
            />
          </div>
          {/* Wrapper height = one textarea line (1lh must match the
              textarea's font classes; 1.5rem = its py-3): centered on a
              single line, hugs the last line when multiline */}
          <div
            className="pointer-events-none absolute bottom-0 right-2 flex items-center text-base md:text-sm"
            style={{
              fontSize: "var(--conv-font-size, 14px)",
              height: "calc(1lh + 1.5rem)",
            }}
          >
            {/* While a turn runs the submit button doubles as Stop. A waiting
                turn still accepts additions, so typed text flips it back to
                Send. */}
            {isGenerating || (isWaiting && !draft.trim()) ? (
              <PromptInputSubmit
                className="pointer-events-auto"
                type="button"
                aria-label={isGenerating ? "Stop generating" : "Stop"}
                title={isGenerating ? "Stop generating" : "Stop"}
                onClick={stopGeneration}
              >
                <Square className="size-3.5 fill-current" />
              </PromptInputSubmit>
            ) : (
              <PromptInputSubmit
                className="pointer-events-auto"
                disabled={!isInitialized || !draft.trim()}
              />
            )}
          </div>
        </PromptInput>
      </div>
    </div>
  );
});
