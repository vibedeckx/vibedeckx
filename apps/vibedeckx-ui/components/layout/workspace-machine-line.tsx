"use client";

import { Check, CircleHelp, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { machineStateText, type WorkspaceMachineState } from "@/lib/worktree-target-results";

interface WorkspaceMachineLineProps {
  machine: WorkspaceMachineState;
  /** The remote whose Git the merge badge reads (set in project settings). */
  primary?: boolean;
  /** The remote sessions run on (set in the session header). */
  current?: boolean;
}

/**
 * One machine's line in the coverage tooltip: a state glyph in a fixed
 * column so the eye can run down it, the machine's name with the roles that
 * make it matter (the two are chosen separately and need not coincide), then
 * the state in words. The tooltip surface is inverted (bg-foreground), so the
 * colors are the theme's swapped.
 */
export function WorkspaceMachineLine({ machine, primary, current }: WorkspaceMachineLineProps) {
  const failed = machine.state === "error" || !!machine.error;
  const roles = [primary ? "primary" : null, current ? "current" : null].filter(Boolean).join(", ");
  return (
    <div className="grid grid-cols-[auto_auto_1fr] items-center gap-x-1.5 text-background/70">
      <MachineGlyph state={machine.state} />
      <span className="text-background">
        {machine.name}
        {roles && <span className="text-background/60"> · {roles}</span>}
      </span>
      <span className={cn(failed && "text-red-400 dark:text-red-600")}>{machineStateText(machine)}</span>
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
