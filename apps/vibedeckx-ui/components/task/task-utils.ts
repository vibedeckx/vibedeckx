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
 * Worktrees a task currently on `current` can be assigned to: every branch
 * except that one and those another task already holds. Keys map a worktree's
 * branch to the `assigned_branch` encoding (null -> "").
 */
export function assignableBranches(
  current: string | null,
  worktrees: Worktree[],
  assignedBranches: Set<string | null>,
): { key: string; label: string }[] {
  return worktrees
    .map((wt) => ({ key: wt.branch === null ? "" : wt.branch, label: wt.branch ?? "main" }))
    .filter(({ key }) => current !== key && !assignedBranches.has(key));
}

/**
 * The workspace a task's file links resolve in: the one the proposing session
 * ran in (null = main), else main. Never `assigned_branch` — that is where the
 * work goes, not where the referenced files were written, and re-assigning
 * must not move the links.
 */
export function taskFileBranch(task: Pick<Task, "source_session">): string | null {
  return task.source_session?.branch ?? null;
}

const MD_LINK = /\[([^\]\n]*)\]\(\s*[^)\s]*\s*\)/g;

/** One-line description preview: `[label](href)` collapses to `label`, then truncate. */
export function descriptionPreview(description: string, max = 80): string {
  const text = description.replace(MD_LINK, "$1");
  return text.length > max ? text.slice(0, max) + "..." : text;
}

/** `task` and every task nested under it — what it can't be moved beneath. */
export function selfAndDescendantIds(taskId: string, tasks: Pick<Task, "id" | "parent_id">[]): Set<string> {
  const ids = new Set([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Tasks ordered as a tree: each parent followed by its sub-tasks, siblings in
 * the input order, with their nesting depth. A task whose parent isn't in the
 * list (filtered out, archived, missing) is shown at the top level.
 */
export function orderAsTree<T extends Pick<Task, "id" | "parent_id">>(tasks: T[]): { task: T; depth: number }[] {
  const present = new Set(tasks.map((t) => t.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const t of tasks) {
    if (t.parent_id && t.parent_id !== t.id && present.has(t.parent_id)) {
      const list = children.get(t.parent_id) ?? [];
      list.push(t);
      children.set(t.parent_id, list);
    } else {
      roots.push(t);
    }
  }
  const out: { task: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (t: T, depth: number) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ task: t, depth });
    for (const child of children.get(t.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // A cycle (only possible from bad data) has no root; don't lose its rows.
  for (const t of tasks) visit(t, 0);
  return out;
}

/** Done / total over a task's direct sub-tasks (cancelled ones don't count). */
export function subtaskProgress(taskId: string, tasks: Pick<Task, "parent_id" | "status" | "archived_at">[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.parent_id !== taskId || t.archived_at !== null || t.status === "cancelled") continue;
    total += 1;
    if (t.status === "done") done += 1;
  }
  return { done, total };
}
