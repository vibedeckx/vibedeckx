import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";

export const statusConfig: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: "To Do", color: "bg-muted text-muted-foreground" },
  in_progress: { label: "In Progress", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
  done: { label: "Done", color: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" },
  cancelled: { label: "Cancelled", color: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 line-through" },
};

export const priorityConfig: Record<TaskPriority, { label: string; color: string }> = {
  low: { label: "Low", color: "bg-muted text-muted-foreground" },
  medium: { label: "Medium", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300" },
  high: { label: "High", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300" },
  urgent: { label: "Urgent", color: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" },
};

export const statusOptions: TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
export const priorityOptions: TaskPriority[] = ["low", "medium", "high", "urgent"];

/** Display name for an `assigned_branch` value ("" is the main workspace). */
export function branchLabel(branch: string): string {
  return branch === "" ? "main" : branch;
}

/**
 * Worktrees `task` can be assigned to: every branch except its current one and
 * those another task already holds. Keys map a worktree's branch to the
 * `assigned_branch` encoding (null -> "").
 */
export function assignableBranches(
  task: Task,
  worktrees: Worktree[],
  assignedBranches: Set<string | null>,
): { key: string; label: string }[] {
  return worktrees
    .map((wt) => ({ key: wt.branch === null ? "" : wt.branch, label: wt.branch ?? "main" }))
    .filter(({ key }) => task.assigned_branch !== key && !assignedBranches.has(key));
}
