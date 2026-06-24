"use client";

import { useState, useRef, useEffect } from "react";
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
import { Trash2, GitBranch, Archive, ArchiveRestore } from "lucide-react";
import { statusConfig, priorityConfig, statusOptions, priorityOptions } from "./task-utils";

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
}

export function TaskRow({ task, onUpdate, onDelete, onArchive, onUnarchive, archivedView, onClick, worktrees, assignedBranches, onAssign }: TaskRowProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTitle) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    setTitleValue(task.title);
  }, [task.title]);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    } else {
      setTitleValue(task.title);
    }
  };

  const isDone = task.status === "done" || task.status === "cancelled";

  return (
    <TableRow className="group cursor-pointer" onClick={() => onClick?.(task)}>
      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={task.status === "done"}
          onCheckedChange={(checked) => {
            onUpdate(task.id, { status: checked ? "done" : "todo" });
          }}
        />
      </TableCell>
      <TableCell className="font-medium">
        {editingTitle ? (
          <input
            ref={inputRef}
            className="w-full bg-transparent border-b border-primary outline-none text-sm py-0.5"
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={commitTitle}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitleValue(task.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <div>
            <span
              className={`cursor-pointer hover:underline text-sm ${isDone ? "line-through text-muted-foreground" : ""}`}
              onClick={(e) => { e.stopPropagation(); setEditingTitle(true); }}
            >
              {task.title}
            </span>
            {task.description && (
              <p className="text-xs text-muted-foreground truncate max-w-[400px] mt-0.5">
                {task.description.length > 80 ? task.description.slice(0, 80) + "..." : task.description}
              </p>
            )}
          </div>
        )}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
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
      <TableCell onClick={(e) => e.stopPropagation()}>
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
      <TableCell onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="focus:outline-none">
              <Badge variant="outline" className={`cursor-pointer text-xs font-mono ${task.assigned_branch !== null ? "bg-accent text-accent-foreground border-transparent" : "text-muted-foreground"}`}>
                <GitBranch className="h-3 w-3 mr-1" />
                {task.assigned_branch !== null
                  ? (task.assigned_branch === "" ? "main" : task.assigned_branch)
                  : "Unassigned"}
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
            {worktrees
              .filter((wt) => {
                // Map worktree branch to assigned_branch value: null -> "", string -> string
                const branchKey = wt.branch === null ? "" : wt.branch;
                // Skip if this is already the assigned branch
                if (task.assigned_branch === branchKey) return false;
                // Skip if another task already has this branch assigned
                if (assignedBranches.has(branchKey)) return false;
                return true;
              })
              .map((wt) => {
                const branchKey = wt.branch === null ? "" : wt.branch;
                const displayName = wt.branch ?? "main";
                return (
                  <DropdownMenuItem key={branchKey} onClick={() => onAssign(task.id, branchKey)}>
                    <GitBranch className="h-3 w-3 mr-2" />
                    {displayName}
                  </DropdownMenuItem>
                );
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
      <TableCell className="text-muted-foreground text-[10.5px] font-mono">
        {new Date(task.created_at).toLocaleDateString()}
      </TableCell>
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
