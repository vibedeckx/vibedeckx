"use client";

import { useMemo } from "react";
import type { Task } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const NONE = "__none__";

interface TaskParentSelectProps {
  /** The project's tasks to choose from. */
  tasks: Task[];
  value: string | null;
  onChange: (parentId: string | null) => void;
  /** Tasks that can't be chosen: the task itself and its descendants. */
  excludeIds?: Set<string>;
  /** Tasks proposed from this session are listed first. */
  sessionId?: string | null;
  disabled?: boolean;
  className?: string;
}

/**
 * Picks a task's parent. Offers open tasks (plus the current parent whatever
 * its state), this session's own first — they are the likely parents of what
 * it proposes next.
 */
export function TaskParentSelect({ tasks, value, onChange, excludeIds, sessionId, disabled, className }: TaskParentSelectProps) {
  const { mine, others } = useMemo(() => {
    const choices = tasks.filter((t) =>
      !excludeIds?.has(t.id)
      && (t.id === value || (t.archived_at === null && (t.status === "todo" || t.status === "in_progress"))));
    return {
      mine: sessionId ? choices.filter((t) => t.source_session_id === sessionId) : [],
      others: sessionId ? choices.filter((t) => t.source_session_id !== sessionId) : choices,
    };
  }, [tasks, excludeIds, sessionId, value]);

  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger size="sm" className={cn("min-w-0 text-xs", className)} aria-label="Parent task">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[min(28rem,90vw)]">
        <SelectItem value={NONE}>No parent</SelectItem>
        {mine.length > 0 && <SelectSeparator />}
        {mine.map((t) => (
          <SelectItem key={t.id} value={t.id}><span className="truncate">{t.title}</span></SelectItem>
        ))}
        {others.length > 0 && <SelectSeparator />}
        {others.map((t) => (
          <SelectItem key={t.id} value={t.id}><span className="truncate">{t.title}</span></SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
