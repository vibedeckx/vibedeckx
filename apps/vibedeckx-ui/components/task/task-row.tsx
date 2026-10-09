"use client";

import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Trash2, GitBranch, Archive, ArchiveRestore, CornerDownRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import { statusConfig, priorityConfig, statusOptions, priorityOptions, assignableBranches, branchLabel, descriptionPreview } from "./task-utils";

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
  /** Detail panel is open: drop what it already shows (description, assign, created). */
  compact?: boolean;
  /** Nesting level in the task tree; 0 = top level. */
  depth?: number;
  /** Done / total of its sub-tasks; absent when it has none. */
  progress?: { done: number; total: number };
}

export function TaskRow({ task, onUpdate, onDelete, onArchive, onUnarchive, archivedView, onClick, worktrees, assignedBranches, onAssign, onOpenSourceSession, selected, flash, compact, depth = 0, progress }: TaskRowProps) {
  const isDone = task.status === "done" || task.status === "cancelled";

  return (
    <TableRow
      className={`group cursor-pointer ${flash ? "animate-task-row-flash" : ""}`}
      data-task-id={task.id}
      data-state={selected ? "selected" : undefined}
      onClick={() => onClick?.(task)}
    >
      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={task.status === "done"}
          onCheckedChange={(checked) => {
            onUpdate(task.id, { status: checked ? "done" : "todo" });
          }}
        />
      </TableCell>
      {/* max-w-0: the title column takes the leftover width and truncates
          rather than pushing the table wider than its container. */}
      <TableCell className="font-medium w-full max-w-0">
        {/* Title is plain text: clicking it opens the row like anywhere else;
            renaming happens in the detail panel. */}
        <div className="flex min-w-0 items-start gap-1.5" style={depth > 0 ? { paddingLeft: `${(depth - 1) * 1.25}rem` } : undefined}>
          {depth > 0 && <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className={`truncate text-sm ${isDone ? "line-through text-muted-foreground" : ""}`}>
                {task.title}
              </span>
              {progress && progress.total > 0 && (
                <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground" title="Sub-tasks done">
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
            {!compact && task.description && (
              <p className="text-xs text-muted-foreground truncate max-w-[400px] mt-0.5">
                {descriptionPreview(task.description)}
              </p>
            )}
            {!compact && task.source_session && (
              <div className="mt-0.5 flex max-w-[400px] text-xs" onClick={(e) => e.stopPropagation()}>
                <SourceSessionLink
                  source={task.source_session}
                  onOpen={onOpenSourceSession ? () => onOpenSourceSession(task) : undefined}
                />
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="@max-md:hidden" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="focus:outline-none">
              <Badge variant="outline" className={`cursor-pointer text-xs ${statusConfig[task.status].color}`}>
                {statusConfig[task.status].label}
              </Badge>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {statusOptions.map((s) => (
              <DropdownMenuItem key={s} onClick={() => onUpdate(task.id, { status: s })}>
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${statusConfig[s].color}`} />
                {statusConfig[s].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
      <TableCell className="@max-lg:hidden" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="focus:outline-none">
              <Badge variant="outline" className={`cursor-pointer text-xs ${priorityConfig[task.priority].color}`}>
                {priorityConfig[task.priority].label}
              </Badge>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {priorityOptions.map((p) => (
              <DropdownMenuItem key={p} onClick={() => onUpdate(task.id, { priority: p })}>
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${priorityConfig[p].color}`} />
                {priorityConfig[p].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
      {!compact && (
        <TableCell onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="focus:outline-none">
                <Badge variant="outline" className={`cursor-pointer text-xs font-mono ${task.assigned_branch !== null ? "bg-accent text-accent-foreground border-transparent" : "text-muted-foreground"}`}>
                  <GitBranch className="h-3 w-3 mr-1" />
                  {task.assigned_branch !== null ? branchLabel(task.assigned_branch) : "Unassigned"}
                </Badge>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {task.assigned_branch !== null && (
                <>
                  <DropdownMenuItem onClick={() => onAssign(task.id, null)}>
                    Unassign
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {assignableBranches(task.assigned_branch, worktrees, assignedBranches).map(({ key, label }) => (
                <DropdownMenuItem key={key} onClick={() => onAssign(task.id, key)}>
                  <GitBranch className="h-3 w-3 mr-2" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      )}
      {!compact && (
        <TableCell className="text-muted-foreground text-[10.5px] font-mono">
          {new Date(task.created_at).toLocaleDateString()}
        </TableCell>
      )}
      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-0.5">
          {archivedView ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Unarchive"
              onClick={() => onUnarchive(task.id)}
            >
              <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Archive"
              onClick={() => onArchive(task.id)}
            >
              <Archive className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete"
            onClick={() => onDelete(task.id)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
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
 * generates it, and the row's own controls; the rest shows as entered.
 */
export function PendingTaskRow({ pending, compact }: { pending: PendingTask; compact: boolean }) {
  return (
    <TableRow data-pending-task aria-busy className="hover:bg-transparent">
      {/* pr-0 like the checkbox cell it stands in for, so the column keeps its width. */}
      <TableCell className="w-10 pr-0">
        <Skeleton className="size-4 rounded-[4px]" />
      </TableCell>
      <TableCell className="w-full max-w-0">
        {pending.title !== null ? (
          <span className="block truncate text-sm">{pending.title}</span>
        ) : (
          <>
            <Skeleton className="h-4 w-2/5 max-w-64 my-0.5" />
            <span className="sr-only">Generating title…</span>
          </>
        )}
        {!compact && (
          <p className="text-xs text-muted-foreground truncate max-w-[400px] mt-0.5">{descriptionPreview(pending.description, Infinity)}</p>
        )}
      </TableCell>
      <TableCell className="@max-md:hidden">
        <Badge variant="outline" className={`text-xs opacity-60 ${statusConfig[pending.status].color}`}>
          {statusConfig[pending.status].label}
        </Badge>
      </TableCell>
      <TableCell className="@max-lg:hidden">
        <Badge variant="outline" className={`text-xs opacity-60 ${priorityConfig[pending.priority].color}`}>
          {priorityConfig[pending.priority].label}
        </Badge>
      </TableCell>
      {!compact && (
        <TableCell>
          <Skeleton className="h-5 w-24 rounded-full" />
        </TableCell>
      )}
      {!compact && (
        <TableCell>
          <Skeleton className="h-3.5 w-16" />
        </TableCell>
      )}
      <TableCell className="w-10" />
    </TableRow>
  );
}
