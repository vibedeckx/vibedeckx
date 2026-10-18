"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, ChevronUp, GitBranch, MessageSquare, MessageSquarePlus, Plus, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MarkdownField } from "./markdown-field";
import { agoPhrase, footerDate, selfAndDescendantIds, subtaskProgress, taskFileBranch } from "./task-utils";
import { TaskParentSelect } from "./task-parent-select";
import { TaskProperties, Property, PANEL_FIELD_CLASS, PANEL_BODY_CLASS, PANEL_BODY_TEXT_CLASS } from "./task-properties";
import { PriorityGlyph, StatusGlyph } from "./task-glyphs";
import { RowAction } from "./task-row";

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
  /** Open a new conversation in a workspace with this task already picked in its composer. */
  onStartSession?: (task: Task, branch: string | null) => void;
  /** Open a file linked from the description, in the task's source workspace. */
  onOpenFile?: (branch: string | null, path: string, line: number | null) => void;
  /** The project's tasks: the parent chain, the sub-tasks and the Parent picker's choices. */
  tasks: Task[];
  /** Open another task (a parent or sub-task) in the panel. */
  onSelectTask: (taskId: string) => void;
  /** Start a new-task draft filed under this task. */
  onAddSubtask: (parentId: string) => void;
  /** Where the task sits in the list (0-based); null when it isn't in the current view. */
  position?: { index: number; total: number } | null;
  /** Previous / next task in the list. */
  onStep?: (delta: 1 | -1) => void;
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
  onStartSession,
  onOpenFile,
  tasks,
  onSelectTask,
  onAddSubtask,
  position,
  onStep,
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
  // Segments of the progress bar: done, then in progress, then the rest.
  const segments = useMemo(() => {
    const counted = subtasks.filter((t) => t.status !== "cancelled");
    const done = counted.filter((t) => t.status === "done").length;
    const doing = counted.filter((t) => t.status === "in_progress").length;
    return counted.map((_, i) => (i < done ? "done" : i < done + doing ? "doing" : "todo"));
  }, [subtasks]);
  const [editingDescription, setEditingDescription] = useState(false);

  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      <div className="flex h-[42px] shrink-0 items-center gap-0.5 border-b border-border/60 pr-2 pl-3">
        {onStep && (
          <>
            <RowAction title="Previous (↑)" onClick={() => onStep(-1)}><ChevronUp className="size-3.5" /></RowAction>
            <RowAction title="Next (↓)" onClick={() => onStep(1)}><ChevronDown className="size-3.5" /></RowAction>
          </>
        )}
        {position && (
          <span className="mx-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
            {position.index + 1} / {position.total}
          </span>
        )}
        <span className="flex-1" />
        {onStartSession && !archived && (
          <>
            <StartSessionMenu worktrees={worktrees} onPick={(branch) => onStartSession(task, branch)} />
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          </>
        )}
        {!archived && (
          <RowAction title="Archive" onClick={() => onArchive(task.id)}><Archive className="size-[13px]" /></RowAction>
        )}
        <RowAction title="Delete" onClick={() => onDelete(task.id)}><Trash2 className="size-[13px]" /></RowAction>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <RowAction title="Close (Esc)" onClick={onClose}><X className="size-3.5" /></RowAction>
      </div>

      {archived && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary py-2 pr-3 pl-3.5 text-xs text-muted-foreground">
          <Archive className="size-[13px] shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            Archived {new Date(task.archived_at!).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — hidden from the list and the sidebar
          </span>
          <Button variant="outline" size="sm" className="ml-auto h-6 gap-1 px-2 text-[11.5px]" onClick={() => onUnarchive(task.id)}>
            <ArchiveRestore className="size-3" />
            Unarchive
          </Button>
        </div>
      )}

      {/* Column so a short description's section can take the leftover
          height: Sub-tasks then sits above the footer instead of leaving
          the blank space under it. Nothing shrinks — an overflowing column
          would squash the title textarea to nothing; it scrolls instead. */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-auto [&>*]:shrink-0 px-6 pt-[18px] pb-[22px] edge-scrollbar", archived && "opacity-[.78]")}>
        {ancestors.length > 0 && (
          <nav aria-label="Parent tasks" className="mb-1 -ml-[5px] flex min-w-0 flex-wrap items-center gap-px text-[11.5px] text-muted-foreground/70">
            {ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-px">
                <button
                  type="button"
                  className="max-w-[280px] truncate rounded-[5px] px-[5px] py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onSelectTask(a.id)}
                >
                  {a.title}
                </button>
                <ChevronRight className="size-[11px] shrink-0" aria-hidden />
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
          className="mb-3.5 text-lg leading-[1.32] font-semibold tracking-[-0.02em] hover:bg-muted focus:bg-muted/60"
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
          readOnlyBranch={archived}
        >
          {!(archived && !task.parent_id) && (
            <Property label="Parent">
              <TaskParentSelect
                tasks={tasks}
                value={task.parent_id ?? null}
                onChange={(parent_id) => onUpdate(task.id, { parent_id })}
                excludeIds={excludeIds}
                field
              />
            </Property>
          )}
          {task.source_session && (
            <Property label="From session">
              {task.source_session.exists ? (
                <button
                  type="button"
                  disabled={!onOpenSourceSession}
                  onClick={() => onOpenSourceSession?.(task)}
                  title={task.source_session.title?.trim() || "Untitled session"}
                  className="-ml-2 inline-flex h-[30px] min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-primary hover:bg-muted disabled:text-foreground"
                >
                  <MessageSquare className="size-[13px] shrink-0" aria-hidden />
                  <span className="truncate">{task.source_session.title?.trim() || "Untitled session"}</span>
                </button>
              ) : (
                <span className="inline-flex h-[30px] items-center italic text-muted-foreground">Source session deleted</span>
              )}
            </Property>
          )}
        </TaskProperties>

        <Section
          title="Description"
          className="flex flex-[1_0_auto] flex-col"
          hint={!editingDescription && task.description?.trim() ? "Click to edit · Markdown" : undefined}
        >
          <MarkdownField
            value={task.description ?? ""}
            label="Description"
            onOpenFile={onOpenFile ? (path, line) => onOpenFile(taskFileBranch(task), path, line) : undefined}
            className={`-mx-1.5 flex-1 rounded-md px-1.5 py-1 text-secondary-foreground hover:bg-secondary focus-visible:bg-muted/40 ${PANEL_BODY_TEXT_CLASS}`}
          >
            <DraftField
              value={task.description ?? ""}
              onCommit={(value) => {
                const next = value.trim() ? value : null;
                if (next !== task.description) onUpdate(task.id, { description: next });
              }}
              onEditingChange={setEditingDescription}
              placeholder="Add a description…"
              aria-label="Description"
              className={`${PANEL_BODY_CLASS} focus:border focus:border-primary focus:bg-card focus:px-3 focus:py-2.5 focus:font-mono focus:text-xs focus:leading-[1.65] focus:shadow-[0_0_0_3px_var(--accent)]`}
            />
          </MarkdownField>
          {editingDescription && (
            <div className="mt-2 flex items-center gap-2.5 text-[11px] text-muted-foreground/70">
              <KeyHint keys={["⌘", "↵"]}>save</KeyHint>
              <KeyHint keys={["Esc"]}>cancel</KeyHint>
              <span className="flex-1" />
              <span>Saves on blur</span>
            </div>
          )}
        </Section>

        <Section
          title="Sub-tasks"
          aria-label="Sub-tasks"
          compact
          // Nothing to list and nothing to add: say so in the header, no body.
          hint={archived && subtasks.length === 0 ? "None" : undefined}
          extra={progress.total > 0 && (
            <>
              <span className="ml-0.5 flex gap-[3px]" aria-hidden>
                {segments.map((seg, i) => (
                  <i
                    key={i}
                    className={cn(
                      "h-1 w-[18px] rounded-sm",
                      seg === "done" ? "bg-[oklch(0.6_0.14_152)]" : seg === "doing" ? "bg-[oklch(0.58_0.16_245)]" : "bg-border",
                    )}
                  />
                ))}
              </span>
              <span className="font-mono text-[10.5px] font-normal tabular-nums text-muted-foreground/70">{progress.done}/{progress.total}</span>
            </>
          )}
        >
          {subtasks.length > 0 && (
            <ul className="-mx-2 flex flex-col">
              {subtasks.map((sub) => {
                const closed = sub.status === "done" || sub.status === "cancelled";
                return (
                  <li key={sub.id}>
                    <button
                      type="button"
                      className="flex h-7 w-full min-w-0 items-center gap-[9px] rounded-md px-2 text-left hover:bg-muted"
                      onClick={() => onSelectTask(sub.id)}
                    >
                      <StatusGlyph status={sub.status} />
                      <span className={cn("min-w-0 flex-1 truncate text-[12.5px] font-[450]", closed && "text-muted-foreground line-through decoration-border")}>
                        {sub.title}
                      </span>
                      <PriorityGlyph priority={sub.priority} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!archived && (
            <button
              type="button"
              className="-mx-2 flex h-7 w-[calc(100%+1rem)] items-center gap-[9px] rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onAddSubtask(task.id)}
            >
              <span className="grid size-3.5 place-items-center rounded-full border-[1.5px] border-dashed border-border text-muted-foreground/70">
                <Plus className="size-2" strokeWidth={3} />
              </span>
              Add sub-task
            </button>
          )}
        </Section>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-border/60 bg-secondary px-4 text-[11px] text-muted-foreground">
        <span title={new Date(task.created_at).toLocaleString()}>Created {footerDate(task.created_at)}</span>
        <span className="text-border" aria-hidden>·</span>
        <span title={new Date(task.updated_at).toLocaleString()}>Updated {agoPhrase(task.updated_at)}</span>
        <span className="flex-1" />
        {position && <KeyHint keys={["↑", "↓"]}>switch</KeyHint>}
        <KeyHint keys={["Esc"]} className="ml-2">close</KeyHint>
      </div>
    </div>
  );
}

/**
 * "Start session ▾": the Tasks page has no current workspace, so the user
 * names the one the new conversation opens in.
 */
function StartSessionMenu({ worktrees, onPick }: { worktrees: Worktree[]; onPick: (branch: string | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground outline-none hover:bg-border/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-border/60 data-[state=open]:text-foreground"
        >
          <MessageSquarePlus className="size-[13px]" aria-hidden />
          Start session
          <ChevronDown className="size-3 text-muted-foreground/70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      {/* As wide as the button; long branch names truncate, full name on hover. */}
      <DropdownMenuContent align="end" className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-0 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Select workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {worktrees.map((wt) => (
          <DropdownMenuItem key={wt.branch ?? ""} onClick={() => onPick(wt.branch)} title={wt.branch ?? "main"} className="gap-2 font-mono text-[12px]">
            <GitBranch className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{wt.branch ?? "main"}</span>
          </DropdownMenuItem>
        ))}
        {worktrees.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No workspaces</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `compact`: tighter header spacing, for list sections like Sub-tasks. */
function Section({ title, hint, extra, compact, className, children, ...props }: { title: string; hint?: string; extra?: ReactNode; compact?: boolean; className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <section className={cn("mt-[18px] border-t border-border/60", compact ? "pt-3" : "pt-3.5", className)} {...props}>
      <div className={cn("flex h-5 items-center gap-2 text-[11.5px] font-medium text-muted-foreground", compact ? "mb-1" : "mb-2")}>
        {title}
        {extra}
        {hint && <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-grid h-[17px] min-w-[17px] place-items-center rounded border border-b-[1.5px] border-border bg-card px-1 font-mono text-[10px] leading-none text-secondary-foreground", className)}>
      {children}
    </kbd>
  );
}

function KeyHint({ keys, className, children }: { keys: string[]; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      {children}
    </span>
  );
}

/**
 * Borderless auto-growing textarea that edits a draft and saves on blur. The
 * draft exists only while focused: unfocused it shows `value`, so outside
 * changes land right away but never clobber what is being typed. Saves are
 * optimistic upstream, so dropping the draft on blur doesn't flash the old text.
 * Esc throws the draft away instead.
 */
function DraftField({
  value,
  onCommit,
  singleLine,
  onEditingChange,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  singleLine?: boolean;
  /** Focus in / out: the field is being edited. */
  onEditingChange?: (editing: boolean) => void;
  className?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);

  return (
    <textarea
      rows={1}
      value={draft ?? value}
      onFocus={() => {
        setDraft(value);
        onEditingChange?.(true);
      }}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={() => {
        if (draft !== null && !cancelRef.current) onCommit(draft);
        cancelRef.current = false;
        setDraft(null);
        onEditingChange?.(false);
      }}
      onKeyDown={(e) => {
        // An IME Enter confirms a candidate, not the field (229: legacy signal).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          e.preventDefault();
          cancelRef.current = true;
          e.currentTarget.blur();
          return;
        }
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
