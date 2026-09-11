"use client";

import { Check, CircleHelp, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { machineStateText, type WorkspaceMachineState } from "@/lib/worktree-target-results";

interface WorkspaceMachineLineProps {
  machine: WorkspaceMachineState;
  /** The remote whose Git the merge badge reads (set in project settings). */
  primary?: boolean;
}

/**
 * One machine's line in the coverage tooltip: a state glyph in a fixed
 * column so the eye can run down it, the machine's name, the state in words,
 * and — pushed to the right edge — a tag on the primary remote, the one the
 * merge badge describes. The current remote is not tagged: the lead line
 * names it when it matters. The tooltip surface is inverted (bg-foreground),
 * so the colors are the theme's swapped.
 */
export function WorkspaceMachineLine({ machine, primary }: WorkspaceMachineLineProps) {
  const failed = machine.state === "error" || !!machine.error;
  return (
    <div className="flex items-center gap-x-1.5 whitespace-nowrap text-background/70">
      <MachineGlyph state={machine.state} />
      <span className="text-background">{machine.name}</span>
      <span className={cn(failed && "text-red-400 dark:text-red-600")}>{machineStateText(machine)}</span>
      {primary && <span className="ml-auto pl-3 text-background/60">[primary]</span>}
    </div>
  );
}

function MachineGlyph({ state }: { state: WorkspaceMachineState["state"] }) {
  const cls = "h-3 w-3 shrink-0";
  switch (state) {
    case "present":
      return <Check className={cn(cls, "text-background")} aria-label="has it" />;
    case "absent":
      return <X className={cls} aria-label="does not have it" />;
    case "error":
      return <TriangleAlert className={cn(cls, "text-red-400 dark:text-red-600")} aria-label="failed" />;
    case "creating":
    case "deleting":
      return <LoaderCircle className={cn(cls, "animate-spin")} aria-label="in progress" />;
    case "unknown":
      return <CircleHelp className={cls} aria-label="not checked" />;
  }
}
