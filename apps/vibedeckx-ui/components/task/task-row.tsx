"use client";

import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Archive, ArchiveRestore, GitBranch, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import { cn } from "@/lib/utils";
import { priorityConfig, branchLabel, descriptionPreview, shortAge } from "./task-utils";
import { PriorityGlyph, PriorityMenu, ProgressRing, StatusGlyph, StatusMenu } from "./task-glyphs";
import { BranchChip, BranchMenu } from "./task-properties";

/**
 * Columns of the full list: title, priority, branch, created, row actions.
 * Narrow containers drop Branch, then Priority, rather than scroll sideways.
 */
export const FULL_GRID =
  "grid-cols-[minmax(0,1fr)_88px_176px_44px_56px] @max-3xl:grid-cols-[minmax(0,1fr)_88px_44px_56px] @max-lg:grid-cols-[minmax(0,1fr)_44px_56px]";
export const HIDE_BRANCH = "@max-3xl:hidden";
export const HIDE_PRIORITY = "@max-lg:hidden";

const ROW_BASE = "relative grid items-center gap-x-3 rounded-[7px] px-2";

interface TaskRowProps {
  task: Task;
  onUpdate: (id: string, opts: { title?: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  archivedView: boolean;
  onClick?: (task: Task) => void;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
  onAssign: (taskId: string, branch: string | null) => void;
  onOpenSourceSession?: (task: Task) => void;
  /** This task is open in the detail panel. */
  selected?: boolean;
  /** Just created: play the one-shot highlight. */
  flash?: boolean;
  /** Side panel is open: one line per task, title plus branch and priority glyphs. */
  compact?: boolean;
  /** Nesting level in the task tree; 0 = top level. */
  depth?: number;
  /** Done / total of its sub-tasks; absent when it has none. */
  progress?: { done: number; total: number };
}

export function TaskRow({ task, onUpdate, onDelete, onArchive, onUnarchive, archivedView, onClick, worktrees, assignedBranches, onAssign, onOpenSourceSession, selected, flash, compact, depth = 0, progress }: TaskRowProps) {
  const closed = task.status === "done" || task.status === "cancelled";
  const nested = depth > 0;
  // Sub-tasks stay one line; so does everything while the panel shows the details.
  const twoLine = !compact && !nested && (task.description || task.source_session);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      role="row"
      data-task-id={task.id}
      data-state={selected ? "selected" : undefined}
      onClick={() => onClick?.(task)}
      className={cn(
        ROW_BASE,
        "group cursor-pointer hover:bg-muted",
        compact ? "min-h-[34px] grid-cols-[minmax(0,1fr)_auto]" : FULL_GRID,
        !compact && (nested ? "min-h-[34px] py-[3px]" : "min-h-[46px] py-1.5"),
        "data-[state=selected]:bg-accent data-[state=selected]:hover:bg-accent data-[state=selected]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_14%,transparent)]",
        flash && "animate-task-row-flash",
      )}
    >
      <div
        className={cn("flex min-w-0 gap-[9px]", compact || !twoLine ? "items-center" : "items-start")}
        style={nested ? { paddingLeft: 23 + (depth - 1) * 20 } : undefined}
      >
        <StatusMenu status={task.status} onChange={(status) => onUpdate(task.id, { status })}>
          <button
            type="button"
            aria-label={`Status: ${task.status}`}
            onClick={stop}
            className={cn("shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50", twoLine && "mt-[2.5px]")}
          >
            <StatusGlyph status={task.status} />
          </button>
        </StatusMenu>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
                closed
                  ? "font-[450] text-muted-foreground line-through decoration-border"
                  : nested ? "font-[450] text-secondary-foreground" : "font-medium",
              )}
            >
              {task.title}
            </span>
            {progress && progress.total > 0 && <ProgressRing done={progress.done} total={progress.total} />}
            {flash && (
              <span className="shrink-0 rounded px-[5px] font-mono text-[10px] font-medium text-[oklch(0.6_0.14_152)] bg-[oklch(0.94_0.05_152)] dark:bg-[oklch(0.6_0.14_152/0.18)]">
                new
              </span>
            )}
          </div>
          {twoLine && (
            <div className="mt-px flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {task.description && <span className="min-w-0 truncate">{descriptionPreview(task.description, 240)}</span>}
              {task.description && task.source_session && <span className="shrink-0 text-border" aria-hidden>·</span>}
              {task.source_session && (
                <span className="flex min-w-0 max-w-[210px] shrink-0 [&_svg]:size-[11px]" onClick={stop}>
                  <SourceSessionLink
                    source={task.source_session}
                    onOpen={onOpenSourceSession ? () => onOpenSourceSession(task) : undefined}
                  />
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {compact ? (
        <div className="flex items-center gap-2.5 text-muted-foreground/70">
          {task.assigned_branch !== null && (
            <span title={branchLabel(task.assigned_branch)} className="inline-flex">
              <GitBranch className="size-3" aria-label={`Branch ${branchLabel(task.assigned_branch)}`} />
            </span>
          )}
          <PriorityGlyph priority={task.priority} />
        </div>
      ) : (
        <>
          <PriorityMenu priority={task.priority} onChange={(priority) => onUpdate(task.id, { priority })}>
            <button
              type="button"
              onClick={stop}
              className={cn("-mx-1.5 flex w-fit items-center gap-[7px] rounded-md px-1.5 py-1 text-xs text-secondary-foreground outline-none hover:bg-background hover:shadow-[inset_0_0_0_1px_var(--border)] data-[state=open]:bg-background data-[state=open]:shadow-[inset_0_0_0_1px_var(--border)]", HIDE_PRIORITY)}
            >
              <PriorityGlyph priority={task.priority} />
              {priorityConfig[task.priority].label}
            </button>
          </PriorityMenu>
          <div className={cn("flex min-w-0", HIDE_BRANCH)}>
            <BranchMenu
              current={task.assigned_branch}
              onAssign={(branch) => onAssign(task.id, branch)}
              worktrees={worktrees}
              assignedBranches={assignedBranches}
            >
              <button type="button" onClick={stop} className="flex min-w-0 max-w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50" title={task.assigned_branch !== null ? undefined : "Assign a branch"}>
                {task.assigned_branch !== null ? (
                  <BranchChip branch={task.assigned_branch} className="hover:border-border" />
                ) : (
                  <span className="text-xs text-muted-foreground/70 hover:text-muted-foreground">—</span>
                )}
              </button>
            </BranchMenu>
          </div>
          <span className="text-right font-mono text-[11px] text-muted-foreground/70" title={new Date(task.created_at).toLocaleString()}>
            {shortAge(task.created_at)}
          </span>
          <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" onClick={stop}>
            {archivedView ? (
              <RowAction title="Unarchive" onClick={() => onUnarchive(task.id)}><ArchiveRestore className="size-[13px]" /></RowAction>
            ) : (
              <RowAction title="Archive" onClick={() => onArchive(task.id)}><Archive className="size-[13px]" /></RowAction>
            )}
            <RowAction title="Delete" onClick={() => onDelete(task.id)}><Trash2 className="size-[13px]" /></RowAction>
          </div>
        </>
      )}
    </div>
  );
}

export function RowAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid size-[26px] place-items-center rounded-md text-muted-foreground outline-none hover:bg-border/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}

/** A create in flight (the server may still be generating its title). */
export interface PendingTask {
  key: string;
  /** null until the server generates one. */
  title: string | null;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
}

/**
 * Inert placeholder row for a task being created, matching TaskRow's columns.
 * Only what isn't known yet is a skeleton — the title while the server
 * generates it, and the row's own fields; the rest shows as entered.
 */
export function PendingTaskRow({ pending, compact }: { pending: PendingTask; compact: boolean }) {
  return (
    <div
      role="row"
      data-pending-task
      aria-busy
      className={cn(ROW_BASE, "cursor-default", compact ? "min-h-[34px] grid-cols-[minmax(0,1fr)_auto]" : cn(FULL_GRID, "min-h-[46px] py-1.5"))}
    >
      <div className={cn("flex min-w-0 gap-[9px]", compact ? "items-center" : "items-start")}>
        <StatusGlyph status={pending.status} pending className={compact ? undefined : "mt-[2.5px]"} />
        <div className="min-w-0 flex-1">
          {pending.title !== null ? (
            <span className="block truncate text-[13px] font-medium">{pending.title}</span>
          ) : (
            <>
              <Skeleton className="my-[5px] h-[9px] w-[46%] max-w-64" />
              <span className="sr-only">Generating title…</span>
            </>
          )}
          {!compact && (
            <div className="mt-px truncate text-xs text-muted-foreground">{descriptionPreview(pending.description, Infinity)}</div>
          )}
        </div>
      </div>
      {compact ? (
        <PriorityGlyph priority={pending.priority} className="opacity-55" />
      ) : (
        <>
          <div className={cn("flex items-center gap-[7px] text-xs text-secondary-foreground opacity-55", HIDE_PRIORITY)}>
            <PriorityGlyph priority={pending.priority} />
            {priorityConfig[pending.priority].label}
          </div>
          <Skeleton className={cn("h-[9px] w-[90px]", HIDE_BRANCH)} />
          <Skeleton className="h-[9px] w-[26px] justify-self-end" />
          <span />
        </>
      )}
    </div>
  );
}
