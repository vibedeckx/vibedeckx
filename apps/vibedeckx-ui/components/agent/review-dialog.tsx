"use client";

import { useEffect, useState } from "react";
import { api, type AgentProviderInfo, type AgentType } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchCheck } from "lucide-react";

const FALLBACK_PROVIDERS: AgentProviderInfo[] = [
  { type: "claude-code", displayName: "Claude Code", available: true },
  { type: "codex", displayName: "Codex", available: true },
];

/**
 * Default reviewer = the first available agent that is NOT the one being
 * reviewed: a different agent gives a more independent second opinion.
 */
export function defaultReviewerAgent(
  providers: AgentProviderInfo[],
  currentAgentType: AgentType | null,
): AgentType {
  const usable = providers.filter((p) => p.available);
  return (
    usable.find((p) => p.type !== currentAgentType)?.type ??
    usable[0]?.type ??
    "claude-code"
  );
}

export function ReviewDialog({
  projectId,
  branch,
  sessionId,
  currentAgentType,
  providers,
}: {
  projectId: string;
  branch: string | null;
  sessionId: string | null;
  currentAgentType?: AgentType | null;
  providers?: AgentProviderInfo[];
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [reviewerAgent, setReviewerAgent] = useState<AgentType>("claude-code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = providers?.length ? providers : FALLBACK_PROVIDERS;

  // Re-derive the default on every open: the source session's agent (and thus
  // the "other" agent) may have changed since the last time the dialog closed.
  useEffect(() => {
    if (open) setReviewerAgent(defaultReviewerAgent(options, currentAgentType ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!sessionId) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
        reviewerAgentType: reviewerAgent,
      });
      setOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="让另一个 agent review 这个 session 的最新成果">
          <SearchCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发起 Review</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          将创建一个 reviewer session 审查本 session 最近完成的工作。反馈会先经你确认，再发回本 session。
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0">Reviewer agent</span>
          <Select value={reviewerAgent} onValueChange={(v) => setReviewerAgent(v as AgentType)}>
            <SelectTrigger className="h-8 text-sm flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((p) => (
                <SelectItem key={p.type} value={p.type} disabled={!p.available}>
                  {p.displayName}
                  {p.type === currentAgentType ? "（当前 agent）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <input
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Review focus（可选）：本次审查重点…"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button onClick={start} disabled={busy}>开始 Review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
