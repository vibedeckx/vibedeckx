"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, SquareTerminal, X } from "lucide-react";
import { api, type Worktree, type WorktreeDeleteResult } from "@/lib/api";
import {
  describeRetainedBranches,
  targetOutcomeLines,
  type TargetOutcomeLine,
} from "@/lib/worktree-target-results";
import { toast } from "sonner";

interface DeleteWorktreeDialogProps {
  projectId: string;
  worktree: Worktree | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorktreeDeleted: () => void;
  /**
   * Open a shell in this workspace on one machine. Some failures cannot be
   * retried away — a worktree with uncommitted changes will refuse forever —
   * so the user needs the machine itself, not another Retry.
   */
  onOpenTerminal?: (branch: string, targetId: string) => void;
}

export function DeleteWorktreeDialog({
  projectId,
  worktree,
  open,
  onOpenChange,
  onWorktreeDeleted,
  onOpenTerminal,
}: DeleteWorktreeDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A partial delete reports in its own window rather than leaving the user in
  // front of a live Delete button: the obvious next click would re-run the
  // whole delete, when only some machines still need it.
  //
  // That window carries its own Retry, and a way onto the machine that
  // refused, because a failure the user is looking at should be actionable
  // where they are. `branch` is held here rather than read from `worktree`:
  // the prop goes null the moment the list refreshes without it.
  const [outcome, setOutcome] = useState<{ branch: string; lines: TargetOutcomeLine[] } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  // Delete is idempotent per machine, so a second run is a retry of the ones
  // that failed rather than a repeat of the whole thing.
  const runDelete = async (branch: string): Promise<WorktreeDeleteResult> => {
    const result = await api.deleteWorktree(projectId, branch);

    const retained = describeRetainedBranches(result.results, result.branchRetained);
    if (retained) {
      toast.info(retained, {
        description: "Creating this workspace again will reuse that branch.",
      });
    }

    onWorktreeDeleted();
    return result;
  };

  const handleDelete = async () => {
    if (!worktree) return;

    setLoading(true);
    setError(null);

    try {
      const branch = worktree.branch!;
      const result = await runDelete(branch);

      onOpenChange(false);
      if (result.partialSuccess) {
        setOutcome({ branch, lines: targetOutcomeLines(result.results) });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete worktree");
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async () => {
    if (!outcome) return;

    setRetrying(true);
    setOutcomeError(null);

    try {
      const result = await runDelete(outcome.branch);

      if (result.partialSuccess) {
        setOutcome({ branch: outcome.branch, lines: targetOutcomeLines(result.results) });
      } else {
        setOutcome(null);
        toast.success(`Deleted '${outcome.branch}' everywhere`);
      }
    } catch (err) {
      setOutcomeError(err instanceof Error ? err.message : "Failed to delete worktree");
    } finally {
      setRetrying(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError(null);
    }
    onOpenChange(newOpen);
  };

  const closeOutcome = () => {
    setOutcome(null);
    setOutcomeError(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Worktree</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this worktree?
            </DialogDescription>
          </DialogHeader>

          {worktree && (
            <div className="space-y-2">
              <div className="text-sm">
                <span className="font-medium">Branch:</span>{" "}
                <span className="text-muted-foreground">{worktree.branch}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={loading}
            >
              {loading ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={outcome !== null} onOpenChange={(next) => { if (!next) closeOutcome(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Partly deleted</DialogTitle>
            <DialogDescription>
              {`'${outcome?.branch}' is still there on the machines marked below. Retrying deletes only those; the workspace stays in the sidebar, marked, until they are done.`}
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-2 text-sm">
            {outcome?.lines.map((line) => (
              <li key={line.key} className="flex gap-2">
                {line.ok
                  ? <Check className="size-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-500" />
                  : <X className="size-4 shrink-0 mt-0.5 text-destructive" />}
                <span className="min-w-0">
                  <span className="font-medium">{line.label}</span>
                  {line.detail && <span className="text-muted-foreground"> — {line.detail}</span>}
                  {!line.ok && line.targetId && onOpenTerminal && outcome && (
                    <button
                      className="ml-2 inline-flex items-center gap-1 align-baseline text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                      onClick={() => {
                        closeOutcome();
                        onOpenTerminal(outcome.branch, line.targetId!);
                      }}
                    >
                      <SquareTerminal className="size-3" />
                      Open a terminal there
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {outcomeError && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {outcomeError}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeOutcome} disabled={retrying}>Close</Button>
            <Button variant="destructive" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying..." : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
