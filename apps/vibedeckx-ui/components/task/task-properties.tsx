"use client";

import type { ReactNode } from "react";
import type { TaskStatus, TaskPriority, Worktree } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitBranch } from "lucide-react";
import {
  statusConfig,
  priorityConfig,
  statusOptions,
  priorityOptions,
  assignableBranches,
  branchLabel,
} from "./task-utils";

/** Borderless auto-growing textarea look shared by the side panels' text fields. */
export const PANEL_FIELD_CLASS =
  "field-sizing-content w-full resize-none rounded-md bg-transparent px-1.5 py-1 -mx-1.5 outline-none placeholder:text-muted-foreground/60 hover:bg-muted/40 focus:bg-muted/40";

/** Description body; its size follows the Tasks font size setting via `--task-body-font-size`. */
export const PANEL_BODY_CLASS = "min-h-32 text-[length:var(--task-body-font-size,14px)] leading-relaxed";

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
  /** Extra read-only rows after Branch (use <Property>). */
  children?: ReactNode;
}

/** Status / Priority / Branch as badge dropdowns, laid out as a label grid. */
export function TaskProperties({
  status,
  priority,
  assignedBranch,
  onStatusChange,
  onPriorityChange,
  onAssign,
  worktrees,
  assignedBranches,
  children,
}: TaskPropertiesProps) {
  return (
    <dl className="mt-4 grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-xs">
      <Property label="Status">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="focus:outline-none">
              <Badge variant="outline" className={`cursor-pointer text-xs ${statusConfig[status].color}`}>
                {statusConfig[status].label}
              </Badge>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {statusOptions.map((s) => (
              <DropdownMenuItem key={s} onClick={() => onStatusChange(s)}>
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
              <Badge variant="outline" className={`cursor-pointer text-xs ${priorityConfig[priority].color}`}>
                {priorityConfig[priority].label}
              </Badge>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {priorityOptions.map((p) => (
              <DropdownMenuItem key={p} onClick={() => onPriorityChange(p)}>
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
              <Badge variant="outline" className={`cursor-pointer text-xs font-mono ${assignedBranch !== null ? "bg-accent text-accent-foreground border-transparent" : "text-muted-foreground"}`}>
                <GitBranch className="h-3 w-3 mr-1" />
                {assignedBranch !== null ? branchLabel(assignedBranch) : "Unassigned"}
              </Badge>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {assignedBranch !== null && (
              <>
                <DropdownMenuItem onClick={() => onAssign(null)}>Unassign</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {assignableBranches(assignedBranch, worktrees, assignedBranches).map(({ key, label }) => (
              <DropdownMenuItem key={key} onClick={() => onAssign(key)}>
                <GitBranch className="h-3 w-3 mr-2" />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Property>
      {children}
    </dl>
  );
}

export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
