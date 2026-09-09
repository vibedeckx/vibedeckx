"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, Info, Loader2, Lock, Plus, RotateCw, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Project, type ProjectRemote } from "@/lib/api";
import { useOptionalProjectRemotesContext } from "@/hooks/project-remotes-context";
import {
  adoptedTargets,
  describeTargetResults,
  type WorkspaceTargetState,
} from "@/lib/worktree-target-results";
import { cn } from "@/lib/utils";
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
  /**
   * What each machine holds for that workspace, so the repair opens with only
   * the machines that are missing it ticked.
   */
  initialTargets?: WorkspaceTargetState[];
}

type MachineLoad =
  | { status: "loading" }
  | { status: "ready"; remotes: ProjectRemote[] }
  | { status: "error"; message: string };

/** Stable identity for the pre-fetch list, so memos do not churn. */
const EMPTY_REMOTES: ProjectRemote[] = [];

/** One machine the workspace can be created on. */
interface Machine {
  /** What the server takes as a target: "local", a remote server id, or legacy "remote". */
  id: string;
  label: string;
  path?: string | null;
}

const BRANCH_NAME_START = /^[a-zA-Z0-9]/;
const BRANCH_NAME_INVALID = /[^a-zA-Z0-9/_-]/;

function branchNameError(name: string): string | null {
  if (!name) return null;
  if (BRANCH_NAME_INVALID.test(name)) return "Use letters, numbers and / _ - only";
  if (!BRANCH_NAME_START.test(name)) return "Must start with a letter or a number";
  return null;
}

export function CreateWorktreeDialog({
  projectId,
  project,
  open,
  onOpenChange,
  onWorktreeCreated,
  initialBranchName,
  initialTargets,
}: CreateWorktreeDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("main");
  const [branchesLoading, setBranchesLoading] = useState(false);

  // Null until the machine list is known: the default tick depends on it, and
  // an empty set would read as "the user cleared every machine".
  const [selected, setSelected] = useState<Set<string> | null>(null);

  // The project's machines, fetched here rather than through
  // `useProjectRemotes`: that hook reports "loaded" after a failed request too,
  // and a create that silently goes local-only because the remote list could
  // not be read is the one outcome this dialog must never produce.
  const [fetchedMachines, setFetchedMachines] = useState<MachineLoad>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  // Head start: the project screen has been holding this project's remotes
  // since it was selected, so the dialog can open already showing them —
  // knowing the machines only after a round trip is what made it resize itself
  // in front of the user. A non-empty shared list can only have come from a
  // successful fetch; an empty one is ambiguous (that hook calls a failed
  // request "loaded" too), so it is left to this dialog's own fetch below.
  const shared = useOptionalProjectRemotesContext();
  const sharedRemotes =
    shared && shared.remotes.length > 0 && !shared.loading ? shared.remotes : null;

  const machineLoad: MachineLoad =
    fetchedMachines.status !== "loading"
      ? fetchedMachines
      : sharedRemotes
        ? { status: "ready", remotes: sharedRemotes }
        : fetchedMachines;

  const remotes = machineLoad.status === "ready" ? machineLoad.remotes : EMPTY_REMOTES;
  const remotesLoaded = machineLoad.status === "ready";

  // Fetched only while the dialog is open, so opening it always sees the
  // machines the project has right now.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFetchedMachines({ status: "loading" });
    api.getProjectRemotes(projectId).then(
      (list) => {
        if (!cancelled) setFetchedMachines({ status: "ready", remotes: list });
      },
      (err) => {
        if (cancelled) return;
        setFetchedMachines({
          status: "error",
          message: err instanceof Error ? err.message : "Could not read this project's machines",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, projectId, reloadNonce]);

  const machines = useMemo<Machine[]>(() => {
    const list: Machine[] = [];
    if (project.path) list.push({ id: "local", label: "Local", path: project.path });
    for (const remote of remotes) {
      list.push({
        id: remote.remote_server_id,
        label: `Remote · ${remote.server_name}`,
        path: remote.remote_path,
      });
    }
    // Legacy single-remote projects carry their remote on the project row and
    // have no `project_remotes` link to list.
    if (remotes.length === 0 && project.remote_path) {
      list.push({ id: "remote", label: "Remote", path: project.remote_path });
    }
    return list;
  }, [project.path, project.remote_path, remotes]);

  // The repair framing holds only while the name is still the one that was
  // missing somewhere; typing over it makes this an ordinary new workspace.
  const repairing = !!initialBranchName && branchName === initialBranchName;

  // Machines that already hold the branch this dialog opened on. They are shown
  // ticked off rather than hidden: the point of the repair is the difference.
  // Read from the props alone, so the first render already ticks the right
  // machines — `repairing` only turns true once the name seed has landed.
  //
  // A registered checkout is not the same as a workspace: a create that failed
  // leaves the row behind in `error`, and that machine is exactly the one the
  // repair exists for. Only a finished checkout counts as having it.
  const machinesWithBranch = useMemo(
    () =>
      new Set(
        (initialTargets ?? [])
          .filter((t) => t.state === "present" && (!t.status || t.status === "ready"))
          .map((t) => t.targetId),
      ),
    [initialTargets],
  );

  /** The machine's own reason for not holding the workspace, when it has one. */
  const failureOf = (targetId: string) => {
    const target = initialTargets?.find((t) => t.targetId === targetId);
    return target?.state === "present" && target.status === "error"
      ? target.error || "The last attempt failed here"
      : null;
  };

  // The name is seeded once per opening, and never again: a branch list or a
  // remote link landing later must not type over what the user has entered.
  useEffect(() => {
    if (!open) return;
    setBranchName(initialBranchName ?? "");
  }, [open, initialBranchName]);

  // Which machines to ask, as a value rather than an array identity: the shared
  // list and this dialog's own fetch produce equal lists in different arrays,
  // and re-running on that would query every machine a second time for the same
  // answer — and reset the base branch under a user who had already picked one.
  const machineKey = machines.map((m) => m.id).join("\n");

  // Every machine is asked for its own branches: with several remotes linked,
  // "the remote's branches" is the first remote's, and a start point that only
  // exists on another one would never be offered.
  useEffect(() => {
    if (!open || machineLoad.status !== "ready") return;

    setBranchesLoading(true);
    const sources = machineKey ? machineKey.split("\n") : [undefined];

    let cancelled = false;
    Promise.all(sources.map((target) => api.getProjectBranches(projectId, target))).then((lists) => {
      if (cancelled) return;
      // One base branch for every machine, so the union is the offer: a branch
      // only one machine has is still a valid start point for that machine, and
      // the others report their own failure if they cannot cut from it.
      const union: string[] = [];
      const seen = new Set<string>();
      for (const list of lists) {
        for (const branch of list) {
          if (seen.has(branch)) continue;
          seen.add(branch);
          union.push(branch);
        }
      }
      setBranches(union);
      // A machine joining the list re-runs this. The user may have picked a
      // base branch by then, and silently cutting from a different one is the
      // kind of wrong that only shows up in the commit history.
      setBaseBranch((picked) =>
        union.includes(picked) ? picked : union.includes("main") ? "main" : union[0] || "main",
      );
      setBranchesLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, projectId, machineKey, machineLoad.status]);

  // Machines the user has had a say over. Remotes arrive a fetch after the
  // local row, so each machine takes its default tick when it first appears
  // rather than once for the whole list — otherwise every remote would come up
  // unticked behind a list that was already initialised.
  const decidedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      decidedRef.current = new Set();
      return;
    }
    const fresh = machines.filter((m) => !decidedRef.current.has(m.id));
    if (fresh.length === 0) return;
    for (const machine of fresh) decidedRef.current.add(machine.id);
    // Ticked by default, except a machine that already has the branch: there
    // the repair has nothing to do.
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      for (const machine of fresh) {
        if (!machinesWithBranch.has(machine.id)) next.add(machine.id);
      }
      return next;
    });
  }, [open, machines, machinesWithBranch]);

  const selectedIds = useMemo(
    () => machines.filter((m) => selected?.has(m.id)).map((m) => m.id),
    [machines, selected],
  );

  const toggleMachine = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const trimmedBranch = branchName.trim();
  const nameError = branchNameError(trimmedBranch);
  const branchExists = branches.includes(trimmedBranch);
  // Nothing to pick from means nothing to send: the server then creates on
  // every machine the project has, which is the only sensible whole.
  const noMachinePicked = machines.length > 0 && selectedIds.length === 0;
  // The shared list is a head start for what to show, never a licence to
  // submit: it is as old as the last time the project screen fetched it, so a
  // remote linked since then would be missed by a create that went out on it.
  // Only this dialog's own, just-confirmed list may be created on.
  const machinesConfirmed = fetchedMachines.status === "ready";
  const canCreate = !!trimmedBranch && !nameError && !noMachinePicked && !loading && machinesConfirmed;

  const handleCreate = async () => {
    if (!canCreate) return;

    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      const result = await api.createWorktree(
        projectId,
        trimmedBranch,
        machines.length > 0 ? selectedIds : undefined,
        baseBranch,
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
        toast.info(`Reused the existing '${trimmedBranch}' branch${where}`, {
          description: "The workspace keeps that branch's own history.",
        });
      }

      onWorktreeCreated(result.worktree.branch!);
      if (!result.partialSuccess) {
        // Through the same door as Cancel. Closing straight through the prop
        // would skip the reset, and the base branch picked here would come back
        // as the next workspace's default — while a cancelled dialog reopened
        // on main. One dialog, two defaults, decided by how it last closed.
        handleOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setBranchName("");
      setError(null);
      setWarning(null);
      setBranches([]);
      setBaseBranch("main");
      setSelected(null);
      decidedRef.current = new Set();
      setFetchedMachines({ status: "loading" });
    }
    onOpenChange(newOpen);
  };

  // What the footer promises, named machine by machine while that still fits.
  const destination = () => {
    if (machineLoad.status === "error") return "Cannot tell which machines this project has";
    if (!remotesLoaded) return "Looking up this project's machines…";
    // Rows are on screen from the shared list; this is the moment between that
    // and the answer being confirmed, and it is why Create is not live yet.
    if (!machinesConfirmed) return "Confirming this project's machines…";
    if (machines.length === 0) return "Creates a worktree on every machine";
    if (selectedIds.length === 0) return "Pick at least one machine";
    const labels = machines.filter((m) => selected?.has(m.id)).map((m) => m.label);
    if (labels.length <= 2) return `Creates a worktree on ${labels.join(" and ")}`;
    return `Creates a worktree on ${labels.length} machines`;
  };

  const nameState = () => {
    if (!trimmedBranch) return null;
    if (nameError) return { text: "Invalid", tone: "bad" as const };
    if (repairing) return { text: "Missing somewhere", tone: "muted" as const };
    if (branchExists) return { text: "Exists", tone: "bad" as const };
    if (branchesLoading) return null;
    return { text: "Available", tone: "ok" as const };
  };
  const state = nameState();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // 440 rather than the comp's 520: with one base-branch picker instead
        // of the comp's two, and a name field that holds a branch name, the
        // extra 80px read as an empty gutter rather than as room.
        className="sm:max-w-[440px] max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate();
        }}
      >
        <DialogHeader className="flex-row items-start gap-3 space-y-0 border-b bg-muted/40 px-4 py-3.5 pr-10 text-left">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <GitBranch className="size-3.5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold">
              {repairing ? "Create where it is missing" : "Create New Workspace"}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {repairing
                ? `Creates '${initialBranchName}' on the machines that do not have it. The ones that already do keep what they have, branch history and all.`
                : "Checks out a new branch as its own git worktree on each machine."}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <label
                htmlFor="branch-name"
                className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"
              >
                Branch Name
              </label>
              <span className="flex-1" />
              <span className="text-[10.5px] text-muted-foreground">
                {repairing ? "Rename to create a new one" : "Required"}
              </span>
            </div>
            <div
              className={cn(
                "flex h-9 items-center gap-2 rounded-lg border bg-background px-2.5 focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15",
                state?.tone === "bad" &&
                  "border-destructive/50 focus-within:border-destructive focus-within:ring-destructive/15",
              )}
            >
              <GitBranch className="size-3 shrink-0 text-muted-foreground" />
              <input
                id="branch-name"
                className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted-foreground"
                placeholder="feature/my-feature"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                disabled={loading}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) handleCreate();
                }}
              />
              {state && (
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px]",
                    state.tone === "ok" && "text-emerald-600 dark:text-emerald-500",
                    state.tone === "bad" && "text-destructive",
                    state.tone === "muted" && "text-muted-foreground",
                  )}
                >
                  {state.text}
                </span>
              )}
            </div>
            <p
              className={cn(
                "text-[10.5px] text-muted-foreground",
                (nameError || (branchExists && !repairing)) && "text-destructive",
              )}
            >
              {nameError
                ? nameError
                : branchExists && !repairing
                  ? "That branch already exists — continuing adopts it, keeping its own history"
                  : "Also names the workspace · use / to group"}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {/* Same shape as the two fields around it: label left, the field's
                own aside right, the control below at full width. */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Base Branch
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] text-muted-foreground">
                {branchesLoading
                  ? "Loading…"
                  : `${branches.length} ${branches.length === 1 ? "branch" : "branches"}`}
              </span>
            </div>
            <Select
              value={baseBranch}
              onValueChange={setBaseBranch}
              disabled={loading || branchesLoading || branches.length === 0}
            >
              <SelectTrigger size="sm" className="w-full font-mono text-[11.5px]">
                <SelectValue placeholder={branchesLoading ? "Loading branches…" : "Select branch"} />
              </SelectTrigger>
              {/* Popper mode, pinned to the trigger's width: the default
                  item-aligned popup is sized by its longest branch name, so a
                  long one made the list stick out past the dialog's right edge
                  — visible as soon as the dialog itself got narrower. */}
              <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                {branches.map((b) => (
                  <SelectItem
                    key={b}
                    value={b}
                    className="font-mono text-[11.5px] *:[span]:last:min-w-0 *:[span]:last:overflow-hidden"
                  >
                    <span className="truncate">{b}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10.5px] text-muted-foreground">
              The same start point on every machine picked below.
            </p>
          </div>

          {(machines.length > 0 || machineLoad.status === "loading") && (
            <div className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  Create On
                </span>
                <span className="flex-1" />
                <span className="text-[10.5px] text-muted-foreground">
                  {repairing ? "Ticked where it is missing" : "Pick at least one"}
                </span>
              </div>
              {/* The scroll region: a project can be linked to many remotes.
                  Rows are ~36px with an 8px gap, in a box with 2px of padding.
                  The floor is one row (40px): a project with a single machine
                  shows it and nothing else, and the box does not collapse while
                  the list is still loading. The list usually arrives already
                  seeded from the project screen, so the height is settled
                  before the dialog is on screen.
                  The ceiling is three rows and a sliver of the fourth
                  (3 × 36 + 2 × 8 + 4 + 16 = 144): the cut edge reads as "there
                  is more" without the dialog growing to say it. */}
              <div className="-mx-1 flex min-h-[40px] max-h-[144px] flex-col gap-2 overflow-y-auto px-1 py-0.5">
                {machines.map((machine) => {
                  const checked = !!selected?.has(machine.id);
                  const hasBranch = machinesWithBranch.has(machine.id);
                  const failure = failureOf(machine.id);
                  return (
                    <label
                      key={machine.id}
                      className={cn(
                        "flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                        "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                        checked
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/60 opacity-80",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={loading}
                        onChange={() => toggleMachine(machine.id)}
                      />
                      <span
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background",
                        )}
                      >
                        {checked && <Check className="size-2.5" strokeWidth={3.5} />}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="max-w-[55%] shrink-0 truncate text-[12.5px] font-medium">
                          {machine.label}
                        </span>
                        {repairing && initialTargets && (
                          <span
                            // The machine's own error, when it kept one: a
                            // failed create reads differently from never having
                            // been asked, and only one of them is worth a retry.
                            title={failure ?? undefined}
                            className={cn(
                              "shrink-0 rounded-full border px-1.5 py-px font-mono text-[9.5px]",
                              hasBranch &&
                                "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                              !hasBranch && failure &&
                                "border-destructive/35 bg-destructive/10 text-destructive",
                              !hasBranch && !failure &&
                                "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                            )}
                          >
                            {hasBranch ? "Has it" : failure ? "Failed" : "Missing"}
                          </span>
                        )}
                        {/* `min-w-0` is what makes the truncation possible: a
                            flex item's automatic minimum size is its min-content
                            width, and a path has no spaces to break at, so
                            without this the row is as wide as the longest path
                            and pushes the whole dialog out with it. */}
                        <span
                          title={machine.path ?? undefined}
                          className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-muted-foreground"
                        >
                          {machine.path}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {machineLoad.status === "error" && (
            <div className="flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Could not read this project&apos;s machines — {machineLoad.message}. Creating now
                could miss the machines it never listed.
              </span>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 underline underline-offset-2"
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                <RotateCw className="size-3" />
                Try again
              </button>
            </div>
          )}

          {warning && (
            <div className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          )}

          {error && (
            <div className="flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* `min-w-0`: this is a grid row of the dialog, so its automatic minimum
            size is its min-content width — and the note below never wraps, so
            that width is the whole sentence. Without this the footer widens the
            dialog's only column and drags the header and the fields out past
            the edge, the moment the note grows from "Looking up…" to the names
            of the machines. */}
        <DialogFooter className="min-w-0 flex-row items-center gap-2.5 border-t bg-muted/40 px-4 py-3">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {loading || fetchedMachines.status === "loading" ? (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : noMachinePicked || machineLoad.status === "error" ? (
              <Lock className="size-3 shrink-0" />
            ) : (
              <Info className="size-3 shrink-0" />
            )}
            <span className="min-w-0 truncate">
              {loading ? "Checking out the worktree…" : destination()}
            </span>
          </span>
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!canCreate}>
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
            {loading ? "Creating…" : branchExists && !repairing ? "Adopt & Create" : "Create"}
            {!loading && (
              <kbd className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-4">
                ⌘⏎
              </kbd>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
