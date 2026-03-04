"use client";

import { useCallback, useState } from "react";
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
import { useChatSession } from "@/hooks/use-chat-session";
import { MessageSquare, Loader2, Square, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

function getToolLabel(tool: string): string {
  switch (tool) {
    case "getExecutorStatus":
      return "Checking executor status...";
    default:
      return `Running ${tool}...`;
  }
}

interface MainConversationProps {
  projectId: string | null;
  branch: string | null;
}

export function MainConversation({ projectId, branch }: MainConversationProps) {
  const {
    messages,
    status,
    isInitialized,
    isLoading,
    error,
    sendMessage,
    stopGeneration,
  } = useChatSession(projectId, branch);

  const [inputValue, setInputValue] = useState("");

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
          <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Select a project to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium">Main Chat</span>
          {isGenerating && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Messages area */}
      <Conversation className="flex-1 min-h-0" initial="instant">
        <ConversationContent className="gap-4 p-4">
          {isLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && isInitialized && messages.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare className="h-16 w-16 mx-auto mb-4 text-blue-500/30" />
              <h3 className="text-lg font-semibold mb-2">Start a conversation</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Chat with the AI assistant about your project
              </p>
            </div>
          )}

          {messages.map((msg, index) => {
            if (msg.type === "user") {
              return (
                <Message key={index} from="user">
                  <MessageContent>{msg.content}</MessageContent>
                </Message>
              );
            }

            if (msg.type === "assistant") {
              return (
                <Message key={index} from="assistant">
                  <MessageContent>
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
                    <pre className="mt-1 p-2 bg-muted/50 rounded text-xs overflow-x-auto whitespace-pre-wrap">
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
                  className="mx-auto max-w-[90%] rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
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
      <div className="flex-shrink-0 border-t p-4">
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
}
