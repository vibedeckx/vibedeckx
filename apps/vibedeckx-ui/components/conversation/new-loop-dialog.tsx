"use client";

import { useState, useSyncExternalStore } from "react";
import { GitBranch, Loader2, PencilLine, Repeat, RotateCcw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  REPEAT_LOOP_DEFAULT_ITERATIONS,
  REPEAT_LOOP_DEFAULT_MINUTES,
  REPEAT_LOOP_MAX_ITERATIONS,
  REPEAT_LOOP_MAX_MINUTES,
  type WorkflowRun,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BOX_INPUT,
  CONTROL_INPUT,
  ControlBox,
  FieldLabel,
  HintLine,
  InlineLink,
  Segmented,
  Strip,
} from "@/components/schedule/schedule-form-chrome";
import {
  generateInstruction,
  loadLoopDraft,
  LOOP_PRESETS,
  type LoopPresetKind,
  type LoopPresetMeta,
  presetFieldsForMeta,
  presetFor,
  saveLoopDraft,
} from "@/lib/loop-presets";
import { isMacPlatform } from "@/lib/tab-shortcuts";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

const AGENT_LABELS = { "claude-code": "Claude Code", codex: "Codex" } as const;

/** The hub refused a start because this machine's worker predates the feature (api.ts `WorkflowRequestError`). */
function isWorkerUnsupported(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "worker_unsupported";
}

/** Typed text → a value the server accepts (it rejects anything outside 1..max). */
function clamp(raw: string, fallback: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || raw.trim() === "") return fallback;
  return Math.min(max, Math.max(1, n));
}

/**
 * Start a repeat-until-done loop on this workspace: one instruction, run in a
 * fresh session per item, until a session reports there is nothing left.
 *
 * The engine holds no task list — the instruction has to tell each session
 * where to find the next unprocessed item, because no session remembers the
 * previous one. That is the one thing this form has to get across.
 */
export function NewLoopDialog({ projectId, branch, disabled, onStarted }: {
  projectId: string | null;
  branch: string | null;
  /** A loop is already running on this workspace. */
  disabled?: boolean;
  onStarted?: (run: WorkflowRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LoopPresetKind>("plan");
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...presetFor("plan").defaults }));
  const [prompt, setPrompt] = useState(() => generateInstruction("plan", presetFor("plan").defaults));
  /** The generated instruction was edited by hand: the text is now the only truth, the form no longer applies. */
  const [edited, setEdited] = useState(false);
  const [view, setView] = useState<"form" | "instruction">("form");
  /** A pending action that would overwrite hand-written text, waiting for the user's OK. */
  const [confirm, setConfirm] = useState<{ action: "regenerate" } | { action: "switch"; to: LoopPresetKind } | null>(null);
  const [agentType, setAgentType] = useState<"claude-code" | "codex">("claude-code");
  const [iterations, setIterations] = useState(String(REPEAT_LOOP_DEFAULT_ITERATIONS));
  const [minutes, setMinutes] = useState(String(REPEAT_LOOP_DEFAULT_MINUTES));
  const [checkCommand, setCheckCommand] = useState("");
  const [runOnceFirst, setRunOnceFirst] = useState(false);
  const [handoff, setHandoff] = useState(() => presetFor("plan").handoffByDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The start was refused because the worker cannot keep handoff notes: offer to retry without one. */
  const [handoffRefused, setHandoffRefused] = useState(false);
  /** The loop started, but the "stop after the first item" pause could not be set: it is running on. */
  const [pauseFailed, setPauseFailed] = useState<{ run: WorkflowRun; message: string } | null>(null);

  const preset = presetFor(kind);
  const hasForm = preset.fields.length > 0;
  /** Text the user wrote themselves — overwriting it needs a confirmation. */
  const textIsUsers = (hasForm && edited) || (!hasForm && prompt.trim() !== "");

  const applyKind = (to: LoopPresetKind) => {
    const next = presetFor(to);
    setKind(to);
    setConfirm(null);
    setEdited(false);
    setHandoff(next.handoffByDefault);
    if (next.fields.length === 0) {
      // Custom keeps whatever is in the box: a generated plan is a fine starting point.
      setView("instruction");
      return;
    }
    const nextFields = { ...next.defaults, ...fields };
    setFields(nextFields);
    setPrompt(generateInstruction(to, nextFields));
    setView("form");
  };
  const switchKind = (to: LoopPresetKind) => {
    if (to === kind) return;
    if (presetFor(to).fields.length > 0 && textIsUsers) setConfirm({ action: "switch", to });
    else applyKind(to);
  };
  const regenerate = () => {
    setEdited(false);
    setConfirm(null);
    setPrompt(generateInstruction(kind, fields));
  };
  const setField = (key: string, value: string) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    if (!edited) setPrompt(generateInstruction(kind, next));
  };
  const editPrompt = (text: string) => {
    setPrompt(text);
    if (hasForm) setEdited(true);
  };

  const restoreDraft = (id: string) => {
    const d = loadLoopDraft(id);
    if (!d) return;
    const k: LoopPresetKind = d.kind === "custom" ? "custom" : "plan";
    const p = presetFor(k);
    const f = { ...p.defaults, ...(d.fields ?? {}) };
    const wasEdited = p.fields.length > 0 && d.edited === true;
    setKind(k);
    setFields(f);
    setEdited(wasEdited);
    setPrompt(p.fields.length > 0 && !wasEdited ? generateInstruction(k, f) : d.prompt ?? "");
    setView(p.fields.length > 0 && !wasEdited ? "form" : "instruction");
    if (d.agentType === "claude-code" || d.agentType === "codex") setAgentType(d.agentType);
    if (typeof d.iterations === "string") setIterations(d.iterations);
    if (typeof d.minutes === "string") setMinutes(d.minutes);
    if (typeof d.checkCommand === "string") setCheckCommand(d.checkCommand);
    setHandoff(typeof d.handoff === "boolean" ? d.handoff : p.handoffByDefault);
  };
  const onOpenChange = (next: boolean) => {
    if (next) {
      setError(null);
      setHandoffRefused(false);
      setConfirm(null);
      setPauseFailed(null);
      // Off on every open, whichever way the last one ended (design §2.5).
      setRunOnceFirst(false);
      if (projectId) restoreDraft(projectId);
    } else if (projectId) {
      saveLoopDraft(projectId, { kind, fields, prompt, edited, agentType, iterations, minutes, checkCommand, handoff });
    }
    setOpen(next);
  };

  const close = () => onOpenChange(false);

  /** "Run one item first": the loop pauses at a gate after its first item. */
  const pauseAfterFirst = async (run: WorkflowRun): Promise<boolean> => {
    try {
      await api.workflowRunGate(run.id, "pause");
      return true;
    } catch (err) {
      setPauseFailed({ run, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  const retryPause = async () => {
    if (!pauseFailed || busy) return;
    setBusy(true);
    try {
      if (await pauseAfterFirst(pauseFailed.run)) {
        setPauseFailed(null);
        toast.success("The loop will stop after its first item");
        close();
      }
    } finally {
      setBusy(false);
    }
  };

  /** `withHandoff` overrides the switch for "turn it off and retry", which cannot wait for a re-render. */
  const start = async (withHandoff = handoff) => {
    if (!projectId || !prompt.trim() || busy || pauseFailed) return;
    setBusy(true);
    setError(null);
    setHandoffRefused(false);
    const metaFields = presetFieldsForMeta(kind, fields);
    const meta: LoopPresetMeta = { kind, ...(metaFields ? { fields: metaFields } : {}), ...(hasForm && edited ? { edited: true } : {}) };
    try {
      const run = await api.createRepeatLoop({
        projectId, branch, prompt: prompt.trim(), agentType,
        ...(name.trim() ? { name: name.trim() } : {}),
        maxIterations: clamp(iterations, REPEAT_LOOP_DEFAULT_ITERATIONS, REPEAT_LOOP_MAX_ITERATIONS),
        maxMinutes: clamp(minutes, REPEAT_LOOP_DEFAULT_MINUTES, REPEAT_LOOP_MAX_MINUTES),
        ...(checkCommand.trim() ? { checkCommand: checkCommand.trim() } : {}),
        preset: meta,
        // Always sent, false included: the hub gates only `true` (design §4.3).
        handoff: withHandoff,
      });
      onStarted?.(run);
      // Two calls, not an engine field: the first item takes minutes, so the
      // window in which it finishes before the pause lands is acceptable.
      if (runOnceFirst && !(await pauseAfterFirst(run))) return;
      setName("");
      close();
      toast.success(runOnceFirst ? "Loop started — it will stop after the first item" : "Loop started");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Also code worker_unsupported: a worker without loops at all — no switch fixes that.
      setHandoffRefused(withHandoff && isWorkerUnsupported(err));
    } finally {
      setBusy(false);
    }
  };

  const retryWithoutHandoff = () => {
    setHandoff(false);
    void start(false);
  };

  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);
  const submitDisabled = !prompt.trim() || busy || pauseFailed !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!projectId || disabled}
          title={disabled ? "A loop is already running on this workspace" : "New loop — repeat one instruction, a fresh session per item, until done"}
          aria-label="New loop">
          <Repeat className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 gap-0 overflow-hidden bg-card p-0 grid-rows-[auto_minmax(0,1fr)_auto] sm:w-full sm:max-w-[560px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitDisabled) { e.preventDefault(); void start(); }
        }}
      >
        <div className="flex items-start gap-3 border-b bg-secondary px-4 py-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/20 bg-accent text-accent-foreground">
            <Repeat className="size-[15px]" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[14.5px] font-semibold tracking-tight">New loop</DialogTitle>
            <DialogDescription className="mt-0.5 text-[11.5px] leading-snug">
              Runs the same instruction again and again, each time in a fresh session that handles one item, until a
              session reports there is nothing left.
            </DialogDescription>
          </div>
          <DialogClose className="ml-auto grid size-6 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted hover:text-foreground">
            <X className="size-3.5" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-x-hidden overflow-y-auto px-4 pt-3.5 pb-1">
          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel
              trailing={
                <Segmented label="Preset" value={kind} onChange={switchKind}
                  options={LOOP_PRESETS.map((p) => ({ value: p.kind, label: p.label }))} />
              }
            >
              Preset
            </FieldLabel>
            <HintLine>{preset.description}</HintLine>
          </div>

          {confirm && (
            <Strip tone="rose" icon={<TriangleAlert />}>
              {confirm.action === "regenerate"
                ? "Regenerating replaces the instruction with the form's version — your edits are lost."
                : `Switching to ${presetFor(confirm.to).label} replaces the instruction — your text is lost.`}{" "}
              <span className="inline-flex gap-2">
                <InlineLink onClick={() => (confirm.action === "regenerate" ? regenerate() : applyKind(confirm.to))}>
                  Discard my text
                </InlineLink>
                <InlineLink onClick={() => setConfirm(null)}>Keep it</InlineLink>
              </span>
            </Strip>
          )}

          {hasForm && (
            <div role="tablist" aria-label="Instruction view" className="flex min-w-0 gap-3 border-b">
              {(["form", "instruction"] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                  className={cn(
                    "-mb-px border-b-2 px-0.5 pb-1.5 text-[12px] font-medium transition-colors",
                    view === v ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}>
                  {v === "form" ? "Form" : "Instruction"}
                </button>
              ))}
            </div>
          )}

          {hasForm && edited && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
              <PencilLine className="mt-px size-[13px] shrink-0" />
              <span className="min-w-0 flex-1">Edited by hand — the form no longer applies; the instruction text is what runs.</span>
              <button type="button" onClick={() => setConfirm({ action: "regenerate" })}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap underline-offset-2 hover:underline">
                <RotateCcw className="size-3" />Regenerate from form
              </button>
            </div>
          )}

          {hasForm && view === "form" && (
            <fieldset disabled={edited} className="grid min-w-0 grid-cols-2 gap-x-2.5 gap-y-[13px] disabled:opacity-60">
              {preset.fields.map((f) => {
                const id = `loop-field-${f.key}`;
                const wide = f.multiline || f.key === "planFile";
                return (
                  <div key={f.key} className={cn("flex min-w-0 flex-col gap-[7px]", wide && "col-span-2")}>
                    <FieldLabel><label htmlFor={id}>{f.label}</label></FieldLabel>
                    {f.multiline ? (
                      <Textarea id={id} value={fields[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}
                        placeholder={f.placeholder} spellCheck={false}
                        className={cn(CONTROL_INPUT, "field-sizing-fixed min-h-[58px] min-w-0 max-w-full resize-y px-[11px] py-1.5 font-mono text-xs leading-[1.5] md:text-xs")} />
                    ) : (
                      <Input id={id} value={fields[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}
                        placeholder={f.placeholder} spellCheck={false}
                        className={cn(CONTROL_INPUT, "h-[34px] px-[11px] font-mono text-xs md:text-xs")} />
                    )}
                    {f.hint && <HintLine>{f.hint}</HintLine>}
                  </div>
                );
              })}
            </fieldset>
          )}

          {(!hasForm || view === "instruction") && (
            <div className="flex min-w-0 flex-col gap-[7px]">
              <FieldLabel note={prompt.trim() ? undefined : "Required"}>
                <label htmlFor="loop-prompt">Instruction</label>
              </FieldLabel>
              <Textarea
                id="loop-prompt"
                value={prompt}
                onChange={(e) => editPrompt(e.target.value)}
                placeholder={"Fetch the unprocessed items from …, pick the first one, handle it, and mark it processed.\nIf none are left, say so."}
                className={cn(
                  CONTROL_INPUT,
                  "field-sizing-fixed min-h-[118px] min-w-0 max-w-full resize-y overflow-auto px-[11px] py-2 font-mono text-xs leading-[1.55] md:text-xs",
                  hasForm && "min-h-[220px]",
                )}
              />
              {!hasForm && (
                <HintLine>
                  No session remembers the previous one: say where the next unprocessed item is found and how an item is
                  marked done. Make handling an item safe to repeat — an interrupted item may be picked up again.
                </HintLine>
              )}
            </div>
          )}

          <div className="grid min-w-0 grid-cols-2 gap-x-2.5 gap-y-[13px]">
            <div className="flex min-w-0 flex-col gap-[7px]">
              <FieldLabel note="Optional"><label htmlFor="loop-name">Name</label></FieldLabel>
              <Input
                id="loop-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Loop"
                maxLength={80}
                className={cn(CONTROL_INPUT, "h-[34px] px-[11px]")}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-[7px]">
              <FieldLabel>Agent</FieldLabel>
              <div role="radiogroup" aria-label="Agent" className="grid h-[34px] min-w-0 grid-cols-2 gap-0.5 rounded-[9px] border bg-secondary p-[3px]">
                {(Object.keys(AGENT_LABELS) as Array<keyof typeof AGENT_LABELS>).map((type) => {
                  const on = agentType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setAgentType(type)}
                      className={cn(
                        "min-w-0 truncate rounded-md border border-transparent px-2 text-[12px] font-medium transition-colors",
                        on ? "border-border bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {AGENT_LABELS[type]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-[7px]">
              <FieldLabel><label htmlFor="loop-iterations">Stop after</label></FieldLabel>
              <ControlBox>
                <input id="loop-iterations" inputMode="numeric" value={iterations}
                  onChange={(e) => setIterations(e.target.value)} aria-label="Stop after (items)" className={BOX_INPUT} />
                <span className="text-[11px] whitespace-nowrap text-muted-foreground/70">items</span>
              </ControlBox>
            </div>
            <div className="flex min-w-0 flex-col gap-[7px]">
              <FieldLabel><label htmlFor="loop-minutes">Stop after</label></FieldLabel>
              <ControlBox>
                <input id="loop-minutes" inputMode="numeric" value={minutes}
                  onChange={(e) => setMinutes(e.target.value)} aria-label="Stop after (minutes)" className={BOX_INPUT} />
                <span className="text-[11px] whitespace-nowrap text-muted-foreground/70">minutes</span>
              </ControlBox>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-[7px]">
            <FieldLabel note="Optional"><label htmlFor="loop-check">Check command</label></FieldLabel>
            <ControlBox>
              <SquareTerminal />
              <input id="loop-check" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)}
                placeholder="npm test" spellCheck={false} className={cn(BOX_INPUT, "font-mono text-xs tracking-tight")} />
            </ControlBox>
            <HintLine>Runs in the worktree after each item; a non-zero exit stops the loop.</HintLine>
          </div>

          <label className="flex min-w-0 items-start gap-2 text-[12px] leading-snug">
            <input type="checkbox" id="loop-handoff" checked={handoff} onChange={(e) => setHandoff(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary" />
            <span className="min-w-0">
              Keep a handoff note between sessions
              <span className="block text-[10.5px] text-muted-foreground/80">
                Each session ends with a short note — lessons learned, what it did, what to watch — and the loop hands it
                to the next session. Nothing is written to the repo.
              </span>
            </span>
          </label>

          <label className="flex min-w-0 items-start gap-2 text-[12px] leading-snug">
            <input type="checkbox" id="loop-run-once" checked={runOnceFirst} onChange={(e) => setRunOnceFirst(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary" />
            <span className="min-w-0">
              Run one item first, then decide
              <span className="block text-[10.5px] text-muted-foreground/80">
                The loop stops at a gate after the first item; read its session, then continue or end the loop.
              </span>
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-px size-[13px] shrink-0" />
            <span className="min-w-0">
              Sessions run in edit mode with no confirmation between items. The loop stops on its own when an item is
              blocked, fails, or a limit is reached — and you can stop it any time.
            </span>
          </div>

          {error && (
            <Strip tone="rose" icon={<TriangleAlert />}>
              {error}
              {handoffRefused && (
                <>
                  {" "}
                  <InlineLink onClick={retryWithoutHandoff} disabled={busy}>Turn off handoff note and retry</InlineLink>
                </>
              )}
            </Strip>
          )}
          {pauseFailed && (
            <Strip tone="rose" icon={<TriangleAlert />}>
              The loop started, but the pause could not be set — it is still running item after item. ({pauseFailed.message}){" "}
              <InlineLink onClick={() => void retryPause()} disabled={busy}>Retry pause</InlineLink>
            </Strip>
          )}
        </div>

        <div className="mt-2.5 flex min-w-0 items-center gap-2.5 overflow-hidden border-t bg-secondary px-4 py-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
            <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">Runs on <span className="font-mono">{branch ?? "main"}</span></span>
          </span>
          <DialogClose asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">{pauseFailed ? "Close" : "Cancel"}</Button>
          </DialogClose>
          <Button size="sm" className="h-7 gap-1.5 text-xs" aria-label="Start loop"
            onClick={() => void start()} disabled={submitDisabled}>
            {busy ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Repeat className="size-3" />
                Start loop
                <kbd
                  className="rounded border border-background/30 bg-background/15 px-1 font-mono text-[10px] leading-[1.4] text-background/90"
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
