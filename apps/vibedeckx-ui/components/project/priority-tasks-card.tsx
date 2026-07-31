"use client";

import { ArrowRight, CheckCircle2, Circle, ListTodo, Loader2, XCircle } from "lucide-react";
import type { Task, TaskPriority, TaskStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PriorityTasksCardProps {
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onViewAll: () => void;
}

const statusOrder: Record<TaskStatus, number> = {
  in_progress: 0,
  todo: 1,
  done: 2,
  cancelled: 3,
};

const priorityOrder: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "in_progress") return <Loader2 className="size-3.5 text-blue-500" aria-hidden="true" />;
  if (status === "done") return <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden="true" />;
  if (status === "cancelled") return <XCircle className="size-3.5 text-muted-foreground" aria-hidden="true" />;
  return <Circle className="size-3.5 text-muted-foreground" aria-hidden="true" />;
}

export function PriorityTasksCard({ tasks, onOpenTask, onViewAll }: PriorityTasksCardProps) {
  const visible = [...tasks]
    .filter((task) => task.archived_at === null
      && task.status !== "done"
      && task.status !== "cancelled"
      && (task.status === "in_progress" || task.priority === "urgent" || task.priority === "high"))
    .sort((left, right) => statusOrder[left.status] - statusOrder[right.status]
      || priorityOrder[left.priority] - priorityOrder[right.priority]
      || right.updated_at.localeCompare(left.updated_at)
      || left.id.localeCompare(right.id))
    .slice(0, 5);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <ListTodo className="size-4 text-muted-foreground" aria-hidden="true" />
            Priority Tasks
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onViewAll}>
            View all tasks
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No priority tasks</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((task) => (
              <li key={task.id} data-testid="priority-task">
                <button
                  type="button"
                  aria-label={`Open task: ${task.title}`}
                  onClick={() => onOpenTask(task)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <StatusIcon status={task.status} />
                  <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                  <span className="text-[11px] capitalize text-muted-foreground">{task.priority}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
