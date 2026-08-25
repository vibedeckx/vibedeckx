"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  type AgentProviderInfo,
  type AgentType,
  type ReviewSpan,
  type ReviewerCandidate,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Clock, Info, Loader2, Lock, SearchCheck, Send, TriangleAlert, X } from "lucide-react";

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

const SPAN_HINT: Record<ReviewSpan, string> = {
  this_turn: "Latest turn only — faster, more focused",
  session_start: "Whole session from its start — complete but slower",
};

function formatRelativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Small pill next to a choice title: recommendation / the-only-option warning. */
function ChoiceTag({ tone, children }: { tone: "rec" | "warn"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-px font-mono text-[9.5px] leading-[1.5] font-medium",
        tone === "rec"
          ? "border-primary/25 bg-accent text-accent-foreground"
          : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      {children}
    </span>
  );
}

function ChoiceCard({
  selected, title, meta, onSelect,
}: {
  selected: boolean;
  title: ReactNode;
  meta: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-accent ring-[3px] ring-accent"
          : "bg-card opacity-75 hover:bg-muted hover:opacity-100",
      )}
    >
      <span
        className={cn(
          "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary" : "border-input bg-card",
        )}
      >
        {selected && <span className="size-[5px] rounded-full bg-primary-foreground" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-[12.5px] font-medium">{title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
          {meta}
        </span>
      </span>
    </button>
  );
}

/** Label row above a field: uppercase name on the left, status/optional note on the right. */
function FieldLabel({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold tracking-[0.07em] text-muted-foreground/80 uppercase">
        {children}
      </span>
      <span className="flex-1" />
      {note && <span className="text-[10.5px] text-muted-foreground/80">{note}</span>}
    </div>
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
  // Whether the speculative brief below has come back, so the footer can say
  // whether a "new reviewer" submit still has latency hiding behind it.
  const [briefReady, setBriefReady] = useState(false);
  // Tier-1 pre-generation: kicked off while the dialog is open so the LLM
  // latency hides behind the user filling in the form.
  //
  // `reached` distinguishes the two ways this yields no brief, which the
  // create request treats differently: the server ran the distillation and it
  // produced nothing (don't make it try again), versus the request never got
  // an answer at all — auth, 404, a network drop — in which case the model
  // never ran and the server's own pass is still worth having.
  //
  // Tagged with the identity it was generated for: props can change while the
  // dialog is open (a commander surfacing a freshly spawned session, say), and
  // a brief distilled from another session's conversation must never be
  // submitted as this one's intent.
  type BriefPrefetch = {
    projectId: string;
    sessionId: string;
    result: Promise<{ reached: boolean; brief: string | null }>;
  };
  const briefPrefetchRef = useRef<BriefPrefetch | null>(null);

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
          setCandidateNotice("The last reviewer is no longer available — a new session will be created.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCandidateNotice("Could not load the last reviewer — a new session will be created.");
        }
      })
      .finally(() => {
        if (!cancelled) setCandidateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId, sessionId]);

  // Pre-generate the brief the moment the dialog opens, in parallel with the
  // candidate check. Distillation costs model calls measured in tens of
  // seconds, so anything serial ahead of it lands on the user: waiting for the
  // candidate meant a reuse-default open didn't start distilling until the
  // user picked "new reviewer", and then paid the whole latency behind the
  // submit spinner. An open that ends in reuse spends one speculative call;
  // the server caches by conversation content, so reopening the dialog on the
  // same conversation costs nothing.
  useEffect(() => {
    if (!open) {
      briefPrefetchRef.current = null;
      return;
    }
    if (!sessionId) return;
    const current = briefPrefetchRef.current;
    if (current && current.projectId === projectId && current.sessionId === sessionId) return;
    setBriefReady(false);
    const result: BriefPrefetch["result"] = api
      .generateReviewIntentBrief(projectId, sessionId)
      .then((brief) => ({ reached: true, brief }))
      .catch(() => ({ reached: false, brief: null }));
    briefPrefetchRef.current = { projectId, sessionId, result };
    void result.then(() => {
      if (briefPrefetchRef.current?.result === result) setBriefReady(true);
    });
  }, [open, projectId, sessionId]);

  if (!sessionId) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const reviewer = reviewerMode === "reuse" && candidate?.sessionId
        ? { reviewerSessionId: candidate.sessionId }
        : { reviewerAgentType: reviewerAgent };
      // Usually resolved by now (pre-generated on open); if not, the busy
      // spinner covers the remaining wait. Only the prefetch that belongs to
      // the session being submitted counts.
      const prefetch = briefPrefetchRef.current;
      const usable = "reviewerAgentType" in reviewer
        && prefetch?.projectId === projectId && prefetch?.sessionId === sessionId
        ? prefetch : null;
      const pre = usable ? await usable.result : null;
      // A present field tells the server the client already ran tier-1, so it
      // skips its own pass — "" is how a distillation that produced nothing
      // says so, instead of making the server redo two model calls that just
      // came back empty, on the request the user is waiting on. A prefetch
      // that never reached the server is different: nothing was distilled, so
      // omit the field and let the server try.
      const briefFields = pre?.reached ? { intentBrief: pre.brief ?? "" } : {};
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
        reviewSpan,
        ...reviewer,
        ...briefFields,
      });
      setOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void api.getReviewerCandidate(projectId, sessionId).then((nextCandidate) => {
        setCandidate(nextCandidate);
        if (!nextCandidate?.available || !nextCandidate.sessionId) {
          setReviewerMode("new");
          setCandidateNotice("The last reviewer is no longer available — a new session will be created.");
        }
      }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const canReuse = Boolean(candidate?.available && candidate.sessionId);
  const reuseSelected = reviewerMode === "reuse" && canReuse;
  const agentLabel = (type: AgentType | null | undefined) =>
    options.find((p) => p.type === type)?.displayName ?? type ?? "—";
  const submitDisabled = busy || candidateLoading;
  const footNote = busy
    ? { Icon: Info, text: "Setup continues in the background" }
    : reuseSelected
      ? { Icon: Info, text: "Reuses context — no re-distillation" }
      : briefReady
        ? { Icon: Clock, text: "Intent summary ready" }
        : { Icon: Clock, text: "Preparing intent summary…" };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="让另一个 agent review 这个 session 的最新成果">
          <SearchCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="bg-card gap-0 overflow-hidden p-0 sm:max-w-[520px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitDisabled) {
            e.preventDefault();
            void start();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b bg-secondary px-4 py-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/20 bg-accent text-accent-foreground">
            <SearchCheck className="size-[15px]" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[14.5px] font-semibold tracking-tight">Start Review</DialogTitle>
            <DialogDescription className="mt-0.5 max-w-[40ch] text-[11.5px] leading-snug">
              Another agent reviews this session’s latest work; you confirm the feedback before it returns here.
            </DialogDescription>
          </div>
          <DialogClose className="ml-auto grid size-6 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted hover:text-foreground">
            <X className="size-3.5" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-1">
          {candidateNotice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{candidateNotice}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <FieldLabel
              note={
                candidateLoading
                  ? "Checking last reviewer…"
                  : canReuse
                    ? "Last reviewer still available"
                    : undefined
              }
            >
              Reviewer
            </FieldLabel>
            <div className="grid gap-2" role="radiogroup" aria-label="Reviewer">
              {canReuse && (
                <ChoiceCard
                  selected={reuseSelected}
                  onSelect={() => setReviewerMode("reuse")}
                  title={
                    <>
                      Continue last reviewer
                      <ChoiceTag tone="rec">Recommended</ChoiceTag>
                    </>
                  }
                  meta={
                    <>
                      <span className="truncate">{candidate?.title ?? "Review session"}</span>
                      <span className="text-muted-foreground/60">·</span>
                      <span>{agentLabel(candidate?.agentType)}</span>
                      {typeof candidate?.lastActiveAt === "number" && (
                        <>
                          <span className="text-muted-foreground/60">·</span>
                          <span>{formatRelativeTime(candidate.lastActiveAt)}</span>
                        </>
                      )}
                    </>
                  }
                />
              )}
              <ChoiceCard
                selected={!reuseSelected}
                onSelect={() => setReviewerMode("new")}
                title={
                  <>
                    New reviewer session
                    {candidateNotice && <ChoiceTag tone="warn">Only option</ChoiceTag>}
                  </>
                }
                meta={
                  canReuse ? "Starts fresh, without the last context" : "Independent second opinion, from zero context"
                }
              />
            </div>

            <div className="mt-0.5 flex flex-col gap-2">
              <div className="flex items-center gap-2.5">
                <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">Reviewer agent</span>
                {reuseSelected ? (
                  <span className="flex h-8 flex-1 items-center gap-2 rounded-md border bg-secondary px-2.5 text-xs text-muted-foreground">
                    <span className="truncate">{agentLabel(candidate?.agentType)}</span>
                    <span className="flex-1" />
                    <span className="font-mono text-[10px] text-muted-foreground/70">same as last reviewer</span>
                    <Lock className="size-3 shrink-0" />
                  </span>
                ) : (
                  <Select value={reviewerAgent} onValueChange={(v) => setReviewerAgent(v as AgentType)}>
                    <SelectTrigger size="sm" className="flex-1 text-xs">
                      <SelectValue />
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                        {reviewerAgent === currentAgentType ? "same as current agent" : "differs from current agent"}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((p) => (
                        <SelectItem key={p.type} value={p.type} disabled={!p.available}>
                          {p.displayName}
                          {p.type === currentAgentType ? " (current agent)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">Review scope</span>
                <div className="flex h-8 flex-1 items-center gap-0.5 rounded-lg border bg-secondary p-0.5">
                  {([
                    ["this_turn", "This turn only"],
                    ["session_start", "Whole session"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={reviewSpan === value}
                      onClick={() => setReviewSpan(value)}
                      className={cn(
                        "h-full flex-1 rounded-md px-2 text-[11.5px] whitespace-nowrap transition-colors",
                        reviewSpan === value
                          ? "border bg-card font-medium text-foreground shadow-sm"
                          : "border border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="ml-[102px] font-mono text-[10px] text-muted-foreground/70">{SPAN_HINT[reviewSpan]}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel note="Optional">Review focus</FieldLabel>
            <div className="focus-within:border-ring focus-within:ring-ring/40 flex h-[34px] items-center overflow-hidden rounded-lg border bg-card px-3 transition-[color,box-shadow] focus-within:ring-[3px]">
              <input
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
                placeholder="What to focus on, e.g. is the lock granularity too coarse…"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px]">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0">{error}</span>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-2.5 border-t bg-secondary px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <footNote.Icon className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">{footNote.text}</span>
          </span>
          <span className="flex-1" />
          <DialogClose asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">Cancel</Button>
          </DialogClose>
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={start} disabled={submitDisabled}>
            {busy ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Send className="size-3" />
                Start review
                <kbd className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-[1.4] text-primary-foreground/90">
                  ⌘⏎
                </kbd>
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
