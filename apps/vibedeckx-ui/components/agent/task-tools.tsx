"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, Loader2, XCircle, PlusCircle, ArrowRight, Badge as BadgeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ============ Shared helpers ============

type TaskStatus = "completed" | "in_progress" | "pending" | "deleted";

function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className={cn("h-4 w-4 text-green-500", className)} />;
    case "in_progress":
      return <Loader2 className={cn("h-4 w-4 text-cyan-500 animate-spin", className)} />;
    case "pending":
      return <Circle className={cn("h-4 w-4 text-muted-foreground", className)} />;
    case "deleted":
      return <XCircle className={cn("h-4 w-4 text-red-400", className)} />;
    default:
      return <Circle className={cn("h-4 w-4 text-muted-foreground", className)} />;
  }
}

function parseInput<T>(input: unknown, validate: (obj: Record<string, unknown>) => boolean): T | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && validate(obj)) {
      return obj as unknown as T;
    }
  } catch {
    // fall through
  }
  return null;
}

function FallbackJSON({ input }: { input: unknown }) {
  const str = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return (
    <pre
      className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
      style={{ fontSize: "var(--conv-font-size, 12px)" }}
    >
      {str.length > 500 ? str.substring(0, 500) + "..." : str}
    </pre>
  );
}

// ============ TodoWrite ============

interface TodoItem {
  id?: string;
  content?: string;
  subject?: string;
  status: TaskStatus;
  activeForm?: string;
  description?: string;
}

interface TodoWriteInput {
  todos: TodoItem[];
}

export function TodoWriteUI({ input }: { input: unknown }) {
  const parsed = parseInput<TodoWriteInput>(input, (obj) =>
    Array.isArray(obj.todos) && obj.todos.length > 0
  );

  if (!parsed) return <FallbackJSON input={input} />;

  return (
    <div className="mt-2 space-y-1">
      {parsed.todos.map((todo, i) => (
        <div key={todo.id ?? i} className="flex items-start gap-2 py-0.5">
          <StatusIcon status={todo.status} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <span
              className={cn(
                "text-sm break-words",
                todo.status === "completed" && "line-through text-muted-foreground"
              )}
            >
              {todo.subject ?? todo.content ?? "Untitled task"}
            </span>
            {todo.status === "in_progress" && todo.activeForm && (
              <span className="block text-xs italic text-cyan-500">{todo.activeForm}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============ TaskCreate ============

interface TaskCreateInput {
  subject: string;
  description?: string;
  activeForm?: string;
}

export function TaskCreateUI({ input }: { input: unknown }) {
  const parsed = parseInput<TaskCreateInput>(input, (obj) =>
    typeof obj.subject === "string"
  );

  if (!parsed) return <FallbackJSON input={input} />;

  return (
    <div className="mt-2 flex items-start gap-2">
      <PlusCircle className="h-4 w-4 text-cyan-500 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="text-sm font-medium break-words">{parsed.subject}</span>
        {parsed.description && (
          <span className="block text-xs text-muted-foreground mt-0.5 break-words">
            {parsed.description.length > 200
              ? parsed.description.substring(0, 200) + "..."
              : parsed.description}
          </span>
        )}
      </div>
    </div>
  );
}

// ============ TaskUpdate ============

interface TaskUpdateInput {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
}

export function TaskUpdateUI({ input }: { input: unknown }) {
  const parsed = parseInput<TaskUpdateInput>(input, (obj) =>
    typeof obj.taskId === "string"
  );

  if (!parsed) return <FallbackJSON input={input} />;

  return (
    <div className="mt-2 flex items-start gap-2 flex-wrap">
      {parsed.status ? (
        <StatusIcon status={parsed.status} className="mt-0.5 flex-shrink-0" />
      ) : (
        <ArrowRight className="h-4 w-4 text-cyan-500 mt-0.5 flex-shrink-0" />
      )}
      <span className="text-sm break-words">
        Task #{parsed.taskId}
        {parsed.status && (
          <> <ArrowRight className="inline h-3 w-3 text-muted-foreground mx-0.5" /> {parsed.status}</>
        )}
        {parsed.subject && (
          <span className="text-muted-foreground"> — {parsed.subject}</span>
        )}
      </span>
      {parsed.addBlockedBy && parsed.addBlockedBy.length > 0 && (
        <div className="flex gap-1 mt-1 w-full pl-6">
          {parsed.addBlockedBy.map((id) => (
            <Badge key={id} variant="outline" className="text-[10px]">
              <BadgeIcon className="h-2.5 w-2.5 mr-0.5" />
              blocked by #{id}
            </Badge>
          ))}
        </div>
      )}
      {parsed.addBlocks && parsed.addBlocks.length > 0 && (
        <div className="flex gap-1 mt-1 w-full pl-6">
          {parsed.addBlocks.map((id) => (
            <Badge key={id} variant="outline" className="text-[10px]">
              <BadgeIcon className="h-2.5 w-2.5 mr-0.5" />
              blocks #{id}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ TaskList / TaskGet ============

export function TaskListUI() {
  return (
    <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />
      <span>Listing tasks...</span>
    </div>
  );
}

export function TaskGetUI({ input }: { input: unknown }) {
  const parsed = parseInput<{ taskId: string }>(input, (obj) =>
    typeof obj.taskId === "string"
  );

  if (!parsed) return <FallbackJSON input={input} />;

  return (
    <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />
      <span>Fetching task #{parsed.taskId}...</span>
    </div>
  );
}

// ============ TaskList Result ============

interface TaskListResultItem {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy?: string[];
}

export function TaskListResultUI({ output }: { output: string }) {
  const items = parseTaskListOutput(output);
  if (!items) return null; // caller should fall back to raw display

  return (
    <div className="mt-1 space-y-1">
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-2 py-0.5">
          <StatusIcon status={item.status} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground">#{item.id}</span>
            <span
              className={cn(
                "text-sm break-words",
                item.status === "completed" && "line-through text-muted-foreground"
              )}
            >
              {item.subject}
            </span>
            {item.blockedBy && item.blockedBy.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                blocked
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function parseTaskListOutput(output: string): TaskListResultItem[] | null {
  try {
    // The TaskList tool result is typically JSON
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item: Record<string, unknown>) => item.id && item.subject)
        .map((item: Record<string, unknown>) => ({
          id: String(item.id),
          subject: String(item.subject),
          status: (item.status as TaskStatus) || "pending",
          owner: item.owner ? String(item.owner) : undefined,
          blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : undefined,
        }));
    }
    // Could be an object with a tasks/items array
    const arr = parsed.tasks ?? parsed.items ?? parsed.data;
    if (Array.isArray(arr)) {
      return arr
        .filter((item: Record<string, unknown>) => item.id && item.subject)
        .map((item: Record<string, unknown>) => ({
          id: String(item.id),
          subject: String(item.subject),
          status: (item.status as TaskStatus) || "pending",
          owner: item.owner ? String(item.owner) : undefined,
          blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : undefined,
        }));
    }
  } catch {
    // Not JSON — try line-based parsing
    const lines = output.trim().split("\n").filter(Boolean);
    const items: TaskListResultItem[] = [];
    for (const line of lines) {
      // Match patterns like: "#1 [pending] Fix the bug" or "1. [completed] Fix the bug"
      const match = line.match(/^#?(\d+)[\s.:\-]+\[?(completed|in_progress|pending|deleted)\]?\s+(.+)/i);
      if (match) {
        items.push({
          id: match[1],
          status: match[2].toLowerCase() as TaskStatus,
          subject: match[3].trim(),
        });
      }
    }
    if (items.length > 0) return items;
  }
  return null;
}
