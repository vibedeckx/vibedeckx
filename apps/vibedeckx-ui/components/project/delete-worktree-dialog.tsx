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
import { Check, X } from "lucide-react";
import { api, type Worktree } from "@/lib/api";
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
}

export function DeleteWorktreeDialog({
  projectId,
  worktree,
  open,
  onOpenChange,
  onWorktreeDeleted,
}: DeleteWorktreeDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A partial delete reports in its own window rather than leaving the user in
  // front of a live Delete button: the obvious next click would re-run the
  // whole delete, when only some machines still need it.
  const [outcome, setOutcome] = useState<{ branch: string; lines: TargetOutcomeLine[] } | null>(null);

  const handleDelete = async () => {
    if (!worktree) return;

    setLoading(true);
    setError(null);

    try {
      const branch = worktree.branch!;
      const result = await api.deleteWorktree(projectId, branch);

      const retained = describeRetainedBranches(result.results, result.branchRetained);
      if (retained) {
        toast.info(retained, {
          description: "Creating this workspace again will reuse that branch.",
        });
      }

      onWorktreeDeleted();
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

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError(null);
    }
    onOpenChange(newOpen);
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

      <Dialog open={outcome !== null} onOpenChange={(next) => { if (!next) setOutcome(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Partly deleted</DialogTitle>
            <DialogDescription>
              {`'${outcome?.branch}' was deleted on some machines but not all. Deleting it again only retries the ones below that failed.`}
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-2 text-sm">
            {outcome?.lines.map((line) => (
              <li key={line.key} className="flex gap-2">
                {line.ok
                  ? <Check className="size-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-500" />
                  : <X className="size-4 shrink-0 mt-0.5 text-destructive" />}
                <span>
                  <span className="font-medium">{line.label}</span>
                  {line.detail && <span className="text-muted-foreground"> — {line.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOutcome(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
