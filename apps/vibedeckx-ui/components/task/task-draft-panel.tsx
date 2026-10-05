"use client";

import { useEffect, useRef } from "react";
import type { TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { X } from "lucide-react";
import { TaskProperties, PANEL_FIELD_CLASS, PANEL_BODY_CLASS } from "./task-properties";

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_branch: string | null;
}

export const EMPTY_TASK_DRAFT: TaskDraft = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  assigned_branch: null,
};

export const isDraftEmpty = (draft: TaskDraft) => !draft.title.trim() && !draft.description.trim();

interface TaskDraftPanelProps {
  draft: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  onCreate: () => void;
  onDiscard: () => void;
  /** Hide the panel; the draft is kept for the next New Task. */
  onClose: () => void;
  createMore: boolean;
  onCreateMoreChange: (value: boolean) => void;
  error: string | null;
  /** Bumped to pull focus back to the title (open, New Task again, Create more). */
  focusNonce: number;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
}

// An IME Enter confirms a candidate, not the field (229: legacy signal).
const isComposing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/**
 * New-task form in the side panel, laid out like the detail panel so a task
 * looks the same before and after it exists. Nothing is saved until Create,
 * in the actions footer pinned to the bottom of the panel.
 */
export function TaskDraftPanel({
  draft,
  onChange,
  onCreate,
  onDiscard,
  onClose,
  createMore,
  onCreateMoreChange,
  error,
  focusNonce,
  worktrees,
  assignedBranches,
}: TaskDraftPanelProps) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const canCreate = draft.description.trim().length > 0;

  useEffect(() => {
    titleRef.current?.focus();
  }, [focusNonce]);

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isComposing(e)) {
          e.preventDefault();
          if (canCreate) onCreate();
        }
      }}
    >
      <div className="flex shrink-0 items-center justify-between pl-6 pr-3 pt-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          New task <span className="normal-case tracking-normal text-muted-foreground/70">· Draft</span>
        </span>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Close (Esc) — keeps the draft" onClick={onClose}>
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6 edge-scrollbar">
        <textarea
          ref={titleRef}
          rows={1}
          value={draft.title}
          onChange={(e) => onChange({ title: e.target.value.replace(/\n/g, " ") })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !isComposing(e)) {
              e.preventDefault();
              descriptionRef.current?.focus();
            }
          }}
          placeholder="Untitled"
          aria-label="Title"
          className={`${PANEL_FIELD_CLASS} text-lg font-semibold leading-snug`}
        />
        {!draft.title.trim() && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            Leave empty to generate a title from the description.
          </p>
        )}

        <TaskProperties
          status={draft.status}
          priority={draft.priority}
          assignedBranch={draft.assigned_branch}
          onStatusChange={(status) => onChange({ status })}
          onPriorityChange={(priority) => onChange({ priority })}
          onAssign={(assigned_branch) => onChange({ assigned_branch })}
          worktrees={worktrees}
          assignedBranches={assignedBranches}
        />

        <div className="mt-5 border-t pt-4">
          <textarea
            ref={descriptionRef}
            rows={1}
            value={draft.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Describe the task…"
            aria-label="Description"
            className={`${PANEL_FIELD_CLASS} ${PANEL_BODY_CLASS}`}
          />
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
        <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={createMore} onCheckedChange={(checked) => onCreateMoreChange(checked === true)} />
          Create more
        </label>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={isDraftEmpty(draft)}>
          Discard
        </Button>
        <Button size="sm" onClick={onCreate} disabled={!canCreate}>
          Create
          <kbd className="ml-1.5 rounded bg-primary-foreground/15 px-1 font-sans text-[10px]">⌘↵</kbd>
        </Button>
      </div>
    </div>
  );
}
