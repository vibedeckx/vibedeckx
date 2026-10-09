"use client";

import { useMemo, useState } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Archive, ArchiveRestore, CheckCircle2, ChevronRight, Circle, CircleDot, Plus, Trash2, X, XCircle } from "lucide-react";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import { MarkdownField } from "./markdown-field";
import { selfAndDescendantIds, subtaskProgress, taskFileBranch } from "./task-utils";
import { TaskParentSelect } from "./task-parent-select";
import { TaskProperties, Property, PANEL_FIELD_CLASS, PANEL_BODY_CLASS } from "./task-properties";

interface TaskDetailPanelProps {
  task: Task;
  onUpdate: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; parent_id?: string | null }) => void;
  onAssign: (taskId: string, branch: string | null) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
  onOpenSourceSession?: (task: Task) => void;
  /** Open a file linked from the description, in the task's source workspace. */
  onOpenFile?: (branch: string | null, path: string, line: number | null) => void;
  /** The project's tasks: the parent chain, the sub-tasks and the Parent picker's choices. */
  tasks: Task[];
  /** Open another task (a parent or sub-task) in the panel. */
  onSelectTask: (taskId: string) => void;
  /** Start a new-task draft filed under this task. */
  onAddSubtask: (parentId: string) => void;
}

/**
 * Side peek for one task: every field editable in place. Text fields keep a
 * local draft and save on blur, so the parent should key this by task id —
 * switching tasks then starts from a fresh draft (the outgoing field blurs,
 * and saves, before the switch lands).
 */
export function TaskDetailPanel({
  task,
  onUpdate,
  onAssign,
  onArchive,
  onUnarchive,
  onDelete,
  onClose,
  worktrees,
  assignedBranches,
  onOpenSourceSession,
  onOpenFile,
  tasks,
  onSelectTask,
  onAddSubtask,
}: TaskDetailPanelProps) {
  const archived = task.archived_at !== null;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  /** Root first; stops at a missing link (or a cycle in bad data). */
  const ancestors = useMemo(() => {
    const chain: Task[] = [];
    const seen = new Set([task.id]);
    let parent = task.parent_id ? byId.get(task.parent_id) : undefined;
    while (parent && !seen.has(parent.id)) {
      chain.unshift(parent);
      seen.add(parent.id);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    return chain;
  }, [task, byId]);
  const subtasks = useMemo(
    () => tasks.filter((t) => t.parent_id === task.id && t.archived_at === null),
    [tasks, task.id],
  );
  const progress = useMemo(() => subtaskProgress(task.id, tasks), [tasks, task.id]);
  const excludeIds = useMemo(() => selfAndDescendantIds(task.id, tasks), [tasks, task.id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-3 pt-2">
        {archived ? (
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Unarchive" onClick={() => onUnarchive(task.id)}>
            <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Archive" onClick={() => onArchive(task.id)}>
            <Archive className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Delete" onClick={() => onDelete(task.id)}>
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Close (Esc)" onClick={onClose}>
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6 edge-scrollbar">
        {ancestors.length > 0 && (
          <nav aria-label="Parent tasks" className="mb-1 flex min-w-0 flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
            {ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  className="max-w-48 truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
                  onClick={() => onSelectTask(a.id)}
                >
                  {a.title}
                </button>
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              </span>
            ))}
          </nav>
        )}
        <DraftField
          value={task.title}
          onCommit={(value) => {
            const trimmed = value.trim();
            if (trimmed && trimmed !== task.title) onUpdate(task.id, { title: trimmed });
          }}
          singleLine
          aria-label="Title"
          className="text-lg font-semibold leading-snug"
        />

        <TaskProperties
          status={task.status}
          priority={task.priority}
          assignedBranch={task.assigned_branch}
          onStatusChange={(status) => onUpdate(task.id, { status })}
          onPriorityChange={(priority) => onUpdate(task.id, { priority })}
          onAssign={(branch) => onAssign(task.id, branch)}
          worktrees={worktrees}
          assignedBranches={assignedBranches}
        >
          <Property label="Parent">
            <TaskParentSelect
              tasks={tasks}
              value={task.parent_id ?? null}
              onChange={(parent_id) => onUpdate(task.id, { parent_id })}
              excludeIds={excludeIds}
              className="h-7 max-w-full"
            />
          </Property>
          {task.source_session && (
            <Property label="From session">
              <div className="flex min-w-0">
                <SourceSessionLink
                  source={task.source_session}
                  onOpen={onOpenSourceSession ? () => onOpenSourceSession(task) : undefined}
                />
              </div>
            </Property>
          )}
          <Property label="Created">
            <span className="text-muted-foreground">{new Date(task.created_at).toLocaleString()}</span>
          </Property>
          <Property label="Updated">
            <span className="text-muted-foreground">{new Date(task.updated_at).toLocaleString()}</span>
          </Property>
        </TaskProperties>

        <div className="mt-5 border-t pt-4">
          <MarkdownField
            value={task.description ?? ""}
            label="Description"
            onOpenFile={onOpenFile ? (path, line) => onOpenFile(taskFileBranch(task), path, line) : undefined}
            className={`-mx-1.5 rounded-md px-1.5 py-1 focus-visible:bg-muted/40 ${PANEL_BODY_CLASS}`}
          >
            <DraftField
              value={task.description ?? ""}
              onCommit={(value) => {
                const next = value.trim() ? value : null;
                if (next !== task.description) onUpdate(task.id, { description: next });
              }}
              placeholder="Add a description…"
              aria-label="Description"
              className={PANEL_BODY_CLASS}
            />
          </MarkdownField>
        </div>

        <section aria-label="Sub-tasks" className="mt-5 border-t pt-4">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span>Sub-tasks</span>
            {progress.total > 0 && <span className="tabular-nums">{progress.done}/{progress.total}</span>}
          </div>
          {subtasks.length > 0 && (
            <ul className="-mx-1.5 mb-1">
              {subtasks.map((sub) => (
                <li key={sub.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/60"
                    onClick={() => onSelectTask(sub.id)}
                  >
                    <SubtaskStatusIcon status={sub.status} />
                    <span className={`truncate ${sub.status === "done" || sub.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>
                      {sub.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!archived && (
            <Button variant="ghost" size="sm" className="-mx-1.5 h-7 px-1.5 text-xs text-muted-foreground" onClick={() => onAddSubtask(task.id)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add sub-task
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}

function SubtaskStatusIcon({ status }: { status: TaskStatus }) {
  const { Icon, tone } = status === "done"
    ? { Icon: CheckCircle2, tone: "text-emerald-500" }
    : status === "cancelled"
      ? { Icon: XCircle, tone: "text-muted-foreground" }
      : status === "in_progress"
        ? { Icon: CircleDot, tone: "text-blue-500" }
        : { Icon: Circle, tone: "text-muted-foreground" };
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} aria-label={status} />;
}

/**
 * Borderless auto-growing textarea that edits a draft and saves on blur. The
 * draft exists only while focused: unfocused it shows `value`, so outside
 * changes land right away but never clobber what is being typed. Saves are
 * optimistic upstream, so dropping the draft on blur doesn't flash the old text.
 */
function DraftField({
  value,
  onCommit,
  singleLine,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  singleLine?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <textarea
      rows={1}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={() => {
        if (draft !== null) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        // An IME Enter confirms a candidate, not the field (229: legacy signal).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={`${PANEL_FIELD_CLASS} ${className ?? ""}`}
      {...props}
    />
  );
}
