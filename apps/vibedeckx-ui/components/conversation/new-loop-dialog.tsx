"use client";

import { useState, useSyncExternalStore } from "react";
import { GitBranch, Loader2, Repeat, SquareTerminal, TriangleAlert, X } from "lucide-react";
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
  Strip,
} from "@/components/schedule/schedule-form-chrome";
import { isMacPlatform } from "@/lib/tab-shortcuts";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

const AGENT_LABELS = { "claude-code": "Claude Code", codex: "Codex" } as const;

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
  const [prompt, setPrompt] = useState("");
  const [agentType, setAgentType] = useState<"claude-code" | "codex">("claude-code");
  const [iterations, setIterations] = useState(String(REPEAT_LOOP_DEFAULT_ITERATIONS));
  const [minutes, setMinutes] = useState(String(REPEAT_LOOP_DEFAULT_MINUTES));
  const [checkCommand, setCheckCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!projectId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api.createRepeatLoop({
        projectId, branch, prompt: prompt.trim(), agentType,
        ...(name.trim() ? { name: name.trim() } : {}),
        maxIterations: clamp(iterations, REPEAT_LOOP_DEFAULT_ITERATIONS, REPEAT_LOOP_MAX_ITERATIONS),
        maxMinutes: clamp(minutes, REPEAT_LOOP_DEFAULT_MINUTES, REPEAT_LOOP_MAX_MINUTES),
        ...(checkCommand.trim() ? { checkCommand: checkCommand.trim() } : {}),
      });
      onStarted?.(run);
      setOpen(false);
      setPrompt("");
      setName("");
      setCheckCommand("");
      toast.success("Loop started");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);
  const submitDisabled = !prompt.trim() || busy;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!projectId || disabled}
          title={disabled ? "A loop is already running on this workspace" : "New loop — repeat one instruction, a fresh session per item, until done"}
          aria-label="New loop">
          <Repeat className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 gap-0 overflow-hidden bg-card p-0 grid-rows-[auto_minmax(0,1fr)_auto] sm:w-full sm:max-w-[500px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitDisabled) { e.preventDefault(); void start(); }
        }}
      >
        <div className="flex items-start gap-3 border-b bg-secondary px-4 py-3.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/20 bg-accent text-accent-foreground">
            <Repeat className="size-[15px]" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[14.5px] font-semibold tracking-tight">New loop</DialogTitle>
            <DialogDescription className="mt-0.5 max-w-[46ch] text-[11.5px] leading-snug">
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
            <FieldLabel note={prompt.trim() ? undefined : "Required"}>
              <label htmlFor="loop-prompt">Instruction</label>
            </FieldLabel>
            <Textarea
              id="loop-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={"Fetch the unprocessed items from …, pick the first one, handle it, and mark it processed.\nIf none are left, say so."}
              className={cn(
                CONTROL_INPUT,
                "field-sizing-fixed min-h-[118px] min-w-0 max-w-full resize-y overflow-auto px-[11px] py-2 font-mono text-xs leading-[1.55] md:text-xs",
              )}
            />
            <HintLine>
              No session remembers the previous one: say where the next unprocessed item is found and how an item is
              marked done. Make handling an item safe to repeat — an interrupted item may be picked up again.
            </HintLine>
          </div>

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

          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-px size-[13px] shrink-0" />
            <span className="min-w-0">
              Sessions run in edit mode with no confirmation between items. The loop stops on its own when an item is
              blocked, fails, or a limit is reached — and you can stop it any time.
            </span>
          </div>

          {error && <Strip tone="rose" icon={<TriangleAlert />}>{error}</Strip>}
        </div>

        <div className="mt-2.5 flex min-w-0 items-center gap-2.5 overflow-hidden border-t bg-secondary px-4 py-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
            <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">Runs on <span className="font-mono">{branch ?? "main"}</span></span>
          </span>
          <DialogClose asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">Cancel</Button>
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
