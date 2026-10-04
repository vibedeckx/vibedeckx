"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TaskRow, PendingTaskRow, type PendingTask } from "./task-row";
import { isEditableTarget } from "@/lib/editable-target";
import { hasOpenOverlay } from "@/components/locate/focus-region";

type SortField = "title" | "status" | "priority" | "created_at";
type SortDir = "asc" | "desc";

const statusOrder: Record<TaskStatus, number> = { todo: 0, in_progress: 1, done: 2, cancelled: 3 };
const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

interface TaskTableProps {
  tasks: Task[];
  onUpdate: (id: string, opts: { title?: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  archivedView: boolean;
  worktrees: Worktree[];
  onAssign: (taskId: string, branch: string | null) => void;
  onOpenSourceSession?: (task: Task) => void;
  /** The side panel is open (a task or the new-task draft): rows go compact, Esc closes it. */
  panelOpen: boolean;
  /** Task open in the detail panel; ↑↓ step through the sorted rows. */
  selectedTaskId: string | null;
  /** null closes the panel. */
  onSelect: (taskId: string | null) => void;
  /** Creates still in flight, shown as placeholder rows after the real ones. */
  pendingTasks: PendingTask[];
  /** Just-created task: scrolled into view and briefly highlighted. */
  flashTaskId: string | null;
  /** False while the Tasks view is hidden: its panel keys must not fire. */
  keyboardActive: boolean;
  /** Branch occupancy across all of the project's tasks, not just the visible ones. */
  assignedBranches: Set<string | null>;
}

export function TaskTable({ tasks, onUpdate, onDelete, onArchive, onUnarchive, archivedView, worktrees, onAssign, onOpenSourceSession, panelOpen, selectedTaskId, onSelect, pendingTasks, flashTaskId, keyboardActive, assignedBranches }: TaskTableProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const tableRef = useRef<HTMLTableElement>(null);
  const compact = panelOpen;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sorted = useMemo(() => {
    if (!sortField) return tasks;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...tasks].sort((a, b) => {
      switch (sortField) {
        case "title":
          return dir * a.title.localeCompare(b.title);
        case "status":
          return dir * (statusOrder[a.status] - statusOrder[b.status]);
        case "priority":
          return dir * (priorityOrder[a.priority] - priorityOrder[b.priority]);
        case "created_at":
          return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        default:
          return 0;
      }
    });
  }, [tasks, sortField, sortDir]);

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? " \u2191" : " \u2193";
  };

  // Keyboard for the open panel. Capture phase so the Esc that closes the
  // panel is claimed (defaultPrevented) before focus-region's bubble-phase
  // handler would also release the region; typing, open menus/dialogs and an
  // active type-to-locate query (which prevents default) all keep their keys.
  useEffect(() => {
    if (!panelOpen || !keyboardActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target) || hasOpenOverlay()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onSelect(null);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (selectedTaskId === null) return;
      const rows = sorted;
      if (rows.length === 0) return;
      event.preventDefault();
      const index = rows.findIndex((t) => t.id === selectedTaskId);
      const next =
        index === -1
          ? 0
          : event.key === "ArrowDown"
            ? Math.min(index + 1, rows.length - 1)
            : Math.max(index - 1, 0);
      onSelect(rows[next].id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [panelOpen, selectedTaskId, onSelect, sorted, keyboardActive]);

  const revealId = flashTaskId ?? selectedTaskId;
  useEffect(() => {
    if (revealId === null) return;
    const rows = tableRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [];
    Array.from(rows)
      .find((row) => row.dataset.taskId === revealId)
      ?.scrollIntoView({ block: "nearest" });
  }, [revealId]);

  return (
    <Table ref={tableRef}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("title")}>
            Title{sortIndicator("title")}
          </TableHead>
          <TableHead className="cursor-pointer select-none w-32 @max-md:hidden" onClick={() => toggleSort("status")}>
            Status{sortIndicator("status")}
          </TableHead>
          <TableHead className="cursor-pointer select-none w-28 @max-lg:hidden" onClick={() => toggleSort("priority")}>
            Priority{sortIndicator("priority")}
          </TableHead>
          {!compact && <TableHead className="w-32">Assign</TableHead>}
          {!compact && (
            <TableHead className="cursor-pointer select-none w-28" onClick={() => toggleSort("created_at")}>
              Created{sortIndicator("created_at")}
            </TableHead>
          )}
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            archivedView={archivedView}
            onClick={(t) => onSelect(t.id === selectedTaskId ? null : t.id)}
            selected={task.id === selectedTaskId}
            flash={task.id === flashTaskId}
            compact={compact}
            worktrees={worktrees}
            assignedBranches={assignedBranches}
            onAssign={onAssign}
            onOpenSourceSession={onOpenSourceSession}
          />
        ))}
        {pendingTasks.map((pending) => (
          <PendingTaskRow key={pending.key} pending={pending} compact={compact} />
        ))}
        {tasks.length === 0 && pendingTasks.length === 0 && (
          <TableRow>
            <td colSpan={compact ? 5 : 7} className="text-center text-muted-foreground py-12 text-sm">
              <div className="flex flex-col items-center gap-1">
                <p className="text-sm font-medium text-foreground/60">No tasks yet</p>
                <p className="text-xs text-muted-foreground">Create one to get started.</p>
              </div>
            </td>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
