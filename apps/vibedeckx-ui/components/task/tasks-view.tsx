"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { TaskTable } from "./task-table";
import { TaskForm } from "./task-form";
import { PageHeader, FilterBar, FilterChip } from "@/components/layout";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";

type StatusFilter = "all" | TaskStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "Doing" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

interface TasksViewProps {
  projectId: string | null;
  tasks: Task[];
  loading: boolean;
  worktrees: Worktree[];
  onCreateTask: (opts: { title?: string; description: string; status?: TaskStatus; priority?: TaskPriority }) => Promise<Task | null>;
  onUpdateTask: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Promise<Task | null>;
  onDeleteTask: (id: string) => Promise<void>;
}

export function TasksView({ projectId, tasks, loading, worktrees, onCreateTask, onUpdateTask, onDeleteTask }: TasksViewProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const handleAssign = (taskId: string, branch: string | null) => {
    onUpdateTask(taskId, { assigned_branch: branch });
  };

  // Counts per status drive the mono count badges on each chip.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: tasks.length, todo: 0, in_progress: 0, done: 0, cancelled: 0 };
    for (const t of tasks) c[t.status]++;
    return c;
  }, [tasks]);

  const filteredTasks = useMemo(
    () => (statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter)),
    [tasks, statusFilter],
  );

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Plus className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to view tasks.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Tasks"
        count={tasks.length}
        actions={
          <Button size="sm" onClick={() => setFormOpen(true)} className="shadow-sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Task
          </Button>
        }
      />

      <FilterBar>
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={statusFilter === f.value}
            count={counts[f.value]}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
      </FilterBar>

      <div className="flex-1 overflow-auto px-5">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            Loading tasks...
          </div>
        ) : (
          <TaskTable
            tasks={filteredTasks}
            onUpdate={onUpdateTask}
            onDelete={onDeleteTask}
            worktrees={worktrees}
            onAssign={handleAssign}
          />
        )}
      </div>

      <TaskForm
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmit={onCreateTask}
      />
    </div>
  );
}
