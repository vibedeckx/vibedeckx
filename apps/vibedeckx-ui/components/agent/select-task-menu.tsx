"use client";

import { useCallback, useState } from "react";
import { Check, CheckCircle2, Circle, CircleDot, ListChecks, ListTodo, Loader2, Search, X, XCircle } from "lucide-react";
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { api, type Task, type TaskStatus } from "@/lib/api";
import { buildUrl } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { directSubtasks, type SelectedTaskSubtask } from "@/lib/selected-tasks";
import { PRIORITY_DOT } from "./task-proposal";

const STATUS_ICON: Record<TaskStatus, { Icon: typeof Circle; tone: string }> = {
  todo: { Icon: Circle, tone: "text-muted-foreground" },
  in_progress: { Icon: CircleDot, tone: "text-blue-500" },
  done: { Icon: CheckCircle2, tone: "text-emerald-500" },
  cancelled: { Icon: XCircle, tone: "text-muted-foreground" },
};

/** Open work first; the list keeps the Tasks page order within each group. */
const STATUS_ORDER: Record<TaskStatus, number> = { in_progress: 0, todo: 1, done: 2, cancelled: 3 };

/**
 * "Select task": the composer's entry for pointing the next message at
 * existing project tasks — to discuss one, have the agent work on it, or ask
 * for a change. Same submenu shape as Remote access; picks toggle and keep the
 * menu open. The picked tasks ride along as a `<vselected-tasks>` block
 * (lib/selected-tasks.ts).
 */
export function SelectTaskMenuItem({
  projectId,
  selected,
  onToggle,
  disabled,
}: {
  projectId: string | null;
  selected: Task[];
  /** A pick carries the task's direct sub-tasks from the loaded list (lib/selected-tasks.ts). */
  onToggle: (task: Task & { subtasks: SelectedTaskSubtask[] }, select: boolean) => void;
  disabled?: boolean;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");

  // Fetched on each open, like Remote access: the list must reflect edits made
  // on the Tasks page since, and most users never open this menu.
  const load = useCallback(() => {
    if (!projectId) return;
    setLoadError(false);
    api.getTasks(projectId)
      .then((list) => setTasks([...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])))
      .catch(() => setLoadError(true));
  }, [projectId]);

  const term = query.trim().toLowerCase();
  const visible = (tasks ?? []).filter((t) => !term || t.title.toLowerCase().includes(term));

  const openTasksPage = () => {
    window.history.pushState(null, "", buildUrl({ tab: "tasks" }));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <DropdownMenuSub onOpenChange={(open) => { if (open) { setQuery(""); load(); } }}>
      <DropdownMenuSubTrigger disabled={disabled || !projectId}>
        <ListTodo className="mr-2 size-4" />
        Select task
        {selected.length > 0 && (
          <span className="ml-auto rounded-full bg-violet-500/15 px-1.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            {selected.length}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[360px] p-1">
        <div className="px-2 pt-1.5 pb-2">
          <div className="text-sm font-medium">Select task</div>
          <div className="text-xs text-muted-foreground">Discuss, work on or change these in your next message</div>
        </div>
        <div className="relative px-1 pb-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-[60%] text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The menu's typeahead would otherwise eat the keystrokes.
            onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            className="h-7 w-full rounded-md border bg-transparent pr-2 pl-7 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {tasks === null && !loadError && (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading tasks…
            </div>
          )}
          {loadError && <div className="px-2 py-3 text-sm text-muted-foreground">Could not load tasks.</div>}
          {tasks !== null && !loadError && visible.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
              <div className="flex size-9 items-center justify-center rounded-full bg-muted">
                <ListChecks className="size-4 text-muted-foreground" />
              </div>
              <div className="text-sm font-medium">{tasks.length === 0 ? "No tasks yet" : "No matching tasks"}</div>
              {tasks.length === 0 && (
                <div className="text-xs text-muted-foreground">Tasks you add to this project show up here.</div>
              )}
            </div>
          )}
          {visible.map((task) => {
            const isSelected = selected.some((s) => s.id === task.id);
            const { Icon, tone } = STATUS_ICON[task.status];
            const closed = task.status === "done" || task.status === "cancelled";
            return (
              <DropdownMenuItem
                key={task.id}
                role="menuitemcheckbox"
                aria-checked={isSelected}
                // Keep the menu open: picking two tasks should take two clicks.
                onSelect={(e) => {
                  e.preventDefault();
                  onToggle({ ...task, subtasks: directSubtasks(tasks ?? [], task.id) }, !isSelected);
                }}
                className="gap-2.5 py-1.5"
              >
                <Icon className={cn("size-4 shrink-0", tone)} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate", closed && "text-muted-foreground")}>{task.title}</span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", PRIORITY_DOT[task.priority])} />
                    <span className="capitalize">{task.priority}</span>
                  </span>
                </span>
                <Check className={cn("size-4 shrink-0 text-violet-600 dark:text-violet-400", !isSelected && "invisible")} />
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openTasksPage} className="text-muted-foreground">
          <ListChecks className="size-4" />
          Open Tasks…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The tasks the next message points at, each removable by its own ✕. One-shot: cleared on send. */
export function SelectedTaskChips({ tasks, onRemove }: { tasks: Task[]; onRemove: (task: Task) => void }) {
  if (tasks.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-12 pr-2 pt-1.5 pb-0.5">
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => onRemove(task)}
          // Narrow on purpose; the full title is on hover.
          title={task.title}
          className="inline-flex max-w-44 shrink-0 items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
        >
          <ListTodo className="size-3 shrink-0" />
          <span className="truncate">{task.title}</span>
          <X className="size-3 shrink-0" />
        </button>
      ))}
    </div>
  );
}
