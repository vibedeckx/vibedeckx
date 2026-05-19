"use client";

import { useState, useCallback } from "react";
import { useAgentConversation } from "./agent-conversation";
import { sendApprovalResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Terminal, FileText } from "lucide-react";

interface CommandApprovalUIProps {
  requestId: string;
  command?: string;
  cwd?: string;
  messageIndex: number;
}

export function CommandApprovalUI({ requestId, command, cwd, messageIndex }: CommandApprovalUIProps) {
  const { messages, sessionId } = useAgentConversation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [decision, setDecision] = useState<string | null>(null);

  // Forward-scan for user response (same pattern as AskUserQuestion)
  let isResponded = false;
  for (let i = messageIndex + 1; i < messages.length; i++) {
    if (messages[i]?.type === "user") {
      isResponded = true;
      break;
    }
  }

  // Also treat local decision as responded
  if (decision) isResponded = true;

  const handleDecision = useCallback(async (d: "accept" | "decline") => {
    if (!sessionId) return;
    setIsSubmitting(true);
    setDecision(d);
    try {
      await sendApprovalResponse(sessionId, requestId, d);
    } catch {
      setDecision(null);
      setIsSubmitting(false);
    }
  }, [sessionId, requestId]);

  if (isResponded) {
    return (
      <div className="space-y-2 mt-2">
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Command</span>
          </div>
          <pre
            className="bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            {command || "(empty)"}
          </pre>
          {cwd && (
            <p className="text-xs text-muted-foreground mt-1">cwd: {cwd}</p>
          )}
        </div>
        <Badge
          variant="default"
          className={decision === "decline" ? "bg-red-600 hover:bg-red-700 text-white" : "bg-green-600 hover:bg-green-700 text-white"}
        >
          <CheckCircle2 className="h-3 w-3 mr-1" />
          {decision === "decline" ? "Denied" : "Allowed"}
        </Badge>
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-2">
      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Command</span>
        </div>
        <pre
          className="bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {command || "(empty)"}
        </pre>
        {cwd && (
          <p className="text-xs text-muted-foreground mt-1">cwd: {cwd}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => handleDecision("accept")}
          disabled={isSubmitting}
          className="bg-green-600 hover:bg-green-700 text-white"
          size="sm"
        >
          {isSubmitting && decision === "accept" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          )}
          Allow
        </Button>
        <Button
          onClick={() => handleDecision("decline")}
          disabled={isSubmitting}
          variant="destructive"
          size="sm"
        >
          {isSubmitting && decision === "decline" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mr-1" />
          )}
          Deny
        </Button>
      </div>
    </div>
  );
}

interface FileChangeApprovalUIProps {
  requestId: string;
  changes?: Array<{ path: string; diff?: string; kind: string }>;
  messageIndex: number;
}

function kindBadgeColor(kind: string): string {
  switch (kind) {
    case "added": case "add": return "bg-green-500/10 text-green-600";
    case "deleted": case "delete": return "bg-red-500/10 text-red-600";
    default: return "bg-blue-500/10 text-blue-600";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "added": case "add": return "added";
    case "deleted": case "delete": return "deleted";
    default: return "modified";
  }
}

export function FileChangeApprovalUI({ requestId, changes, messageIndex }: FileChangeApprovalUIProps) {
  const { messages, sessionId } = useAgentConversation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [decision, setDecision] = useState<string | null>(null);

  let isResponded = false;
  for (let i = messageIndex + 1; i < messages.length; i++) {
    if (messages[i]?.type === "user") {
      isResponded = true;
      break;
    }
  }
  if (decision) isResponded = true;

  const handleDecision = useCallback(async (d: "accept" | "decline") => {
    if (!sessionId) return;
    setIsSubmitting(true);
    setDecision(d);
    try {
      await sendApprovalResponse(sessionId, requestId, d);
    } catch {
      setDecision(null);
      setIsSubmitting(false);
    }
  }, [sessionId, requestId]);

  const fileList = changes ?? [];

  const renderChanges = () => (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
      {fileList.length === 0 ? (
        <p className="text-xs text-muted-foreground">No file changes</p>
      ) : (
        fileList.map((change, i) => (
          <div key={i}>
            <div className="flex items-center gap-2">
              <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              <code className="text-xs break-all">{change.path}</code>
              <Badge variant="secondary" className={`text-[10px] ${kindBadgeColor(change.kind)}`}>
                {kindLabel(change.kind)}
              </Badge>
            </div>
            {change.diff && (
              <details className="mt-1">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  View diff
                </summary>
                <pre
                  className="mt-1 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
                  style={{ fontSize: "var(--conv-font-size, 12px)" }}
                >
                  {change.diff.split("\n").map((line, li) => {
                    let className = "";
                    if (line.startsWith("+")) className = "bg-green-500/10 text-green-700 dark:text-green-400";
                    else if (line.startsWith("-")) className = "bg-red-500/10 text-red-700 dark:text-red-400";
                    return <div key={li} className={className}>{line}</div>;
                  })}
                </pre>
              </details>
            )}
          </div>
        ))
      )}
    </div>
  );

  if (isResponded) {
    return (
      <div className="space-y-2 mt-2">
        {renderChanges()}
        <Badge
          variant="default"
          className={decision === "decline" ? "bg-red-600 hover:bg-red-700 text-white" : "bg-green-600 hover:bg-green-700 text-white"}
        >
          <CheckCircle2 className="h-3 w-3 mr-1" />
          {decision === "decline" ? "Denied" : "Allowed"}
        </Badge>
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-2">
      {renderChanges()}
      <div className="flex gap-2">
        <Button
          onClick={() => handleDecision("accept")}
          disabled={isSubmitting}
          className="bg-green-600 hover:bg-green-700 text-white"
          size="sm"
        >
          {isSubmitting && decision === "accept" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          )}
          Allow
        </Button>
        <Button
          onClick={() => handleDecision("decline")}
          disabled={isSubmitting}
          variant="destructive"
          size="sm"
        >
          {isSubmitting && decision === "decline" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mr-1" />
          )}
          Deny
        </Button>
      </div>
    </div>
  );
}
