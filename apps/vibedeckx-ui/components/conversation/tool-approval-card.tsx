"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2, Bot } from "lucide-react";

interface ToolApprovalCardProps {
  sessionId: string;
  approvalId: string;
  tool: string;
  input: unknown;
  resolved?: "approved" | "denied";
}

function extractMessage(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const obj = input as { message?: string; prompt?: string };
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.prompt === "string") return obj.prompt;
  }
  return JSON.stringify(input);
}

export function ToolApprovalCard({
  sessionId,
  approvalId,
  tool,
  input,
  resolved,
}: ToolApprovalCardProps) {
  const [pending, setPending] = useState<null | "approve" | "deny">(null);

  const label =
    tool === "spawnAgentSession"
      ? "Start a new coding agent"
      : "Send to the coding agent";

  const message = extractMessage(input);

  const decide = async (approved: boolean) => {
    if (pending || resolved) return;
    const action = approved ? "approve" : "deny";
    setPending(action);
    try {
      await api.chatToolApproval(sessionId, approvalId, approved);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mx-4 my-1">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Approval needed · {label}
          </span>
        </div>

        <pre
          className="bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all text-foreground/80"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {message}
        </pre>

        {resolved ? (
          <Badge
            variant="default"
            className={
              resolved === "approved"
                ? "bg-green-600 hover:bg-green-700 text-white"
                : "bg-red-600 hover:bg-red-700 text-white"
            }
          >
            {resolved === "approved" ? (
              <CheckCircle2 className="h-3 w-3 mr-1" />
            ) : (
              <XCircle className="h-3 w-3 mr-1" />
            )}
            {resolved === "approved" ? "Approved — sent." : "Denied — not sent."}
          </Badge>
        ) : (
          <div className="flex gap-2">
            <Button
              onClick={() => decide(true)}
              disabled={pending !== null}
              className="bg-green-600 hover:bg-green-700 text-white"
              size="sm"
            >
              {pending === "approve" ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              )}
              Approve
            </Button>
            <Button
              onClick={() => decide(false)}
              disabled={pending !== null}
              variant="destructive"
              size="sm"
            >
              {pending === "deny" ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5 mr-1" />
              )}
              Deny
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
