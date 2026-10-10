"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import type { TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusConfig, priorityConfig, assignableBranches, branchLabel } from "./task-utils";
import { PriorityGlyph, PriorityMenu, StatusGlyph, StatusMenu } from "./task-glyphs";

/** Borderless auto-growing textarea look shared by the side panels' text fields. */
export const PANEL_FIELD_CLASS =
  "field-sizing-content w-full resize-none rounded-md bg-transparent px-1.5 py-1 -mx-1.5 outline-none placeholder:text-muted-foreground/60";

/** Description text; its size follows the Tasks font size setting via `--task-body-font-size`. */
export const PANEL_BODY_TEXT_CLASS = "text-[length:var(--task-body-font-size,14px)] leading-relaxed";

/**
 * Description editor: the text plus room to type. The rendered markdown uses
 * PANEL_BODY_TEXT_CLASS alone, so a one-line description stays one line tall.
 */
export const PANEL_BODY_CLASS = `min-h-32 ${PANEL_BODY_TEXT_CLASS}`;

/**
 * Streamdown wrapper for task descriptions. globals.css has no `@source` for
 * streamdown, so its own `list-inside list-decimal` classes never get
 * generated; restate them here or ordered lists lose their numbers.
 */
export const TASK_MARKDOWN_CLASS =
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ol]:list-inside [&_ol]:list-decimal [&_ul]:list-inside";

/** Hover chevron of a field value; shown while the field is hovered or open. */
export const FIELD_CHEVRON = (
  <ChevronDown className="size-3 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover/fv:opacity-100 group-data-[state=open]/fv:opacity-100" aria-hidden />
);

/**
 * A property value that edits in place: plain text until hovered, then a soft
 * tint and a chevron. Spread onto a menu trigger.
 */
export const FieldValue = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { muted?: boolean }>(
  function FieldValue({ muted, className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "group/fv -ml-2 inline-flex h-[30px] min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-muted focus-visible:bg-muted data-[state=open]:bg-muted disabled:pointer-events-none",
          muted ? "text-muted-foreground/80" : "text-foreground",
          className,
        )}
        {...props}
      >
        {children}
        {FIELD_CHEVRON}
      </button>
    );
  },
);

/** Mono branch chip; "" is the main workspace. */
export function BranchChip({ branch, className }: { branch: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted px-[7px] font-mono text-[11px] text-secondary-foreground", className)}>
      <GitBranch className="size-[11px] shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="truncate">{branchLabel(branch)}</span>
    </span>
  );
}

/** Branch picker: Unassign plus every branch no other task holds. */
export function BranchMenu({
  current,
  onAssign,
  worktrees,
  assignedBranches,
  children,
}: {
  current: string | null;
  onAssign: (branch: string | null) => void;
  worktrees: Worktree[];
  assignedBranches: Set<string | null>;
  children: ReactNode;
}) {
  const choices = assignableBranches(current, worktrees, assignedBranches);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {current !== null && (
          <>
            <DropdownMenuItem onClick={() => onAssign(null)} className="text-[12.5px]">Unassign</DropdownMenuItem>
            {choices.length > 0 && <DropdownMenuSeparator />}
          </>
        )}
        {choices.map(({ key, label }) => (
          <DropdownMenuItem key={key} onClick={() => onAssign(key)} className="gap-2 font-mono text-[12px]">
            <GitBranch className="size-3 text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
        {current === null && choices.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No free branches</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TaskPropertiesProps {
  status: TaskStatus;
  priority: TaskPriority;
  assignedBranch: string | null;
  onStatusChange: (status: TaskStatus) => void;
  onPriorityChange: (priority: TaskPriority) => void;
  onAssign: (branch: string | null) => void;
  worktrees: Worktree[];
  /** Branches other tasks hold; they are left out of the Branch menu. */
  assignedBranches: Set<string | null>;
  /** Read-only: the archived task shows its fields without menus. */
  readOnlyBranch?: boolean;
  /** Extra rows after Branch (use <Property>). */
  children?: ReactNode;
}

/** Status / Priority / Branch as click-to-edit field values, laid out as a label grid. */
export function TaskProperties({
  status,
  priority,
  assignedBranch,
  onStatusChange,
  onPriorityChange,
  onAssign,
  worktrees,
  assignedBranches,
  readOnlyBranch,
  children,
}: TaskPropertiesProps) {
  return (
    <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2 gap-y-px text-[12.5px]">
      <Property label="Status">
        <StatusMenu status={status} onChange={onStatusChange}>
          <FieldValue aria-label="Status">
            <StatusGlyph status={status} />
            {statusConfig[status].label}
          </FieldValue>
        </StatusMenu>
      </Property>
      <Property label="Priority">
        <PriorityMenu priority={priority} onChange={onPriorityChange}>
          <FieldValue aria-label="Priority">
            <PriorityGlyph priority={priority} />
            {priorityConfig[priority].label}
          </FieldValue>
        </PriorityMenu>
      </Property>
      <Property label="Branch">
        {readOnlyBranch ? (
          <span className="inline-flex h-[30px] items-center gap-2 text-muted-foreground/80">
            {assignedBranch !== null ? <BranchChip branch={assignedBranch} /> : <><GitBranch className="size-3" aria-hidden />Unassigned</>}
          </span>
        ) : (
          <BranchMenu current={assignedBranch} onAssign={onAssign} worktrees={worktrees} assignedBranches={assignedBranches}>
            <FieldValue aria-label="Branch" muted={assignedBranch === null}>
              {assignedBranch !== null ? (
                <BranchChip branch={assignedBranch} />
              ) : (
                <>
                  <GitBranch className="size-3 shrink-0" aria-hidden />
                  Assign a branch
                </>
              )}
            </FieldValue>
          </BranchMenu>
        )}
      </Property>
      {children}
    </dl>
  );
}

export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex h-[30px] items-center text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0">{children}</dd>
    </>
  );
}
