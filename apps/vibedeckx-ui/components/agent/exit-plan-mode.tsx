"use client";

import { useState, useCallback } from "react";
import { useAgentConversation } from "./agent-conversation";
import type { ContentPart } from "@/hooks/use-agent-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { CheckCircle2, Play, MessageSquare, Loader2 } from "lucide-react";

interface ExitPlanModeUIProps {
  input: unknown;
  messageIndex: number;
}

function extractPlanContent(input: unknown, messages: { type: string; content?: string | ContentPart[]; tool?: string; input?: unknown }[], agentType: string): string {
  // 1. Check ExitPlanMode tool input for plan field
  const inputObj = typeof input === "string" ? tryParse(input) : input;
  if (inputObj && typeof inputObj === "object" && "plan" in (inputObj as Record<string, unknown>)) {
    const plan = (inputObj as Record<string, string>).plan;
    if (plan) return plan;
  }

  // 2. Search backwards through messages for Write tool_use with .claude/plans/ path (Claude Code only)
  if (agentType === "claude-code") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "tool_use" && msg.tool === "Write") {
        const writeInput = typeof msg.input === "string" ? tryParse(msg.input) : msg.input;
        if (writeInput && typeof writeInput === "object") {
          const wi = writeInput as Record<string, string>;
          if (wi.file_path?.includes(".claude/plans/") && wi.content) {
            return wi.content;
          }
        }
      }
    }
  }

  // 3. Fallback
  return "Plan written to file";
}

function tryParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function ExitPlanModeUI({ input, messageIndex }: ExitPlanModeUIProps) {
  const { messages, acceptPlan, permissionMode, agentType } = useAgentConversation();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);

  const planContent = extractPlanContent(input, messages, agentType);

  const handleAccept = useCallback(async () => {
    setIsAccepting(true);
    try {
      await acceptPlan(planContent);
      // Keep isAccepting=true — the WebSocket will deliver the user message
      // which makes isResponded=true, switching to "Plan Accepted" badge
    } catch {
      setIsAccepting(false);
    }
  }, [acceptPlan, planContent]);

  // permissionMode flips to "edit" immediately after REST success,
  // before any WebSocket message arrives — use as primary indicator
  const isPlanAccepted = permissionMode === "edit";

  // Forward-scan for user response (handles interleaved error messages from dying process)
  let isResponded = false;
  let respondedText = "";
  for (let i = messageIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.type === "user") {
      isResponded = true;
      const rawContent = msg.content ?? "";
      respondedText = typeof rawContent === "string" ? rawContent : rawContent.filter(p => p.type === "text").map(p => p.text).join("\n");
      break;
    }
  }

  // Plan accepted via button → treat as responded immediately
  if (isPlanAccepted && !isResponded) {
    isResponded = true;
  }

  if (isPlanAccepted || isResponded) {
    return (
      <div className="space-y-2 mt-2">
        {isPlanAccepted ? (
          <Badge variant="default" className="bg-green-600 hover:bg-green-700 text-white">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Plan Accepted
          </Badge>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Feedback sent: {respondedText.length > 100 ? respondedText.substring(0, 100) + "..." : respondedText}</span>
          </div>
        )}
        <details open={!isPlanAccepted}>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            View Plan
          </summary>
          <div className="mt-2 rounded-lg border p-3 bg-muted/30">
            <div
              className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
              style={{ fontSize: "var(--conv-font-size, 14px)" }}
            >
              <MessageResponse>{planContent}</MessageResponse>
            </div>
          </div>
        </details>
      </div>
    );
  }

  // Interactive state: not yet responded
  return (
    <div className="space-y-3 mt-2">
      {/* Plan content */}
      <div className="rounded-lg border p-3 bg-card">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs text-muted-foreground cursor-pointer hover:text-foreground mb-2 block"
        >
          {isExpanded ? "Collapse" : "Expand"} Plan
        </button>
        {isExpanded && (
          <div
            className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words max-h-96 overflow-y-auto"
            style={{ fontSize: "var(--conv-font-size, 14px)" }}
          >
            <MessageResponse>{planContent}</MessageResponse>
          </div>
        )}
      </div>

      {/* Accept button only - feedback goes through the normal conversation input */}
      <Button
        onClick={handleAccept}
        disabled={isAccepting}
        className="bg-green-600 hover:bg-green-700 text-white"
        size="sm"
      >
        {isAccepting ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5 mr-1.5" />
        )}
        {isAccepting ? "Accepting Plan..." : "Accept Plan & Start Editing"}
      </Button>
    </div>
  );
}
