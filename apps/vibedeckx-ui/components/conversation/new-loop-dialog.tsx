"use client";

import { useState } from "react";
import { Repeat } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!projectId || disabled}
          title={disabled ? "A loop is already running on this workspace" : "New loop — repeat one instruction, a fresh session per item, until done"}
          aria-label="New loop">
          <Repeat className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); }
      }}>
        <DialogHeader>
          <DialogTitle>New loop</DialogTitle>
          <DialogDescription>
            Runs the same instruction again and again — each time in a fresh agent session that handles one item and
            is then stopped — until a session reports there is nothing left.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <label htmlFor="loop-prompt" className="font-medium">Instruction</label>
            <Textarea id="loop-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder={"Fetch the unprocessed items from …, pick the first one, handle it, and mark it processed.\nIf none are left, say so."} />
            <p className="text-xs text-muted-foreground">
              No session remembers the previous one: say where the next unprocessed item is found, and how an item is
              marked done. Make handling an item safe to repeat — an interrupted item may be picked up again.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="loop-name" className="font-medium">Name</label>
              <Input id="loop-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Loop" maxLength={80} />
            </div>
            <div className="space-y-1">
              <span className="font-medium">Agent</span>
              <div className="flex gap-1" role="group" aria-label="Agent">
                {(["claude-code", "codex"] as const).map((type) => (
                  <Button key={type} type="button" size="sm" variant={agentType === type ? "default" : "outline"}
                    aria-pressed={agentType === type} onClick={() => setAgentType(type)}>
                    {type === "claude-code" ? "Claude Code" : "Codex"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="loop-iterations" className="font-medium">Stop after (items)</label>
              <Input id="loop-iterations" inputMode="numeric" value={iterations} onChange={(e) => setIterations(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="loop-minutes" className="font-medium">Stop after (minutes)</label>
              <Input id="loop-minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="loop-check" className="font-medium">Check command <span className="font-normal text-muted-foreground">(optional)</span></label>
            <Input id="loop-check" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} placeholder="npm test" className="font-mono" />
            <p className="text-xs text-muted-foreground">Runs in the worktree after each item; a non-zero exit stops the loop.</p>
          </div>

          <p className="text-xs text-amber-600">
            Sessions run in edit mode with no confirmation between items. The loop stops on its own when an item is
            blocked, fails, or a limit is reached — and you can stop it any time.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => void start()} disabled={!prompt.trim() || busy}>Start loop</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
