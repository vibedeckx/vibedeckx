"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Project, type WorktreeTarget } from "@/lib/api";
import { adoptedTargets, describeTargetResults } from "@/lib/worktree-target-results";
import { toast } from "sonner";

interface CreateWorktreeDialogProps {
  projectId: string;
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorktreeCreated: (branch: string) => void;
  /**
   * Branch to start from, for a workspace that exists on some machines but not
   * others. Creating it again is the repair: the machines that have it adopt
   * what is already there, and the one that missed out gets it.
   */
  initialBranchName?: string;
}

export function CreateWorktreeDialog({
  projectId,
  project,
  open,
  onOpenChange,
  onWorktreeCreated,
  initialBranchName,
}: CreateWorktreeDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [createLocal, setCreateLocal] = useState(true);
  const [createRemote, setCreateRemote] = useState(true);

  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [localBaseBranch, setLocalBaseBranch] = useState("main");
  const [remoteBaseBranch, setRemoteBaseBranch] = useState("main");
  const [branchesLoading, setBranchesLoading] = useState(false);

  const isHybrid = !!(project.path && project.remote_path);
  // The repair framing holds only while the name is still the one that was
  // missing somewhere; typing over it makes this an ordinary new workspace.
  const repairing = !!initialBranchName && branchName === initialBranchName;

  useEffect(() => {
    if (!open) return;

    setBranchName(initialBranchName ?? "");
    setBranchesLoading(true);

    if (isHybrid) {
      Promise.all([
        api.getProjectBranches(projectId, "local"),
        api.getProjectBranches(projectId, "remote"),
      ]).then(([local, remote]) => {
        setLocalBranches(local);
        setRemoteBranches(remote);
        setLocalBaseBranch(local.includes("main") ? "main" : local[0] || "main");
        setRemoteBaseBranch(remote.includes("main") ? "main" : remote[0] || "main");
        setBranchesLoading(false);
      });
    } else {
      api.getProjectBranches(projectId).then((branches) => {
        setLocalBranches(branches);
        setLocalBaseBranch(branches.includes("main") ? "main" : branches[0] || "main");
        setBranchesLoading(false);
      });
    }
  }, [open, projectId, isHybrid, initialBranchName]);

  const handleCreate = async () => {
    if (!branchName.trim()) return;

    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      let targets: WorktreeTarget[] | undefined;
      if (isHybrid) {
        targets = [];
        if (createLocal) targets.push("local");
        if (createRemote) targets.push("remote");
      }

      const result = await api.createWorktree(
        projectId,
        branchName.trim(),
        targets,
        localBaseBranch,
        isHybrid ? remoteBaseBranch : undefined
      );

      if (result.partialSuccess) {
        setWarning(describeTargetResults(result.results, "created") ?? "Some targets failed");
      }

      // A target that already had this branch reuses it, so the base branch the
      // user picked did not apply there. Say so instead of implying a fresh cut.
      const reused = adoptedTargets(result.results);
      if (reused.length > 0 || result.worktree.adopted) {
        // Single-target creates answer flat, with no per-target map to read.
        const where = reused.length > 0 ? ` on ${reused.join(", ")}` : "";
        toast.info(`Reused the existing '${branchName.trim()}' branch${where}`, {
          description: "The workspace keeps that branch's own history.",
        });
      }

      onWorktreeCreated(result.worktree.branch!);
      if (!result.partialSuccess) {
        onOpenChange(false);
        setBranchName("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worktree");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setBranchName("");
      setError(null);
      setWarning(null);
      setCreateLocal(true);
      setCreateRemote(true);
      setLocalBranches([]);
      setRemoteBranches([]);
      setLocalBaseBranch("main");
      setRemoteBaseBranch("main");
    }
    onOpenChange(newOpen);
  };

  const branchSelect = (
    branches: string[],
    value: string,
    onChange: (v: string) => void,
    disabled: boolean
  ) => (
    <Select value={value} onValueChange={onChange} disabled={disabled || branchesLoading}>
      <SelectTrigger size="sm">
        <SelectValue placeholder={branchesLoading ? "Loading..." : "Select branch"} />
      </SelectTrigger>
      <SelectContent>
        {branches.map((b) => (
          <SelectItem key={b} value={b}>
            {b}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{repairing ? "Create where it is missing" : "Create New Worktree"}</DialogTitle>
          <DialogDescription>
            {repairing
              ? `Creates '${initialBranchName}' on the machines that do not have it. The ones that already do keep what they have, branch history and all.`
              : "Create a new branch based on an existing branch"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="branch-name" className="text-sm font-medium">
              Branch Name
            </label>
            <Input
              id="branch-name"
              placeholder="feature/my-feature"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              disabled={loading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && branchName.trim() && (!isHybrid || createLocal || createRemote)) {
                  handleCreate();
                }
              }}
            />
          </div>

          {isHybrid ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Create On</label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createLocal}
                    onChange={(e) => {
                      if (!e.target.checked && !createRemote) return;
                      setCreateLocal(e.target.checked);
                    }}
                    disabled={loading}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span>Local</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {project.path}
                  </span>
                </label>
                {createLocal && localBranches.length > 0 && (
                  <div className="ml-6">
                    <label className="text-xs text-muted-foreground">Base Branch</label>
                    {branchSelect(localBranches, localBaseBranch, setLocalBaseBranch, loading)}
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createRemote}
                    onChange={(e) => {
                      if (!e.target.checked && !createLocal) return;
                      setCreateRemote(e.target.checked);
                    }}
                    disabled={loading}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span>Remote</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {project.remote_path}
                  </span>
                </label>
                {createRemote && remoteBranches.length > 0 && (
                  <div className="ml-6">
                    <label className="text-xs text-muted-foreground">Base Branch</label>
                    {branchSelect(remoteBranches, remoteBaseBranch, setRemoteBaseBranch, loading)}
                  </div>
                )}
              </div>
            </div>
          ) : (
            localBranches.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Base Branch</label>
                {branchSelect(localBranches, localBaseBranch, setLocalBaseBranch, loading)}
              </div>
            )
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!branchName.trim() || loading || (isHybrid && !createLocal && !createRemote)}
          >
            {loading ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
