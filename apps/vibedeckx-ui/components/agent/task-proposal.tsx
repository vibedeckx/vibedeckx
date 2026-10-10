"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  Archive, ArrowUpRight, Check, CheckCircle2, Circle, CircleDot, CornerDownRight, ListPlus, Loader2, Plus, TriangleAlert, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Task, type TaskPriority } from "@/lib/api";
import { cn } from "@/lib/utils";
import { noteTaskCreated, useProposedTasks } from "@/hooks/use-proposed-tasks";
import { takeProposalCardFocus } from "@/lib/proposal-card-focus";
import { priorityConfig, priorityOptions } from "@/components/task/task-utils";
import { TaskParentSelect } from "@/components/task/task-parent-select";
import { TASK_MARKDOWN_CLASS } from "@/components/task/task-properties";
import { TASK_MARKDOWN_COMPONENTS, TASK_REHYPE_PLUGINS } from "@/components/task/task-file-link";
import { useAgentConversation } from "./agent-conversation";

/**
 * Canonical name both CLIs' proposals arrive under. Mirrors
 * CANONICAL_PROPOSE_TASK_TOOL in packages/vibedeckx/src/session-tools-mcp.ts.
 */
export const PROPOSE_TASK_TOOL = "mcp__vibedeckx__propose_task";

interface TaskProposalUIProps {
  input: unknown;
  /** tool_use id — with the item index, each proposed task's stable identity. */
  toolUseId?: string;
}

interface ItemFields {
  title: string;
  description: string;
  priority: TaskPriority;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readProposal(input: unknown): { items: ItemFields[]; parentTaskId: string | null } {
  const raw = typeof input === "string" ? tryParse(input) : input;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(obj.tasks) ? obj.tasks : [];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const parentTaskId = str(obj.parent_task_id).trim() || null;
  return { parentTaskId, items: items.map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const priority = str(o.priority).toLowerCase();
    return {
      title: str(o.title).trim(),
      description: str(o.description),
      priority: (priorityOptions as string[]).includes(priority) ? priority as TaskPriority : "medium",
    };
  }) };
}

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: "bg-slate-400",
  medium: "bg-amber-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

const ACCENT_BUTTON = "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600";

/** Fixed so every row's priority picker lines up whatever the button says. */
const CREATE_WIDTH = "w-[84px] shrink-0 justify-center";

const ROW_GRID = "grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 border-t border-border/60 px-3 first:border-t-0";

/**
 * Confirmation card for an agent's `propose_task` call: one row per proposed
 * task, each confirmed on its own (or all at once). Nothing exists until the
 * user confirms; the project and source session come from the session this
 * card lives in, never from the model. Pending items go under the header's
 * parent — by default the agent's `parent_task_id` while it names a task of
 * this project — and a row being edited can pick its own. A confirmed row
 * collapses to one line that follows its task — created, then
 * done/cancelled/archived — and returns to the editable state if the task is
 * deleted.
 */
export function TaskProposalUI({ input, toolUseId }: TaskProposalUIProps) {
  const { sessionId, projectId, openTask } = useAgentConversation();
  const proposal = useMemo(() => readProposal(input), [input]);
  const [fields, setFields] = useState<ItemFields[]>(proposal.items);
  /** The header pick; undefined = still the proposal's default. */
  const [sharedChoice, setSharedChoice] = useState<string | null | undefined>(undefined);
  /** Per-row picks that override the header's. */
  const [parentChoices, setParentChoices] = useState<Map<number, string | null>>(() => new Map());
  /** Rows showing the editor; an empty description starts there. */
  const [editing, setEditing] = useState<Set<number>>(
    () => new Set(proposal.items.flatMap((item, i) => (item.description.trim() ? [] : [i]))),
  );
  const [submitting, setSubmitting] = useState<Set<number>>(() => new Set());
  const [errors, setErrors] = useState<Map<number, string>>(() => new Map());
  const { byItem, tasks, loading, loadError, retry } = useProposedTasks(projectId, sessionId, toolUseId);
  const sharedParentId = sharedChoice !== undefined
    ? sharedChoice
    : proposal.parentTaskId && tasks?.some((t) => t.id === proposal.parentTaskId) ? proposal.parentTaskId : null;
  const parentFor = (index: number) => parentChoices.has(index) ? parentChoices.get(index)! : sharedParentId;
  const taskTitle = (id: string | null | undefined) => (id ? tasks?.find((t) => t.id === id)?.title : undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState(false);
  useEffect(() => {
    if (!takeProposalCardFocus(toolUseId)) return;
    rootRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlighted(true);
    const timer = setTimeout(() => setHighlighted(false), 2000);
    return () => clearTimeout(timer);
  }, [toolUseId]);

  const canCreate = !!projectId && !!sessionId && !!toolUseId;

  const setEditingRow = (index: number, on: boolean) =>
    setEditing((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  /** Field to focus once a row's editor mounts — the one the user clicked. */
  const focusOnMount = useRef<{ index: number; field: "title" | "description" } | null>(null);
  const startEditing = (index: number, field: "title" | "description") => {
    focusOnMount.current = { index, field };
    setEditingRow(index, true);
  };
  const focusIfClicked = (index: number, field: "title" | "description") => (el: HTMLElement | null) => {
    const want = focusOnMount.current;
    if (!el || want?.index !== index || want.field !== field) return;
    focusOnMount.current = null;
    el.focus({ preventScroll: true });
  };
  const updateField = (index: number, patch: Partial<ItemFields>) =>
    setFields((f) => f.map((x, i) => (i === index ? { ...x, ...patch } : x)));

  const create = async (index: number) => {
    if (!canCreate || submitting.has(index)) return;
    const item = fields[index];
    if (!item.description.trim()) {
      setErrors((prev) => new Map(prev).set(index, "Description is required"));
      setEditingRow(index, true);
      return;
    }
    setSubmitting((prev) => new Set(prev).add(index));
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
    try {
      const task = await api.createTask(projectId, {
        title: item.title.trim() || undefined,
        description: item.description,
        priority: item.priority,
        source: { session_id: sessionId, tool_use_id: toolUseId, item_index: index },
        parent_id: parentFor(index),
      });
      noteTaskCreated(projectId, task);
      setEditingRow(index, false);
    } catch (err) {
      setErrors((prev) => new Map(prev).set(index, err instanceof Error ? err.message : "Failed to create task"));
    } finally {
      setSubmitting((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const pendingIndices = fields.map((_, i) => i).filter((i) => !byItem.has(i));

  if (fields.length === 0) {
    return <p className="text-xs text-muted-foreground">The proposal had no tasks.</p>;
  }

  const createdCount = fields.length - pendingIndices.length;
  const allFiled = pendingIndices.length === 0;
  const subtitle = allFiled
    ? closedSummary([...byItem.values()])
    : createdCount === 0 ? "Nothing is created until you confirm" : `${pendingIndices.length} left to confirm`;
  const creatingCount = pendingIndices.filter((i) => submitting.has(i)).length;

  return (
    <div
      ref={rootRef}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-shadow",
        highlighted && "ring-2 ring-violet-500/45 ring-offset-2 ring-offset-background",
      )}
    >
      {loadError && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-[11.5px] text-red-700 dark:text-red-400">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">Couldn&apos;t check which tasks already exist: {loadError}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-[22px] shrink-0 border-red-500/30 px-2 text-[11px] text-red-700 dark:text-red-400"
            onClick={retry}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border/60 bg-muted/40 px-3 py-2.5">
        <span
          className={cn(
            "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border",
            allFiled
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
          )}
        >
          {allFiled ? <Check className="h-3.5 w-3.5" strokeWidth={2.2} /> : <ListPlus className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight text-foreground">
            {fields.length > 1 ? `${fields.length} proposed tasks` : "Proposed task"}
          </div>
          <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        </div>
        {!allFiled && tasks && (
          <div className="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="shrink-0">{pendingIndices.length > 1 ? "File these under" : "File under"}</span>
            <TaskParentSelect
              tasks={tasks}
              value={sharedParentId}
              onChange={(parentId) => {
                setSharedChoice(parentId);
                setParentChoices(new Map());
              }}
              sessionId={sessionId}
              disabled={submitting.size > 0}
              className="h-[26px] max-w-[230px] bg-card text-[11.5px]"
            />
          </div>
        )}
      </div>
      <div className="flex flex-col">
        {fields.map((item, index) => {
          const created = byItem.get(index);
          if (created) {
            return (
              <CreatedTaskRow key={index} task={created} parentTitle={taskTitle(created.parent_id)} onOpen={openTask} />
            );
          }
          const busy = submitting.has(index);
          const error = errors.get(index);
          const missing = !item.description.trim();
          const ownParent = parentFor(index);
          const createButton = (accent: boolean, inRowWidth = false) => (
            <Button
              size="sm"
              variant={accent ? "default" : "outline"}
              className={cn("h-6 gap-1 rounded-[7px] px-2.5 text-[11.5px]", accent && ACCENT_BUTTON, inRowWidth && CREATE_WIDTH)}
              aria-label="Create task"
              onClick={() => void create(index)}
              disabled={!canCreate || busy || loading || (editing.has(index) && missing)}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {busy ? "Creating…" : error && !missing ? "Retry" : "Create"}
            </Button>
          );
          const priority = (
            <PrioritySelect
              value={item.priority}
              onChange={(p) => updateField(index, { priority: p })}
              disabled={busy}
            />
          );
          const errorLine = error && (
            <p className="col-span-2 col-start-2 flex items-center gap-1.5 text-[11.5px] break-words text-red-500">
              <TriangleAlert className="h-3 w-3 shrink-0" />
              {error}
            </p>
          );

          if (editing.has(index)) {
            return (
              <div key={index} className={cn(ROW_GRID, "bg-muted/40 pt-[11px] pb-3", busy && "opacity-70")}>
                <span className="pt-[7px] font-mono text-[10.5px] text-muted-foreground/70">{rowNumber(index)}</span>
                <Input
                  value={item.title}
                  onChange={(e) => updateField(index, { title: e.target.value })}
                  placeholder="Title"
                  className="h-[30px] rounded-lg bg-card text-[13px] font-medium"
                  aria-label="Task title"
                  ref={focusIfClicked(index, "title")}
                  disabled={busy}
                />
                <span className="flex items-center gap-1.5 self-start pt-[3px]">
                  {priority}
                  {/* Keeps the priority in line with the other rows' while Create sits below. */}
                  <span className={CREATE_WIDTH} aria-hidden />
                </span>
                <Textarea
                  value={item.description}
                  onChange={(e) => updateField(index, { description: e.target.value })}
                  placeholder="What's left to do, and how to tell it's done"
                  className={cn(
                    "col-span-2 col-start-2 mt-1 min-h-[84px] rounded-lg bg-card font-mono text-[11.5px] leading-relaxed",
                    missing && "border-red-500/50 focus-visible:ring-red-500/20",
                  )}
                  aria-label="Task description"
                  aria-invalid={missing || undefined}
                  ref={focusIfClicked(index, "description")}
                  disabled={busy}
                />
                {errorLine ?? (missing && (
                  <p className="col-span-2 col-start-2 flex items-center gap-1.5 text-[11.5px] text-red-500">
                    <TriangleAlert className="h-3 w-3 shrink-0" />
                    Description is required
                  </p>
                ))}
                <div className="col-span-2 col-start-2 flex min-w-0 items-center gap-2 text-[10.5px] text-muted-foreground">
                  {tasks && (
                    <>
                      <span className="shrink-0">Parent</span>
                      <TaskParentSelect
                        tasks={tasks}
                        value={ownParent}
                        onChange={(parentId) => setParentChoices((prev) => new Map(prev).set(index, parentId))}
                        sessionId={sessionId}
                        disabled={busy}
                        className="h-6 max-w-56 bg-card text-[11px]"
                      />
                    </>
                  )}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2.5 text-[11.5px] text-muted-foreground"
                    onClick={() => setEditingRow(index, false)}
                    disabled={busy}
                  >
                    Collapse
                  </Button>
                  {createButton(true)}
                </div>
              </div>
            );
          }

          return (
            <div key={index} className={cn(ROW_GRID, "pt-[11px] pb-3", busy && "opacity-70")}>
              <span className="pt-0.5 font-mono text-[10.5px] text-muted-foreground/70">{rowNumber(index)}</span>
              <button
                type="button"
                data-proposed-title
                title="Click to edit"
                className="-mx-1 -my-px cursor-text rounded px-1 py-px text-left text-[13px] font-medium break-words text-foreground hover:bg-muted disabled:cursor-default"
                onClick={() => startEditing(index, "title")}
                disabled={busy}
              >
                {item.title || <span className="text-muted-foreground">Untitled</span>}
              </button>
              <span className="flex items-center gap-1.5 self-start">
                {priority}
                {createButton(pendingIndices.length === 1, true)}
              </span>
              <div
                data-markdown-field="Task description"
                title="Click to edit"
                className={cn(
                  "col-start-2 line-clamp-2 cursor-text text-xs leading-normal text-muted-foreground [&_*]:my-0 [&_code]:rounded [&_code]:px-1 [&_code]:py-0 [&_code]:text-[11px]",
                  TASK_MARKDOWN_CLASS,
                )}
                onClick={(e) => {
                  if (busy || (e.target as Element).closest("a, button")) return;
                  if (!window.getSelection()?.isCollapsed) return;
                  startEditing(index, "description");
                }}
              >
                {missing ? (
                  <span className="italic">No description</span>
                ) : (
                  <Streamdown mode="static" rehypePlugins={TASK_REHYPE_PLUGINS} components={TASK_MARKDOWN_COMPONENTS}>
                    {item.description}
                  </Streamdown>
                )}
              </div>
              {ownParent !== sharedParentId && (
                <span className="col-start-2 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{taskTitle(ownParent) ?? "No parent"}</span>
                </span>
              )}
              {errorLine}
            </div>
          );
        })}
      </div>
      {fields.length > 1 && !allFiled && (
        <div className="flex items-center gap-2.5 border-t border-border/60 bg-muted/40 px-3 py-[9px]">
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex gap-[3px]" aria-hidden>
              {fields.map((_, i) => (
                <i
                  key={i}
                  className={cn(
                    "h-1 w-3.5 rounded-sm",
                    byItem.has(i) ? "bg-violet-500" : submitting.has(i) ? "bg-violet-500/40" : "bg-border",
                  )}
                />
              ))}
            </span>
            {creatingCount > 0 ? `Creating ${creatingCount}…` : `${createdCount} of ${fields.length} created`}
          </span>
          <span className="flex-1" />
          {pendingIndices.length > 1 && (
            <Button
              size="sm"
              className={cn("h-7 gap-1.5 rounded-lg px-3 text-xs", ACCENT_BUTTON)}
              onClick={() => pendingIndices.forEach((i) => void create(i))}
              disabled={!canCreate || loading || creatingCount > 0}
            >
              <ListPlus className="h-3 w-3" />
              Create all {pendingIndices.length}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const rowNumber = (index: number) => String(index + 1).padStart(2, "0");

/** "All filed", plus how many of the tasks have since been closed and how. */
function closedSummary(tasks: Task[]): string {
  const archived = tasks.filter((t) => t.archived_at !== null).length;
  const live = tasks.filter((t) => t.archived_at === null);
  const parts = [
    [live.filter((t) => t.status === "done").length, "done"],
    [live.filter((t) => t.status === "cancelled").length, "cancelled"],
    [archived, "archived"],
  ] as const;
  const closed = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return closed.length ? `All filed · ${closed.join(", ")}` : "All filed";
}

function PrioritySelect({ value, onChange, disabled }: {
  value: TaskPriority;
  onChange: (priority: TaskPriority) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TaskPriority)} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className="h-6! w-[88px] shrink-0 justify-between gap-1 rounded-[7px] bg-card py-0 pr-1.5 pl-2 text-[11px] font-medium"
        aria-label="Task priority"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {priorityOptions.map((p) => (
          <SelectItem key={p} value={p}>
            <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", PRIORITY_DOT[p])} />
            {priorityConfig[p].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreatedTaskRow({ task, parentTitle, onOpen }: { task: Task; parentTitle?: string; onOpen?: (task: Task) => void }) {
  const closed = task.status === "done" || task.status === "cancelled" || task.archived_at !== null;
  const { Icon, label, tone } = task.archived_at !== null
    ? { Icon: Archive, label: "Archived", tone: "text-muted-foreground" }
    : task.status === "done"
      ? { Icon: CheckCircle2, label: "Done", tone: "text-emerald-500" }
      : task.status === "cancelled"
        ? { Icon: XCircle, label: "Cancelled", tone: "text-muted-foreground" }
        : task.status === "in_progress"
          ? { Icon: CircleDot, label: "In progress", tone: "text-blue-500" }
          : { Icon: Circle, label: "Created", tone: "text-violet-500" };
  return (
    <div
      data-created-task
      className={cn(ROW_GRID, "items-center py-[9px]", closed ? "bg-card" : "bg-violet-500/[0.04]")}
    >
      <Icon className={cn("h-[15px] w-[15px] justify-self-center", tone)} />
      <p
        className={cn(
          "text-[13px] font-medium break-words",
          closed ? "text-muted-foreground line-through decoration-border" : "text-foreground",
        )}
      >
        {task.title}
      </p>
      {onOpen && (
        <Button
          variant="ghost"
          size="sm"
          className="col-start-3 row-span-2 row-start-1 h-6 gap-1 px-2 text-[11.5px] text-muted-foreground"
          onClick={() => onOpen(task)}
        >
          View
          <ArrowUpRight className="h-3 w-3" />
        </Button>
      )}
      <div className="col-start-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn("font-medium", tone)}>{label}</span>
        <span className="text-border">·</span>
        <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", PRIORITY_DOT[task.priority])} />
        {priorityConfig[task.priority].label}
        {parentTitle && (
          <>
            <span className="text-border">·</span>
            <span className="flex max-w-[220px] min-w-0 items-center gap-1">
              <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{parentTitle}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
