"use client";

import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Loader2, PencilLine, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type Task, type TaskPriority, type TaskStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { diffLines, foldUnchanged } from "@/lib/line-diff";
import { noteTaskChanged, useProposedTasks } from "@/hooks/use-proposed-tasks";
import { priorityConfig, priorityOptions, statusConfig, statusOptions } from "@/components/task/task-utils";
import { ACCENT_BUTTON, PRIORITY_DOT } from "./task-proposal";
import { useAgentConversation } from "./agent-conversation";

/**
 * Canonical name both CLIs' update proposals arrive under. Mirrors
 * CANONICAL_PROPOSE_TASK_UPDATE_TOOL in packages/vibedeckx/src/task-tools-mcp.ts.
 */
export const PROPOSE_TASK_UPDATE_TOOL = "mcp__vibedeckx-tasks__propose_task_update";

type Field = "title" | "status" | "priority" | "description";
const FIELDS: Field[] = ["title", "status", "priority", "description"];
const FIELD_LABEL: Record<Field, string> = { title: "Title", status: "Status", priority: "Priority", description: "Description" };

export interface ProposedUpdate {
  taskId: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}

/** Mirrors the limits parseProposeTaskUpdateArgs enforces in packages/vibedeckx/src/task-tools-mcp.ts. */
const MAX_ITEMS = 10;
const TASK_ID_MAX = 200;
const TASK_TITLE_MAX = 200;
const TASK_DESCRIPTION_MAX = 20_000;

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const itemsOf = (input: unknown): unknown[] | null => {
  const raw = typeof input === "string" ? tryParse(input) : input;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Array.isArray(obj.updates) ? obj.updates : null;
};

/**
 * Why the server rejected this call on shape alone, or null. Replayed here for
 * the same reason as proposalRejection: the card never sees the tool result.
 * Shape is the server's only whole-batch rejection; an unknown task or a no-op
 * only drops that entry (task-tools-mcp-routes.ts), and the card renders the
 * same rows as "no longer exists" / "up to date", so the two always agree.
 */
export function updateProposalRejection(input: unknown): string | null {
  const items = itemsOf(input);
  if (!items || items.length === 0) return "The proposal had no updates.";
  if (items.length > MAX_ITEMS) return `It listed ${items.length} updates; at most ${MAX_ITEMS} fit in one proposal.`;
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const taskId = typeof o.task_id === "string" ? o.task_id.trim() : "";
    if (!taskId || taskId.length > TASK_ID_MAX) return `Update ${i + 1} had no task id.`;
    if (seen.has(taskId)) return `It listed one task more than once.`;
    seen.add(taskId);
    if (o.title !== undefined && (typeof o.title !== "string" || !o.title.trim() || o.title.trim().length > TASK_TITLE_MAX)) {
      return `Update ${i + 1} had an empty or overlong title.`;
    }
    if (o.description !== undefined
      && (typeof o.description !== "string" || !o.description.trim() || o.description.length > TASK_DESCRIPTION_MAX)) {
      return `Update ${i + 1} had an empty or overlong description.`;
    }
    if (o.status !== undefined && !(statusOptions as unknown[]).includes(o.status)) return `Update ${i + 1} had an unknown status.`;
    if (o.priority !== undefined && !(priorityOptions as unknown[]).includes(o.priority)) {
      return `Update ${i + 1} had an unknown priority.`;
    }
    if (FIELDS.every((f) => o[f] === undefined)) return `Update ${i + 1} changed nothing.`;
  }
  return null;
}

function readUpdates(input: unknown): ProposedUpdate[] {
  return (itemsOf(input) ?? []).map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      taskId: typeof o.task_id === "string" ? o.task_id.trim() : "",
      ...(typeof o.title === "string" ? { title: o.title.trim() } : {}),
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      ...(typeof o.status === "string" ? { status: o.status as TaskStatus } : {}),
      ...(typeof o.priority === "string" ? { priority: o.priority as TaskPriority } : {}),
    };
  });
}

/**
 * The proposed fields that still differ from the task. Empty = nothing left
 * to apply: the card derives "applied" from the task itself rather than
 * storing it, so it survives a reload and reflects edits made elsewhere.
 */
export function pendingFields(update: ProposedUpdate, task: Task): Field[] {
  return FIELDS.filter((f) => update[f] !== undefined && update[f] !== (task[f] ?? ""));
}

const ROW = "border-t border-border/60 px-3 py-2.5 first:border-t-0";

/**
 * Confirmation card for an agent's `propose_task_update` call: one row per
 * task, each showing the proposed changes against the task's CURRENT values
 * (from the shared project task list) and applied on its own or all at once.
 * Nothing changes until the user applies; the apply goes through the ordinary
 * task update route.
 */
export function TaskUpdateProposalUI({ input }: { input: unknown }) {
  const { sessionId, projectId, openTask } = useAgentConversation();
  const updates = useMemo(() => readUpdates(input), [input]);
  const rejection = useMemo(() => updateProposalRejection(input), [input]);
  const { tasks, loading, loadError, retry } = useProposedTasks(projectId, sessionId, null);
  const [submitting, setSubmitting] = useState<Set<number>>(() => new Set());
  const [applyingAll, setApplyingAll] = useState(false);
  const [errors, setErrors] = useState<Map<number, string>>(() => new Map());

  const rows = updates.map((update) => {
    const task = tasks?.find((t) => t.id === update.taskId) ?? null;
    return { update, task, changes: task ? pendingFields(update, task) : [] };
  });
  const pendingIndices = rows.flatMap((row, i) => (row.changes.length > 0 ? [i] : []));

  const apply = async (index: number) => {
    const { update, task, changes } = rows[index];
    if (!projectId || !task || changes.length === 0 || submitting.has(index)) return;
    setSubmitting((prev) => new Set(prev).add(index));
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
    try {
      const patch = Object.fromEntries(changes.map((f) => [f, update[f]]));
      noteTaskChanged(projectId, await api.updateTask(task.id, patch));
    } catch (err) {
      setErrors((prev) => new Map(prev).set(index, err instanceof Error ? err.message : "Failed to update task"));
    } finally {
      setSubmitting((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const applyAll = async () => {
    setApplyingAll(true);
    try {
      for (const index of pendingIndices) await apply(index);
    } finally {
      setApplyingAll(false);
    }
  };

  if (rejection) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-[11.5px] text-muted-foreground">
        <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          Not proposed — {rejection} The agent was told why and may propose again.
        </span>
      </div>
    );
  }

  const settled = tasks !== null && pendingIndices.length === 0;
  const subtitle = tasks === null
    ? "Checking the current tasks…"
    : settled
      ? "Nothing left to apply"
      : pendingIndices.length < updates.length
        ? `${pendingIndices.length} left to apply`
        : "Nothing changes until you apply";

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      {loadError && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-[11.5px] text-red-700 dark:text-red-400">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">Couldn&apos;t load the current tasks: {loadError}</span>
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
      <div className="flex items-center gap-2.5 border-b border-border/60 bg-muted/40 px-3 py-2.5">
        <span
          className={cn(
            "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border",
            settled
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
          )}
        >
          {settled ? <Check className="h-3.5 w-3.5" strokeWidth={2.2} /> : <PencilLine className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight text-foreground">
            {updates.length > 1 ? `${updates.length} proposed task updates` : "Proposed task update"}
          </div>
          <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        </div>
        {pendingIndices.length > 1 && (
          <Button
            size="sm"
            className={cn("ml-auto h-7 gap-1.5 rounded-lg px-3 text-xs", ACCENT_BUTTON)}
            onClick={() => void applyAll()}
            disabled={loading || applyingAll || submitting.size > 0}
          >
            <Check className="h-3 w-3" />
            Apply all {pendingIndices.length}
          </Button>
        )}
      </div>
      <div className="flex flex-col">
        {rows.map(({ update, task, changes }, index) => {
          if (tasks === null) {
            return (
              <div key={index} className={cn(ROW, "text-[12px] text-muted-foreground")}>
                <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
                Loading task…
              </div>
            );
          }
          if (!task) {
            return (
              <div key={index} data-update-row="missing" className={cn(ROW, "flex items-center gap-2 text-[12px] text-muted-foreground")}>
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                This task no longer exists.
              </div>
            );
          }
          const busy = submitting.has(index);
          const error = errors.get(index);
          const applied = changes.length === 0;
          return (
            <div key={index} data-update-row={applied ? "applied" : "pending"} className={cn(ROW, busy && "opacity-70")}>
              <div className="flex items-center gap-2">
                {applied && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                <p className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", applied ? "text-muted-foreground" : "text-foreground")}>
                  {task.title}
                </p>
                {openTask && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11.5px] text-muted-foreground"
                    onClick={() => openTask(task)}
                  >
                    View
                    <ArrowUpRight className="h-3 w-3" />
                  </Button>
                )}
                {applied ? (
                  <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">Up to date</span>
                ) : (
                  <Button
                    size="sm"
                    variant={pendingIndices.length === 1 ? "default" : "outline"}
                    className={cn("h-6 gap-1 rounded-[7px] px-2.5 text-[11.5px]", pendingIndices.length === 1 && ACCENT_BUTTON)}
                    aria-label="Apply update"
                    onClick={() => void apply(index)}
                    disabled={busy || applyingAll}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {busy ? "Applying…" : error ? "Retry" : "Apply"}
                  </Button>
                )}
              </div>
              {!applied && (
                <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-[12px]">
                  {changes.map((field) => (
                    <FieldChange key={field} field={field} task={task} update={update} />
                  ))}
                </dl>
              )}
              {error && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] break-words text-red-500">
                  <TriangleAlert className="h-3 w-3 shrink-0" />
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldChange({ field, task, update }: { field: Field; task: Task; update: ProposedUpdate }) {
  const label = <dt className="pt-px text-[11px] text-muted-foreground">{FIELD_LABEL[field]}</dt>;
  if (field === "description") {
    return (
      <>
        {label}
        <dd className="min-w-0">
          <DescriptionDiff before={task.description ?? ""} after={update.description ?? ""} />
        </dd>
      </>
    );
  }
  const render = (value: string) => {
    if (field === "status") {
      const cfg = statusConfig[value as TaskStatus];
      return <span className={cn("rounded px-1.5 py-px text-[11px] font-medium", cfg?.color)}>{cfg?.label ?? value}</span>;
    }
    if (field === "priority") {
      return (
        <span className="inline-flex items-center gap-1.5 text-[11.5px]">
          <span className={cn("h-[7px] w-[7px] rounded-full", PRIORITY_DOT[value as TaskPriority])} />
          {priorityConfig[value as TaskPriority]?.label ?? value}
        </span>
      );
    }
    return <span className="break-words">{value}</span>;
  };
  return (
    <>
      {label}
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground line-through decoration-muted-foreground/50">{render(String(task[field]))}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-foreground">{render(String(update[field]))}</span>
      </dd>
    </>
  );
}

function DescriptionDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => foldUnchanged(diffLines(before, after)), [before, after]);
  return (
    <div
      data-description-diff
      className="max-h-56 overflow-auto rounded-lg border border-border/70 bg-muted/30 py-1 font-mono text-[11px] leading-relaxed"
    >
      {lines.map((line, i) =>
        line.kind === "fold" ? (
          <div key={i} className="px-2 text-muted-foreground/70 italic">
            ⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "px-2 break-words whitespace-pre-wrap",
              line.kind === "add" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
              line.kind === "del" && "bg-red-500/10 text-red-800 dark:text-red-300",
            )}
          >
            <span className="mr-2 inline-block w-2 select-none opacity-60">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            {line.text || " "}
          </div>
        ),
      )}
    </div>
  );
}
