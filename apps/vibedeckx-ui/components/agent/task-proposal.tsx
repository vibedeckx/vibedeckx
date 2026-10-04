"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, CheckCircle2, Circle, CircleDot, ExternalLink, ListPlus, Loader2, XCircle } from "lucide-react";
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

function readProposal(input: unknown): ItemFields[] {
  const raw = typeof input === "string" ? tryParse(input) : input;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(obj.tasks) ? obj.tasks : [];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return items.map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const priority = str(o.priority).toLowerCase();
    return {
      title: str(o.title).trim(),
      description: str(o.description),
      priority: (priorityOptions as string[]).includes(priority) ? priority as TaskPriority : "medium",
    };
  });
}

/**
 * Confirmation card for an agent's `propose_task` call: one editable row per
 * proposed task, each confirmed on its own (or all at once). Nothing exists
 * until the user confirms; the project and source session come from the
 * session this card lives in, never from the model. A confirmed row follows
 * its task — created, then done/cancelled — and returns to the editable state
 * if the task is deleted.
 */
export function TaskProposalUI({ input, toolUseId }: TaskProposalUIProps) {
  const { sessionId, projectId, openTask } = useAgentConversation();
  const proposal = useMemo(() => readProposal(input), [input]);
  const [fields, setFields] = useState<ItemFields[]>(proposal);
  const [submitting, setSubmitting] = useState<Set<number>>(() => new Set());
  const [errors, setErrors] = useState<Map<number, string>>(() => new Map());
  const { byItem, loading, loadError, retry } = useProposedTasks(projectId, sessionId, toolUseId);

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

  const create = async (index: number) => {
    if (!canCreate || submitting.has(index)) return;
    const item = fields[index];
    if (!item.description.trim()) {
      setErrors((prev) => new Map(prev).set(index, "Description is required"));
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
      });
      noteTaskCreated(projectId, task);
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

  return (
    <div
      ref={rootRef}
      className={cn(
        "space-y-2 rounded-lg transition-shadow",
        highlighted && "ring-2 ring-violet-500/60 ring-offset-2 ring-offset-background",
      )}
    >
      {loadError && (
        <div className="flex items-center gap-2 text-xs text-red-500">
          <span className="min-w-0 break-words">Couldn&apos;t check which tasks already exist: {loadError}</span>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {fields.map((item, index) => {
        const created = byItem.get(index);
        if (created) {
          return <CreatedTaskRow key={index} task={created} onOpen={openTask} />;
        }
        const busy = submitting.has(index);
        const error = errors.get(index);
        return (
          <div key={index} className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  value={item.title}
                  onChange={(e) => setFields((f) => f.map((x, i) => (i === index ? { ...x, title: e.target.value } : x)))}
                  placeholder="Title"
                  className="h-8 text-sm"
                  aria-label="Task title"
                  disabled={busy}
                />
                <Select
                  value={item.priority}
                  onValueChange={(v) => setFields((f) => f.map((x, i) => (i === index ? { ...x, priority: v as TaskPriority } : x)))}
                  disabled={busy}
                >
                  <SelectTrigger className="h-8 w-28 shrink-0 text-xs" aria-label="Task priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorityOptions.map((p) => (
                      <SelectItem key={p} value={p}>{priorityConfig[p].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                value={item.description}
                onChange={(e) => setFields((f) => f.map((x, i) => (i === index ? { ...x, description: e.target.value } : x)))}
                placeholder="What's left to do, and how to tell it's done"
                className="min-h-24 text-xs"
                aria-label="Task description"
                disabled={busy}
              />
            </div>
            {error && <p className="mt-2 text-xs text-red-500 break-words">{error}</p>}
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={() => void create(index)} disabled={!canCreate || busy || loading}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ListPlus className="mr-1 h-3.5 w-3.5" />}
                {error ? "Retry" : "Create task"}
              </Button>
            </div>
          </div>
        );
      })}
      {pendingIndices.length > 1 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => pendingIndices.forEach((i) => void create(i))}
          disabled={!canCreate || loading || pendingIndices.some((i) => submitting.has(i))}
        >
          <ListPlus className="mr-1 h-3.5 w-3.5" />
          Create all {pendingIndices.length}
        </Button>
      )}
    </div>
  );
}

function CreatedTaskRow({ task, onOpen }: { task: Task; onOpen?: (task: Task) => void }) {
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
      className={cn(
        "rounded-lg border p-3",
        closed ? "border-border bg-muted/20" : "border-violet-500/30 bg-violet-500/5",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-4 w-4 flex-shrink-0", tone)} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium break-words", closed ? "text-muted-foreground line-through" : "text-foreground")}>
            {task.title}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {label} · {priorityConfig[task.priority].label} priority
          </p>
        </div>
        {onOpen && (
          <Button variant="ghost" size="sm" className="flex-shrink-0" onClick={() => onOpen(task)}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            View
          </Button>
        )}
      </div>
    </div>
  );
}
