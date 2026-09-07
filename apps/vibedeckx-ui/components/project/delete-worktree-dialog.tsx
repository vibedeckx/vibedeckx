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
import { api, type Worktree } from "@/lib/api";
import { describeRetainedBranches, describeTargetResults } from "@/lib/worktree-target-results";
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
  const [warning, setWarning] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!worktree) return;

    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      const result = await api.deleteWorktree(projectId, worktree.branch!);

      if (result.partialSuccess) {
        setWarning(describeTargetResults(result.results, "deleted") ?? "Some targets failed");
      }

      const retained = describeRetainedBranches(result.results, result.branchRetained);
      if (retained) {
        toast.info(retained, {
          description: "Creating this workspace again will reuse that branch.",
        });
      }

      onWorktreeDeleted();
      if (!result.partialSuccess) {
        onOpenChange(false);
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
      setWarning(null);
    }
    onOpenChange(newOpen);
  };

  return (
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

        {warning && (
          <div className="text-sm text-yellow-600 dark:text-yellow-500 bg-yellow-500/10 px-3 py-2 rounded-md">
            {warning}
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
  );
}
