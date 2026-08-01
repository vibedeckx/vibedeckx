"use client";

import { CheckCircle2, Circle, ListTodo, Loader2, XCircle } from "lucide-react";
import type { Task, TaskPriority, TaskStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ActivityCard,
  ActivityCardEmpty,
  ActivityCardTitle,
  ActivityRow,
} from "./activity-card";

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

const priorityTone: Record<TaskPriority, string> = {
  urgent: "text-destructive",
  high: "text-amber-700 dark:text-amber-500",
  medium: "text-muted-foreground/70",
  low: "text-muted-foreground/70",
};

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "in_progress") return <Loader2 className="size-3.5 animate-spin text-blue-500" aria-hidden="true" />;
  if (status === "done") return <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden="true" />;
  if (status === "cancelled") return <XCircle className="size-3.5 text-muted-foreground" aria-hidden="true" />;
  return <Circle className="size-3.5 text-muted-foreground/70" aria-hidden="true" />;
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
    <ActivityCard>
      <ActivityCardTitle
        icon={<ListTodo className="size-3" aria-hidden="true" />}
        trailing={(
          <button
            type="button"
            onClick={onViewAll}
            aria-label="View all tasks"
            className="rounded-sm text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all tasks <span aria-hidden="true">→</span>
          </button>
        )}
      >
        Priority Tasks
      </ActivityCardTitle>

      {visible.length === 0 ? (
        <ActivityCardEmpty>No priority tasks</ActivityCardEmpty>
      ) : (
        visible.map((task) => (
          <ActivityRow
            key={task.id}
            data-testid="priority-task"
            aria-label={`Open task: ${task.title}`}
            onClick={() => onOpenTask(task)}
            className="items-center"
          >
            <span className="flex shrink-0 items-center">
              <StatusIcon status={task.status} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary-foreground">{task.title}</span>
            <span className={cn("shrink-0 font-mono text-[10.5px] capitalize", priorityTone[task.priority])}>
              {task.priority}
            </span>
          </ActivityRow>
        ))
      )}
    </ActivityCard>
  );
}
