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
import { StatusGlyph } from "./task-glyphs";

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
  /** Borderless field value (detail panels): the parent's status glyph and title, "None" when unset. */
  field?: boolean;
  /** Menu edge aligned to the trigger; "end" for triggers near the right edge. */
  align?: "start" | "end";
}

/**
 * Picks a task's parent. Offers open tasks (plus the current parent whatever
 * its state), this session's own first — they are the likely parents of what
 * it proposes next.
 */
export function TaskParentSelect({ tasks, value, onChange, excludeIds, sessionId, disabled, className, field, align = "start" }: TaskParentSelectProps) {
  const { mine, others } = useMemo(() => {
    const choices = tasks.filter((t) =>
      !excludeIds?.has(t.id)
      && (t.id === value || (t.archived_at === null && (t.status === "todo" || t.status === "in_progress"))));
    return {
      mine: sessionId ? choices.filter((t) => t.source_session_id === sessionId) : [],
      others: sessionId ? choices.filter((t) => t.source_session_id !== sessionId) : choices,
    };
  }, [tasks, excludeIds, sessionId, value]);

  const parent = field && value ? tasks.find((t) => t.id === value) : undefined;

  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className={cn(
          "min-w-0 text-xs",
          field && "-ml-2 h-[30px] max-w-full gap-2 border-transparent px-2 text-[12.5px] shadow-none hover:bg-muted data-[state=open]:bg-muted dark:bg-transparent [&>svg:last-child]:size-3 [&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-70 data-[state=open]:[&>svg:last-child]:opacity-70",
          field && !parent && "text-muted-foreground/80",
          className,
        )}
        aria-label="Parent task"
      >
        {field ? (
          <SelectValue>
            {parent ? (
              <>
                <StatusGlyph status={parent.status} />
                <span className="truncate">{parent.title}</span>
              </>
            ) : "None"}
          </SelectValue>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      {/* Popper, not item-aligned: item-aligned overlays the trigger and re-measures
          after mount, so a menu of long titles opened past the right edge then jumped back. */}
      <SelectContent position="popper" align={align} collisionPadding={8} className="max-w-[min(28rem,90vw)]">
        <SelectItem value={NONE}>No parent</SelectItem>
        {mine.length > 0 && <SelectSeparator />}
        {mine.map((t) => (
          <SelectItem key={t.id} value={t.id} className="*:[span]:last:min-w-0"><span className="truncate">{t.title}</span></SelectItem>
        ))}
        {others.length > 0 && <SelectSeparator />}
        {others.map((t) => (
          <SelectItem key={t.id} value={t.id} className="*:[span]:last:min-w-0"><span className="truncate">{t.title}</span></SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
