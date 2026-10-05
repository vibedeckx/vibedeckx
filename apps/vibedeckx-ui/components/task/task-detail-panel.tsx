"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { Streamdown } from "streamdown";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Archive, ArchiveRestore, Trash2, X } from "lucide-react";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import { caretClientY, scrollParent, sourceOffsetAt } from "./markdown-caret";
import { TaskProperties, Property, PANEL_FIELD_CLASS, PANEL_BODY_CLASS, TASK_MARKDOWN_CLASS } from "./task-properties";

interface TaskDetailPanelProps {
  task: Task;
  onUpdate: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority }) => void;
  onAssign: (taskId: string, branch: string | null) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
  onOpenSourceSession?: (task: Task) => void;
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
}: TaskDetailPanelProps) {
  const archived = task.archived_at !== null;

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
            onCommit={(value) => {
              const next = value.trim() ? value : null;
              if (next !== task.description) onUpdate(task.id, { description: next });
            }}
            placeholder="Add a description…"
            aria-label="Description"
            className={PANEL_BODY_CLASS}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Markdown body shown rendered; a click (outside links, buttons and a text
 * selection) or Enter swaps in the raw-source DraftField, and blur (Esc blurs
 * via focus-region) commits and swaps back. An empty value goes straight to
 * the textarea so the placeholder stays clickable.
 *
 * Entering must not move the page: a click puts the caret at the matching
 * source offset and scrolls so that line sits where the pointer was (Enter
 * keeps the scroll position). Leaving just swaps back.
 */
function MarkdownField({
  value,
  onCommit,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  className?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const swapRef = useRef<{ caret: number | null; clientY: number | null; scroller: HTMLElement | null; scrollTop: number } | null>(null);

  const startEditing = (el: HTMLElement, at?: { x: number; y: number }) => {
    const scroller = scrollParent(el);
    swapRef.current = {
      caret: at ? sourceOffsetAt(el, at.x, at.y, value) : null,
      clientY: at?.y ?? null,
      scroller,
      scrollTop: scroller?.scrollTop ?? 0,
    };
    setEditing(true);
  };

  // Layout effect: settle focus, caret and scroll before the swap paints.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const swap = swapRef.current;
    swapRef.current = null;
    if (!editing || !el) return;
    const caret = swap?.caret ?? el.value.length;
    el.focus({ preventScroll: true });
    el.setSelectionRange(caret, caret);
    if (!swap?.scroller) return;
    swap.scroller.scrollTop = swap.scrollTop;
    if (swap.caret !== null && swap.clientY !== null) swap.scroller.scrollTop += caretClientY(el, caret) - swap.clientY;
  }, [editing]);

  if (!editing && value.trim()) {
    return (
      <div
        tabIndex={0}
        data-markdown-field={props["aria-label"]}
        title="Click to edit"
        onClick={(e) => {
          if ((e.target as Element).closest("a, button")) return;
          if (!window.getSelection()?.isCollapsed) return;
          startEditing(e.currentTarget, { x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.target !== e.currentTarget) return;
          e.preventDefault();
          startEditing(e.currentTarget);
        }}
        className={`-mx-1.5 cursor-text rounded-md px-1.5 py-1 outline-none focus-visible:bg-muted/40 ${className ?? ""}`}
      >
        <Streamdown mode="static" className={TASK_MARKDOWN_CLASS}>
          {value}
        </Streamdown>
      </div>
    );
  }

  return (
    <DraftField
      ref={textareaRef}
      value={value}
      onCommit={onCommit}
      onDone={() => setEditing(false)}
      className={className}
      {...props}
    />
  );
}

/**
 * Borderless auto-growing textarea that edits a draft and saves on blur. The
 * draft exists only while focused: unfocused it shows `value`, so outside
 * changes land right away but never clobber what is being typed. Saves are
 * optimistic upstream, so dropping the draft on blur doesn't flash the old text.
 */
function DraftField({
  ref,
  value,
  onCommit,
  onDone,
  singleLine,
  className,
  ...props
}: {
  ref?: Ref<HTMLTextAreaElement>;
  value: string;
  onCommit: (value: string) => void;
  /** Called after the blur that ends an edit. */
  onDone?: () => void;
  singleLine?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={() => {
        if (draft !== null) onCommit(draft);
        setDraft(null);
        onDone?.();
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
