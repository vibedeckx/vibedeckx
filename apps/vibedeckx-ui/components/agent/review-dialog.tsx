"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  api,
  type AgentProviderInfo,
  type AgentType,
  type ReviewContextMode,
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
import { hasPriorReview, subscribeReviewedSessions } from "@/lib/workflow-runs-fetch";
import { isMacPlatform } from "@/lib/tab-shortcuts";
import { Clock, Info, Loader2, Lock, SearchCheck, Send, TriangleAlert, X } from "lucide-react";

const noopSubscribe = () => () => {};

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
  selected, title, meta, trailing, onSelect,
}: {
  selected: boolean;
  title: ReactNode;
  /** Second line under the title. Omit it when `trailing` already says it all. */
  meta?: ReactNode;
  /** Right-aligned detail on the title row, for cards that stay one line tall. */
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
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
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium">
          <span className="flex shrink-0 flex-wrap items-center gap-2">{title}</span>
          {trailing && (
            <span className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] font-normal text-muted-foreground">
              {trailing}
            </span>
          )}
        </span>
        {meta && (
          <span className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
            {meta}
          </span>
        )}
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
  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [reviewerAgent, setReviewerAgent] = useState<AgentType>("claude-code");
  const [reviewSpan, setReviewSpan] = useState<ReviewSpan>("this_turn");
  const [contextMode, setContextMode] = useState<ReviewContextMode>("briefed");
  // Selection is DERIVED (default + explicit override), never stored outright:
  // the default depends on an answer that arrives after the first frame, and a
  // stored default would have to be corrected by the late callback — which is
  // both the frame-one jump and, once the user has clicked, a silent override
  // of their choice. `null` = following the default; anything else = the user
  // picked, and nothing may move it. Cleared on close so the next open starts
  // from a clean first frame (resetting it on *open* would be one frame late).
  // Tagged with the session it was made for, exactly like candidateAnswer
  // below: the dialog supports the source session changing underneath it, and
  // a choice made about one session must not silently govern the next.
  const [reviewerModeOverride, setReviewerModeOverride] =
    useState<{ key: string; mode: "reuse" | "new" } | null>(null);
  // The live check's answer, tagged with the project+session it answers for.
  // Tagged rather than cleared, because the effect that would clear it runs a
  // frame *after* the props change: an untagged answer is read during that
  // frame and renders the previous session's reviewer, or hides a card that
  // then jumps in. Reading it through `answer` below makes staleness a
  // render-phase fact instead of an effect's race.
  type CandidateAnswer = {
    key: string;
    candidate: ReviewerCandidate | null;
    notice: string | null;
  };
  const [candidateAnswer, setCandidateAnswer] = useState<CandidateAnswer | null>(null);
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
  // Same identity-tagged shape, for the live candidate check: a submit made
  // before it resolves has to consume this one rather than start a second.
  type CandidateFetch = {
    projectId: string;
    sessionId: string;
    result: Promise<ReviewerCandidate | null>;
  };
  const candidateFetchRef = useRef<CandidateFetch | null>(null);

  // Does a "continue last reviewer" choice exist at all? Rides the branch's
  // workflow-runs poll, so it is already known before the dialog opens —
  // including when a keyboard shortcut opens it, which is why this cannot be a
  // hover prefetch. `undefined` = not known yet, or the remote worker predates
  // the field; that case must behave exactly as it did before this existed.
  //
  // useSyncExternalStore, not a prop: the poll landing does not reliably
  // rerender any ancestor (useReviewerRun's setRun(null) over an already-null
  // state is bailed out by React), so a prop would sit at undefined forever.
  const priorReview = useSyncExternalStore(
    subscribeReviewedSessions,
    () => hasPriorReview(projectId, branch, sessionId),
    () => undefined,
  );

  const skipCandidateCheck = priorReview === false;

  // Identity of the question the dialog is currently asking. An answer tagged
  // with a different key is not this session's answer, so it does not count as
  // settled and none of its details may be rendered.
  const candidateKey = sessionId ? `${projectId}\u0000${sessionId}` : null;
  const answer = candidateAnswer?.key === candidateKey ? candidateAnswer : null;
  const overrideMode = reviewerModeOverride?.key === candidateKey ? reviewerModeOverride.mode : null;
  const candidate = answer?.candidate ?? null;
  const candidateNotice = answer?.notice ?? null;
  // Skipping the check settles the question just as much as asking it does —
  // but only for as long as the skip holds. Derived rather than written as an
  // empty answer, so that the snapshot flipping false → true un-settles it on
  // the same render: a stored `{candidate: null}` would keep reading as a
  // checked "no" and leave New selected and submittable until the newly fired
  // request landed, which is the option jump this change exists to remove.
  const candidateSettled = answer !== null || skipCandidateCheck;
  // "Loading" is exactly the absence of an answer for the key we are asking
  // about. Derived, a session switch reads as loading on the very first frame
  // — before the effect that starts the new request runs.
  const candidateLoading = open && candidateKey !== null && !candidateSettled;

  const options = providers?.length ? providers : FALLBACK_PROVIDERS;

  // Re-derive the default on every open: the source session's agent (and thus
  // the "other" agent) may have changed since the last time the dialog closed.
  useEffect(() => {
    if (open) {
      setReviewerAgent(defaultReviewerAgent(options, currentAgentType ?? null));
      setReviewSpan("this_turn");
      setContextMode("briefed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !sessionId) return;

    // Known to have never been reviewed: there is nothing for the live check
    // to judge, so skip the request outright. This is the common case, and
    // skipping it is what removes both the delayed card and the window where
    // Start sits disabled waiting for an answer of "no".
    const key = `${projectId}\u0000${sessionId}`;
    if (skipCandidateCheck) {
      // Settledness is derived from the skip itself (see candidateSettled), so
      // there is nothing to record — and nothing left behind to go stale when
      // the snapshot later says this session has been reviewed after all.
      candidateFetchRef.current = null;
      return;
    }

    let cancelled = false;
    // Nothing to clear: an answer from a previous open cycle was dropped on
    // close, and one from a different session never counted (see `answer`).
    // So this open starts unsettled, the card is drawn from priorReview alone,
    // and a submit made before the check lands takes the await path in start().

    const result = api.getReviewerCandidate(projectId, sessionId);
    candidateFetchRef.current = { projectId, sessionId, result };
    void result
      .then((nextCandidate) => {
        if (cancelled) return;
        // Deliberately does NOT touch the selection: it is derived from
        // this state, and an explicit user choice outranks it either way.
        const reusable = Boolean(nextCandidate?.available && nextCandidate.sessionId);
        // A null candidate is only *news* if something had promised otherwise.
        // A non-null one always has: it names a last reviewer, just an unusable
        // one. A null one has only if the snapshot predicted a card — which the
        // union can do for a run retention has since reclaimed, and demoting
        // that card without a word is the silent disappearance this change
        // exists to avoid. Read the snapshot live rather than from the closure:
        // it can flip undefined → true while this request is in flight, and an
        // unknown snapshot must not narrate a reviewer that never existed.
        const wasPromised =
          nextCandidate !== null || hasPriorReview(projectId, branch, sessionId) === true;
        setCandidateAnswer({
          key,
          candidate: nextCandidate,
          notice: !reusable && wasPromised
            ? "The last reviewer is no longer available — a new session will be created."
            : null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setCandidateAnswer({
          key,
          candidate: null,
          notice: "Could not load the last reviewer — a new session will be created.",
        });
      });

    return () => {
      cancelled = true;
    };
    // Depends on the skip decision, not on `priorReview` itself: a poll that
    // upgrades undefined → true must not re-run this and duplicate a request
    // that is already in flight. Only false ⇄ not-false changes what we do.
    // `branch` is here because the response callback reads the snapshot for it;
    // re-running on a branch change costs one idempotent GET, and in practice
    // sessionId changes with it and would have re-run this anyway.
  }, [open, projectId, branch, sessionId, skipCandidateCheck]);

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

  // The one way the dialog closes — the programmatic close after a successful
  // start included, which is why start() must not call setOpen directly.
  // Clearing on close rather than on open matters: an override surviving into
  // the next open would be applied to its first rendered frame, before any
  // effect could reset it.
  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setReviewerModeOverride(null);
      // The live answer does not survive the close either. Its two negative
      // verdicts, `running` and `busy`, are ordinary transient states, so an
      // answer from the previous open cycle is not evidence about this one —
      // and counting it as settled both hides a Continue card that has since
      // become available and, worse, lets start() skip the in-flight check and
      // submit a reviewer id we were already told is unusable.
      setCandidateAnswer(null);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Reuse can be selected before the live check lands — that is what
      // replaces the disabled button. Settle it here instead, behind the
      // "Starting…" spinner: same wall clock, but the click is accepted
      // immediately and only the path that actually needs the answer waits.
      let reuseCandidate = candidate;
      if (reviewerMode === "reuse" && !candidateSettled && candidateKey) {
        const pending = candidateFetchRef.current;
        reuseCandidate = pending?.projectId === projectId && pending?.sessionId === sessionId
          ? await pending.result.catch(() => null)
          : null;
        setCandidateAnswer({ key: candidateKey, candidate: reuseCandidate, notice: null });
      }
      if (reviewerMode === "reuse" && !(reuseCandidate?.available && reuseCandidate.sessionId)) {
        // The optimistic guess lost: the reviewer went away, started running,
        // or was taken by another run between the last poll and now. Never
        // silently substitute a fresh reviewer for the one they asked to
        // continue — say so and let them press again.
        if (candidateKey) {
          setCandidateAnswer({
            key: candidateKey,
            candidate: reuseCandidate,
            notice: "The last reviewer is no longer available — a new session will be created.",
          });
        }
        setReviewerModeOverride(candidateKey ? { key: candidateKey, mode: "new" } : null);
        return;
      }
      const reviewer = reviewerMode === "reuse" && reuseCandidate?.sessionId
        ? { reviewerSessionId: reuseCandidate.sessionId }
        : { reviewerAgentType: reviewerAgent };
      // Blind mode applies to fresh reviewers only (a reused reviewer already
      // carries earlier rounds' context; the server rejects the combination).
      const blind = contextMode === "blind" && "reviewerAgentType" in reviewer;
      // Only the prefetch that belongs to the session being submitted counts,
      // and only when it already resolved (briefReady): the server distills in
      // the background after responding, so blocking the submit on an
      // unfinished prefetch would reintroduce the very wait the two-phase
      // start removes. A blind review never uses it: the brief would be
      // discarded server-side anyway.
      const prefetch = briefPrefetchRef.current;
      const usable = !blind && "reviewerAgentType" in reviewer
        && prefetch?.projectId === projectId && prefetch?.sessionId === sessionId
        ? prefetch : null;
      const pre = usable && briefReady ? await usable.result : null;
      // A present field tells the server the client already ran tier-1, so it
      // skips its own pass — "" is how a distillation that produced nothing
      // says so, instead of making the server redo two model calls that just
      // came back empty. An unresolved or failed prefetch is different:
      // nothing was distilled yet, so omit the field and the server distills
      // in the background after it responds.
      const briefFields = pre?.reached ? { intentBrief: pre.brief ?? "" } : {};
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
        reviewSpan,
        ...(blind ? { reviewContextMode: "blind" as const } : {}),
        ...reviewer,
        ...briefFields,
      });
      setDialogOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void api.getReviewerCandidate(projectId, sessionId).then((nextCandidate) => {
        const gone = !nextCandidate?.available || !nextCandidate.sessionId;
        setCandidateAnswer({
          key: `${projectId}\u0000${sessionId}`,
          candidate: nextCandidate,
          notice: gone
            ? "The last reviewer is no longer available — a new session will be created."
            : null,
        });
        if (gone) setReviewerModeOverride(candidateKey ? { key: candidateKey, mode: "new" } : null);
      }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const canReuse = Boolean(candidate?.available && candidate.sessionId);
  // Before the live check lands, `priorReview` stands in for it: a reuse card
  // is only ever drawn when we already know one is coming, so it never
  // promises a choice that then evaporates. Once the check settles, reality
  // governs — including demoting an optimistic card, which is the rare case
  // the amber notice explains.
  const reuseAvailable = candidateSettled ? canReuse : priorReview === true;
  // Normalized against availability, not merely defaulted by it: an override of
  // "reuse" that outlives the card — the user picks Continue while the check is
  // pending and it comes back unavailable — must collapse to "new" rather than
  // leave the mode pointing at a choice that is no longer on screen. Otherwise
  // the New card renders selected while start() still takes the reuse branch
  // and aborts.
  const reviewerMode = reuseAvailable ? (overrideMode ?? "reuse") : "new";
  const reuseSelected = reviewerMode === "reuse";
  // A reused reviewer necessarily carries its existing session context. Keep
  // the row visible so switching reviewer modes does not resize the dialog,
  // but present the only truthful value and disable both choices.
  const displayedContextMode: ReviewContextMode = reuseSelected ? "briefed" : contextMode;
  const agentLabel = (type: AgentType | null | undefined) =>
    options.find((p) => p.type === type)?.displayName ?? type ?? "—";
  // Blocking on the candidate check is only needed when we cannot predict its
  // answer — i.e. `undefined`, where the selection could still flip under the
  // user between reading the dialog and pressing Start. When we do know, the
  // card is already in its final position and a submit inside the check's
  // window is resolved inside start(), behind the spinner.
  const submitDisabled = busy || (candidateLoading && priorReview === undefined);
  const footNote = busy
    ? { Icon: Info, text: "Setup continues in the background" }
    : reuseSelected
      ? { Icon: Info, text: "Reuses context — no re-distillation" }
      : contextMode === "blind"
        ? { Icon: Info, text: "Blind review — no conversation context is sent" }
        : briefReady
          ? { Icon: Clock, text: "Intent summary ready" }
          : { Icon: Clock, text: "Intent summary finishes in the background" };

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="让另一个 agent review 这个 session 的最新成果">
          <SearchCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="bg-card w-[calc(100%-2rem)] min-w-0 gap-0 overflow-hidden p-0 sm:w-full sm:max-w-md"
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

        <div className="min-w-0 flex flex-col gap-3.5 px-4 pt-3.5 pb-1">
          {candidateNotice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{candidateNotice}</span>
            </div>
          )}

          <div className="min-w-0 flex flex-col gap-1.5">
            <FieldLabel
              note={
                candidateLoading
                  ? "Checking last reviewer…"
                  : reuseAvailable
                    ? "Last reviewer still available"
                    : undefined
              }
            >
              Reviewer
            </FieldLabel>
            <div className="grid gap-2" role="radiogroup" aria-label="Reviewer">
              {reuseAvailable && (
                <ChoiceCard
                  selected={reuseSelected}
                  onSelect={() => candidateKey && setReviewerModeOverride({ key: candidateKey, mode: "reuse" })}
                  title="Continue last reviewer"
                  // Who and when ride the title row: they are short, fixed-width
                  // facts that would otherwise waste a line of their own.
                  trailing={
                    candidateSettled && (
                      <>
                        <span className="shrink-0">{agentLabel(candidate?.agentType)}</span>
                        {typeof candidate?.lastActiveAt === "number" && (
                          <>
                            <span className="shrink-0 text-muted-foreground/60">·</span>
                            <span className="shrink-0">{formatRelativeTime(candidate.lastActiveAt)}</span>
                          </>
                        )}
                      </>
                    )
                  }
                  meta={
                    // Which reviewer it is only arrives with the live check. The
                    // second line is held either way, so the card is the same
                    // height before and after the details land.
                    candidateSettled ? (
                      <span className="min-w-0 truncate">{candidate?.title ?? "Review session"}</span>
                    ) : (
                      <span className="text-muted-foreground/60">Loading details…</span>
                    )
                  }
                />
              )}
              <ChoiceCard
                selected={!reuseSelected}
                onSelect={() => candidateKey && setReviewerModeOverride({ key: candidateKey, mode: "new" })}
                title={
                  <>
                    New reviewer session
                    {candidateNotice && <ChoiceTag tone="warn">Only option</ChoiceTag>}
                  </>
                }
                meta={
                  reuseAvailable
                    ? "Starts fresh, without the last context"
                    : "Independent second opinion, from zero context"
                }
              />
            </div>

            <div className="mt-0.5 min-w-0 flex flex-col gap-2">
              <div className="min-w-0 flex items-center gap-2.5">
                <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">Agent</span>
                {reuseSelected ? (
                  <span className="flex h-8 flex-1 items-center gap-2 rounded-md border bg-secondary px-2.5 text-xs text-muted-foreground">
                    <span className="truncate">{candidateSettled ? agentLabel(candidate?.agentType) : "Loading…"}</span>
                    <span className="flex-1" />
                    <span className="font-mono text-[10px] text-muted-foreground/70">same as last reviewer</span>
                    <Lock className="size-3 shrink-0" />
                  </span>
                ) : (
                  <Select value={reviewerAgent} onValueChange={(v) => setReviewerAgent(v as AgentType)}>
                    <SelectTrigger size="sm" className="min-w-0 flex-1 text-xs">
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

              <div className="min-w-0 flex items-center gap-2.5">
                <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">Scope</span>
                <div className="min-w-0 flex h-8 flex-1 items-center gap-0.5 rounded-lg border bg-secondary p-0.5">
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

              <div className="min-w-0 flex items-center gap-2.5">
                <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">Context</span>
                <div className="min-w-0 flex h-8 flex-1 items-center gap-0.5 rounded-lg border bg-secondary p-0.5">
                  {([
                    ["briefed", "With context"],
                    ["blind", "Blind"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={reuseSelected}
                      aria-pressed={displayedContextMode === value}
                      onClick={() => setContextMode(value)}
                      className={cn(
                        "h-full min-w-0 flex-1 rounded-md px-2 text-[11.5px] whitespace-nowrap transition-colors disabled:cursor-not-allowed",
                        displayedContextMode === value
                          ? "border bg-card font-medium text-foreground shadow-sm disabled:text-muted-foreground"
                          : "border border-transparent text-muted-foreground hover:text-foreground disabled:opacity-45",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
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

        <div className="mt-2.5 min-w-0 flex w-full items-center gap-2.5 overflow-hidden border-t bg-secondary px-4 py-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
            <footNote.Icon className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">{footNote.text}</span>
          </span>
          <DialogClose asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">Cancel</Button>
          </DialogClose>
          <Button
            size="sm"
            className="h-7 w-28 gap-1.5 text-xs"
            aria-label="Start"
            onClick={start}
            disabled={submitDisabled}
          >
            {busy ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Send className="size-3" />
                Start
                <kbd
                  className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-[1.4] text-primary-foreground/90"
                  title={isMac ? "Command+Enter" : "Ctrl+Enter"}
                >
                  {isMac ? "⌘⏎" : "Ctrl⏎"}
                </kbd>
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
