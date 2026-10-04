"use client";

import { useState, type ReactNode } from "react";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Archive, ArchiveRestore, GitBranch, Trash2, X } from "lucide-react";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import {
  statusConfig,
  priorityConfig,
  statusOptions,
  priorityOptions,
  assignableBranches,
  branchLabel,
} from "./task-utils";

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
            return trimmed || task.title;
          }}
          singleLine
          aria-label="Title"
          className="text-lg font-semibold leading-snug"
        />

        <dl className="mt-4 grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-xs">
          <Property label="Status">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="focus:outline-none">
                  <Badge variant="outline" className={`cursor-pointer text-xs ${statusConfig[task.status].color}`}>
                    {statusConfig[task.status].label}
                  </Badge>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {statusOptions.map((s) => (
                  <DropdownMenuItem key={s} onClick={() => onUpdate(task.id, { status: s })}>
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${statusConfig[s].color}`} />
                    {statusConfig[s].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </Property>
          <Property label="Priority">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="focus:outline-none">
                  <Badge variant="outline" className={`cursor-pointer text-xs ${priorityConfig[task.priority].color}`}>
                    {priorityConfig[task.priority].label}
                  </Badge>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {priorityOptions.map((p) => (
                  <DropdownMenuItem key={p} onClick={() => onUpdate(task.id, { priority: p })}>
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${priorityConfig[p].color}`} />
                    {priorityConfig[p].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </Property>
          <Property label="Branch">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="focus:outline-none">
                  <Badge variant="outline" className={`cursor-pointer text-xs font-mono ${task.assigned_branch !== null ? "bg-accent text-accent-foreground border-transparent" : "text-muted-foreground"}`}>
                    <GitBranch className="h-3 w-3 mr-1" />
                    {task.assigned_branch !== null ? branchLabel(task.assigned_branch) : "Unassigned"}
                  </Badge>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {task.assigned_branch !== null && (
                  <>
                    <DropdownMenuItem onClick={() => onAssign(task.id, null)}>Unassign</DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {assignableBranches(task, worktrees, assignedBranches).map(({ key, label }) => (
                  <DropdownMenuItem key={key} onClick={() => onAssign(task.id, key)}>
                    <GitBranch className="h-3 w-3 mr-2" />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
        </dl>

        <div className="mt-5 border-t pt-4">
          <DraftField
            value={task.description ?? ""}
            onCommit={(value) => {
              const next = value.trim() ? value : null;
              if (next !== task.description) onUpdate(task.id, { description: next });
            }}
            placeholder="Add a description…"
            aria-label="Description"
            className="min-h-32 text-sm leading-relaxed"
          />
        </div>
      </div>
    </div>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
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
      className={`field-sizing-content w-full resize-none rounded-md bg-transparent px-1.5 py-1 -mx-1.5 outline-none placeholder:text-muted-foreground/60 hover:bg-muted/40 focus:bg-muted/40 ${className ?? ""}`}
      {...props}
    />
  );
}
