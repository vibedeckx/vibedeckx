"use client";

import { useMemo, useEffect, useRef, type ReactNode } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TaskRow, PendingTaskRow, FULL_GRID, HIDE_BRANCH, HIDE_PRIORITY, type PendingTask } from "./task-row";
import type { TaskSort, TaskSortField } from "./task-utils";
import { isEditableTarget } from "@/lib/editable-target";
import { hasOpenOverlay } from "@/components/locate/focus-region";
import { cn } from "@/lib/utils";

interface TaskTableProps {
  /** Visible tasks in display order (sorted, then as a tree), with nesting depth. */
  rows: { task: Task; depth: number }[];
  /** Every task of the project, filtered or not: sub-task progress counts them all. */
  allTasks: Task[];
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
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
  /** Task open in the detail panel. */
  selectedTaskId: string | null;
  /** null closes the panel. */
  onSelect: (taskId: string | null) => void;
  /** ↑/↓ while a task is open: move the selection by one row. */
  onStep: (delta: 1 | -1) => void;
  /** Creates still in flight, shown as placeholder rows after the real ones. */
  pendingTasks: PendingTask[];
  /** Just-created task: scrolled into view and briefly highlighted. */
  flashTaskId: string | null;
  /** False while the Tasks view is hidden: its panel keys must not fire. */
  keyboardActive: boolean;
  /** Branch occupancy across all of the project's tasks, not just the visible ones. */
  assignedBranches: Set<string | null>;
}

export function TaskTable({ rows, allTasks, sort, onSortChange, onUpdate, onDelete, onArchive, onUnarchive, archivedView, worktrees, onAssign, onOpenSourceSession, panelOpen, selectedTaskId, onSelect, onStep, pendingTasks, flashTaskId, keyboardActive, assignedBranches }: TaskTableProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const compact = panelOpen;

  const toggleSort = (field: TaskSortField) => {
    // asc → desc → off, so the list can go back to its own order.
    if (sort?.field !== field) onSortChange({ field, dir: "asc" });
    else if (sort.dir === "asc") onSortChange({ field, dir: "desc" });
    else onSortChange(null);
  };

  const progressById = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of allTasks) {
      if (!t.parent_id || t.archived_at !== null || t.status === "cancelled") continue;
      const progress = map.get(t.parent_id) ?? { done: 0, total: 0 };
      progress.total += 1;
      if (t.status === "done") progress.done += 1;
      map.set(t.parent_id, progress);
    }
    return map;
  }, [allTasks]);

  // Each top-level row with its descendants, so the sub-tasks can hang off
  // one tree guide line.
  const groups = useMemo(() => {
    const out: { root: { task: Task; depth: number }; kids: { task: Task; depth: number }[] }[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (row.depth > 0 && last) last.kids.push(row);
      else out.push({ root: row, kids: [] });
    }
    return out;
  }, [rows]);

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
      if (selectedTaskId === null) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (rows.length === 0) return;
      event.preventDefault();
      onStep(event.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [panelOpen, selectedTaskId, onSelect, onStep, rows.length, keyboardActive]);

  const revealId = flashTaskId ?? selectedTaskId;
  useEffect(() => {
    if (revealId === null) return;
    const rowEls = listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [];
    Array.from(rowEls)
      .find((row) => row.dataset.taskId === revealId)
      ?.scrollIntoView({ block: "nearest" });
  }, [revealId]);

  const renderRow = ({ task, depth }: { task: Task; depth: number }) => (
    <TaskRow
      key={task.id}
      task={task}
      depth={depth}
      progress={progressById.get(task.id)}
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
  );

  return (
    <div ref={listRef} role="grid" aria-label="Tasks" className="flex flex-col gap-px px-3 pt-2 pb-4">
      {!compact && (
        <div role="row" className={cn("mb-1 grid h-[30px] items-center gap-x-3 border-b border-border/60 px-2 text-[11px] font-medium text-muted-foreground/70", FULL_GRID)}>
          <SortHeader field="title" sort={sort} onToggle={toggleSort}>Title</SortHeader>
          <SortHeader field="priority" sort={sort} onToggle={toggleSort} className={HIDE_PRIORITY}>Priority</SortHeader>
          <span className={HIDE_BRANCH}>Branch</span>
          <SortHeader field="created_at" sort={sort} onToggle={toggleSort} className="justify-self-end">Created</SortHeader>
          <span />
        </div>
      )}
      {groups.map(({ root, kids }) => (
        <div key={root.task.id} className="contents">
          {renderRow(root)}
          {kids.length > 0 && (
            <div className="relative flex flex-col gap-px before:absolute before:top-[-2px] before:bottom-3 before:left-[15px] before:w-px before:bg-border">
              {kids.map(renderRow)}
            </div>
          )}
        </div>
      ))}
      {pendingTasks.map((pending) => (
        <PendingTaskRow key={pending.key} pending={pending} compact={compact} />
      ))}
      {rows.length === 0 && pendingTasks.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-12 text-center">
          <p className="text-sm font-medium text-foreground/60">No tasks yet</p>
          <p className="text-xs text-muted-foreground">Create one to get started.</p>
        </div>
      )}
    </div>
  );
}

function SortHeader({ field, sort, onToggle, className, children }: { field: TaskSortField; sort: TaskSort; onToggle: (field: TaskSortField) => void; className?: string; children: ReactNode }) {
  const active = sort?.field === field;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className={cn("group/sh inline-flex w-fit items-center gap-[3px] outline-none hover:text-muted-foreground", active && "text-muted-foreground", className)}
    >
      {children}
      <Icon className={cn("size-2.5", !active && "opacity-0 group-hover/sh:opacity-100")} aria-hidden />
    </button>
  );
}
