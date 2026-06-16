"use client";

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
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
import { useConversationSettings } from "@/hooks/use-conversation-settings";
import { MessageSquare, Loader2, Square, Search, Radio, SquarePen, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
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
        console.log("[sticky] ExecutorEventReStick FIRED → scrollToBottom(instant)");
        scrollToBottom({ animation: "instant" });
        return;
      }
    }
  }, [messages, scrollToBottom]);

  return null;
}

/**
 * Diagnostic logger for the use-stick-to-bottom library. Captures wheel/scroll/
 * resize events into a ring buffer; when `isAtBottom` flips to false, dumps the
 * recent buffer so we can identify which event broke stick-to-bottom.
 *
 * All logs are prefixed `[sticky]` for easy filtering. Safe to leave on while
 * iterating — overhead is just a few console.log calls per event.
 */
function StickyDiagnostics({ messages }: { messages: AgentMessage[] }) {
  const ctx = useStickToBottomContext();
  const { isAtBottom, scrollRef, contentRef, state } = ctx;

  const ringRef = useRef<string[]>([]);
  const t0Ref = useRef<number>(0);

  const log = useCallback((msg: string) => {
    if (t0Ref.current === 0) t0Ref.current = performance.now();
    const ts = (performance.now() - t0Ref.current).toFixed(1).padStart(8);
    const line = `+${ts}ms ${msg}`;
    ringRef.current.push(line);
    if (ringRef.current.length > 40) ringRef.current.shift();
    console.log("[sticky]", line);
  }, []);

  // Track isAtBottom transitions. Dump ring on true → false.
  const prevIsAtBottomRef = useRef(isAtBottom);
  useEffect(() => {
    const prev = prevIsAtBottomRef.current;
    if (prev === isAtBottom) return;
    prevIsAtBottomRef.current = isAtBottom;

    const snapshot = `isAtBottom: ${prev} → ${isAtBottom}` +
      ` | scrollTop=${state.scrollTop}` +
      ` targetTop=${state.targetScrollTop}` +
      ` diff=${state.scrollDifference?.toFixed?.(1) ?? state.scrollDifference}` +
      ` resizeDiff=${state.resizeDifference}` +
      ` escaped=${state.escapedFromLock}`;
    log(snapshot);
    if (prev === true && isAtBottom === false) {
      console.warn("[sticky] === LOST STICKY ===\n" + ringRef.current.slice(-25).join("\n"));
    }
  }, [isAtBottom, state, log]);

  // Wheel + scroll listeners on the same element the library uses.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      log(`wheel deltaY=${e.deltaY.toFixed(1)} target=<${(e.target as HTMLElement)?.tagName ?? "?"}>`);
    };
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      const dt = el.scrollTop - lastScrollTop;
      const diff = el.scrollHeight - el.scrollTop - el.clientHeight;
      log(`scroll scrollTop=${el.scrollTop} (Δ${dt >= 0 ? "+" : ""}${dt}) scrollH=${el.scrollHeight} clientH=${el.clientHeight} bottomDiff=${diff} resizeDiff=${state.resizeDifference}`);
      lastScrollTop = el.scrollTop;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    log("listeners attached");
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, state, log]);

  // Independent ResizeObserver on the same content element.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let prevH = content.getBoundingClientRect().height;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      log(`resize height ${prevH.toFixed(1)} → ${h.toFixed(1)} (Δ${(h - prevH).toFixed(1)})`);
      prevH = h;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, log]);

  // Snapshot when messages array grows.
  const prevLenRef = useRef(messages.length);
  useEffect(() => {
    const prev = prevLenRef.current;
    if (messages.length === prev) return;
    prevLenRef.current = messages.length;
    const last = messages[messages.length - 1];
    let lastDesc: string;
    if (last?.type === "user" || last?.type === "assistant" || last?.type === "system") {
      lastDesc = `${last.type}[${last.content.slice(0, 50).replace(/\n/g, "\\n")}]`;
    } else {
      lastDesc = `${last?.type ?? "?"}`;
    }
    log(`messages ${prev} → ${messages.length} last=${lastDesc} isAtBottom=${isAtBottom} scrollTop=${state.scrollTop} target=${state.targetScrollTop} diff=${state.scrollDifference?.toFixed?.(1) ?? state.scrollDifference}`);
  }, [messages, isAtBottom, state, log]);

  return null;
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
  } = useChatSession(projectId, branch);

  const { settings: convSettings } = useConversationSettings();

  useImperativeHandle(ref, () => ({
    sendMessage: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await sendMessage(trimmed);
    },
  }), [sendMessage]);

  const [inputValue, setInputValue] = useState("");
  const [eventListeningEnabled, setEventListeningEnabled] = useState(false);

  // Sync button state when backend auto-enables event listening (e.g. via runExecutor tool)
  useEffect(() => {
    if (session?.eventListeningEnabled != null) {
      setEventListeningEnabled(session.eventListeningEnabled);
    }
  }, [session?.eventListeningEnabled]);

  const isGenerating = status === "running";

  const handleSubmit = useCallback(
    async (message: { text: string }) => {
      const text = message.text.trim();
      if (!text) return;
      setInputValue("");
      await sendMessage(text);
    },
    [sendMessage]
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
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 h-10 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-foreground">Main Chat</span>
          {isGenerating && (
            <Loader2 className="h-3 w-3 animate-spin text-primary/60" />
          )}
        </div>
        {session && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={async () => {
                const newVal = !eventListeningEnabled;
                try {
                  await api.setChatEventListening(session.id, newVal);
                  setEventListeningEnabled(newVal);
                } catch {
                  toast.error("Failed to toggle event listening");
                }
              }}
              className={`h-7 w-7 ${eventListeningEnabled ? "text-amber-500" : ""}`}
              title={eventListeningEnabled ? "Listening to executor events (click to disable)" : "Listen to executor events (click to enable)"}
            >
              <Radio className="h-3.5 w-3.5" />
            </Button>
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

      {/* Messages area */}
      <Conversation className="flex-1 min-h-0" initial="instant">
        <ExecutorEventReStick messages={messages} />
        <StickyDiagnostics messages={messages} />
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
            // System-injected watchdog correction — render as a distinct
            // warning row, not a plain user bubble, so it's obvious this came
            // from the system, not the user.
            if (msg.type === "user" && msg.content.startsWith("[System Invariant Violation]")) {
              const body = msg.content.replace(/^\[System Invariant Violation\]\n?/, "");
              return (
                <div
                  key={index}
                  className="mx-4 my-2 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      System invariant correction
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
              return (
                <Message key={index} from="user">
                  <MessageContent style={{ fontSize: "var(--conv-font-size, 14px)" }}>
                    {msg.content}
                  </MessageContent>
                </Message>
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
              return (
                <div key={index} className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                  <Search className="w-3.5 h-3.5 animate-pulse" />
                  <span>{getToolLabel(msg.tool)}</span>
                </div>
              );
            }

            if (msg.type === "tool_result") {
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
      <div className="flex-shrink-0 border-t border-border/60 p-3">
        {isGenerating && (
          <div className="flex justify-center mb-2">
            <Button
              variant="outline"
              size="sm"
              onClick={stopGeneration}
              className="gap-1.5"
            >
              <Square className="h-3 w-3" />
              Stop generating
            </Button>
          </div>
        )}
        <PromptInput
          onSubmit={handleSubmit}
          className="w-full"
        >
          <PromptInputTextarea
            disabled={!isInitialized || isGenerating}
            placeholder={
              !isInitialized
                ? "Connecting..."
                : isGenerating
                  ? "Waiting for response..."
                  : "Type a message..."
            }
            className="pr-12"
            value={inputValue}
            onChange={(e) => setInputValue(e.currentTarget.value)}
          />
          <PromptInputSubmit
            className="absolute bottom-1 right-1"
            disabled={!isInitialized || isGenerating || !inputValue.trim()}
          />
        </PromptInput>
      </div>
    </div>
  );
});
