"use client";

import { ArrowRightLeft, ExternalLink, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { WorkspaceMachineState } from "@/lib/worktree-target-results";

export interface WorkspaceMissingOnRemote {
  branch: string;
  /** The remote sessions run on, which the hub says does not have the workspace. */
  current: WorkspaceMachineState;
  /** Remotes that do have it, in the project's order. */
  presentOn: WorkspaceMachineState[];
}

interface WorkspaceMissingOnRemoteDialogProps {
  missing: WorkspaceMissingOnRemote | null;
  onOpenChange: (open: boolean) => void;
  /** Move sessions to that remote, then open the workspace there. */
  onSwitch: (serverId: string) => void;
  /** Open the management dialog with only the current remote ticked. */
  onCreateHere: () => void;
  /** Open it regardless: the hub's record may be stale, and the user outranks it. */
  onOpenAnyway: () => void;
}

/**
 * Opening a workspace the current remote does not have. A soft prompt, not a
 * gate: the view was never a request to create anything, so the choice is the
 * user's — go where it is, make it here, or ignore the record.
 */
export function WorkspaceMissingOnRemoteDialog({
  missing,
  onOpenChange,
  onSwitch,
  onCreateHere,
  onOpenAnyway,
}: WorkspaceMissingOnRemoteDialogProps) {
  return (
    <Dialog open={missing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] gap-0 p-0 overflow-hidden">
        {missing && (
          <>
            <DialogHeader className="border-b bg-muted/40 px-4 py-3.5 pr-10 text-left">
              <DialogTitle className="text-sm font-semibold">
                <span className="font-mono">{missing.branch}</span> is not on {missing.current.name}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {missing.presentOn.length > 0
                  ? `Sessions run on ${missing.current.name}, which has no checkout of this workspace. It exists on ${missing.presentOn.map((m) => m.name).join(", ")}.`
                  : `Sessions run on ${missing.current.name}, which has no checkout of this workspace.`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 px-4 py-3.5">
              {missing.presentOn.map((machine) => (
                <Button
                  key={machine.serverId}
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={() => onSwitch(machine.serverId)}
                >
                  <ArrowRightLeft className="size-3.5" />
                  Switch to {machine.name}
                </Button>
              ))}
              <Button variant="outline" size="sm" className="justify-start" onClick={onCreateHere}>
                <Plus className="size-3.5" />
                Create on {missing.current.name}
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={onOpenAnyway}>
                <ExternalLink className="size-3.5" />
                Open anyway
              </Button>
            </div>
            <DialogFooter className="border-t bg-muted/40 px-4 py-2.5">
              <p className="text-[10.5px] text-muted-foreground">
                What the hub last recorded; the remote itself may differ.
              </p>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
