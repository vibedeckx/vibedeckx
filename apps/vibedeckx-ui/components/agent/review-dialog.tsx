"use client";

import { useEffect, useRef, useState } from "react";
import {
  api,
  type AgentProviderInfo,
  type AgentType,
  type ReviewSpan,
  type ReviewerCandidate,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, SearchCheck } from "lucide-react";

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
  const [reviewSpan, setReviewSpan] = useState<ReviewSpan>("this_turn");
  const [reviewerMode, setReviewerMode] = useState<"reuse" | "new">("new");
  const [candidate, setCandidate] = useState<ReviewerCandidate | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateNotice, setCandidateNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tier-1 pre-generation: kicked off while the dialog is open so the LLM
  // latency hides behind the user filling in the form. Null result = no brief
  // (server degrades to the deterministic excerpt).
  const briefPromiseRef = useRef<Promise<string | null> | null>(null);

  const options = providers?.length ? providers : FALLBACK_PROVIDERS;

  // Re-derive the default on every open: the source session's agent (and thus
  // the "other" agent) may have changed since the last time the dialog closed.
  useEffect(() => {
    if (open) {
      setReviewerAgent(defaultReviewerAgent(options, currentAgentType ?? null));
      setReviewSpan("this_turn");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !sessionId) return;

    let cancelled = false;
    setReviewerMode("new");
    setCandidate(null);
    setCandidateNotice(null);
    setCandidateLoading(true);

    void api.getReviewerCandidate(projectId, sessionId)
      .then((nextCandidate) => {
        if (cancelled) return;
        setCandidate(nextCandidate);
        if (nextCandidate?.available && nextCandidate.sessionId) {
          setReviewerMode("reuse");
        } else if (nextCandidate) {
          setCandidateNotice("上次 reviewer 已不可用，将创建新 session");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCandidateNotice("无法加载上次 reviewer，将创建新 session");
        }
      })
      .finally(() => {
        if (!cancelled) setCandidateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId, sessionId]);

  // Pre-generate the brief once per dialog open, but only when a NEW reviewer
  // is in play (reuse continues the reviewer's own context — no brief). Waits
  // for the candidate check so reuse-default opens don't spend an LLM call.
  useEffect(() => {
    if (!open) {
      briefPromiseRef.current = null;
      return;
    }
    if (!sessionId || candidateLoading || reviewerMode !== "new" || briefPromiseRef.current) return;
    briefPromiseRef.current = api
      .generateReviewIntentBrief(projectId, sessionId)
      .catch(() => null);
  }, [open, candidateLoading, reviewerMode, projectId, sessionId]);

  if (!sessionId) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const reviewer = reviewerMode === "reuse" && candidate?.sessionId
        ? { reviewerSessionId: candidate.sessionId }
        : { reviewerAgentType: reviewerAgent };
      // Usually resolved by now (pre-generated on open); if not, the busy
      // spinner covers the remaining wait. Null → omit the field so the
      // server decides (it retries distillation, which is instant when no
      // chat model is configured).
      const intentBrief = "reviewerAgentType" in reviewer && briefPromiseRef.current
        ? await briefPromiseRef.current
        : null;
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
        reviewSpan,
        ...reviewer,
        ...(intentBrief ? { intentBrief } : {}),
      });
      setOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void api.getReviewerCandidate(projectId, sessionId).then((nextCandidate) => {
        setCandidate(nextCandidate);
        if (!nextCandidate?.available || !nextCandidate.sessionId) {
          setReviewerMode("new");
          setCandidateNotice("上次 reviewer 已不可用，将创建新 session");
        }
      }).catch(() => undefined);
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
          <DialogDescription>
            默认继续上次 reviewer 的上下文，也可以创建新 reviewer session。反馈会先经你确认，再发回本 session。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {candidate?.available && candidate.sessionId && (
            <Button
              type="button"
              variant={reviewerMode === "reuse" ? "secondary" : "outline"}
              className="h-auto justify-start whitespace-normal py-2 text-left"
              aria-pressed={reviewerMode === "reuse"}
              onClick={() => setReviewerMode("reuse")}
            >
              继续上次 Reviewer — {candidate.title ?? "Review session"}
            </Button>
          )}
          <Button
            type="button"
            variant={reviewerMode === "new" ? "secondary" : "outline"}
            className="justify-start"
            aria-pressed={reviewerMode === "new"}
            onClick={() => setReviewerMode("new")}
          >
            创建新 Reviewer Session
          </Button>
        </div>
        {candidateNotice && (
          <p className="text-sm text-amber-600 dark:text-amber-400">{candidateNotice}</p>
        )}
        {reviewerMode === "new" && (
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
        )}
        {reviewerMode === "new" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground shrink-0">审查范围</span>
            <Select value={reviewSpan} onValueChange={(v) => setReviewSpan(v as ReviewSpan)}>
              <SelectTrigger className="h-8 text-sm flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this_turn">仅本次 turn（默认）</SelectItem>
                <SelectItem value="session_start">整个 session（自起点）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <input
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Review focus（可选）：本次审查重点…"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button onClick={start} disabled={busy || candidateLoading}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                正在准备 review 上下文…
              </>
            ) : (
              "开始 Review"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
