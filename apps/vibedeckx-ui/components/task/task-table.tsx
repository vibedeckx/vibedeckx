"use client";

import { useState, useMemo } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TaskRow } from "./task-row";
import { TaskDetailDialog } from "./task-detail-dialog";

type SortField = "title" | "status" | "priority" | "created_at";
type SortDir = "asc" | "desc";

const statusOrder: Record<TaskStatus, number> = { todo: 0, in_progress: 1, done: 2, cancelled: 3 };
const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

interface TaskTableProps {
  tasks: Task[];
  onUpdate: (id: string, opts: { title?: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => void;
  onDelete: (id: string) => void;
  worktrees: Worktree[];
  onAssign: (taskId: string, branch: string | null) => void;
}

export function TaskTable({ tasks, onUpdate, onDelete, worktrees, onAssign }: TaskTableProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

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

  const assignedBranches = useMemo(
    () => new Set(tasks.filter((t) => t.assigned_branch !== null).map((t) => t.assigned_branch)),
    [tasks]
  );

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("title")}>
            Title{sortIndicator("title")}
          </TableHead>
          <TableHead className="cursor-pointer select-none w-32" onClick={() => toggleSort("status")}>
            Status{sortIndicator("status")}
          </TableHead>
          <TableHead className="cursor-pointer select-none w-28" onClick={() => toggleSort("priority")}>
            Priority{sortIndicator("priority")}
          </TableHead>
          <TableHead className="w-32">Assign</TableHead>
          <TableHead className="cursor-pointer select-none w-28" onClick={() => toggleSort("created_at")}>
            Created{sortIndicator("created_at")}
          </TableHead>
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
            onClick={(t) => { setSelectedTask(t); setDetailOpen(true); }}
            worktrees={worktrees}
            assignedBranches={assignedBranches}
            onAssign={onAssign}
          />
        ))}
        {tasks.length === 0 && (
          <TableRow>
            <td colSpan={7} className="text-center text-muted-foreground py-12 text-sm">
              <div className="flex flex-col items-center gap-1">
                <p className="text-sm font-medium text-foreground/60">No tasks yet</p>
                <p className="text-xs text-muted-foreground">Create one to get started.</p>
              </div>
            </td>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <TaskDetailDialog task={selectedTask} open={detailOpen} onOpenChange={setDetailOpen} />
    </>
  );
}
