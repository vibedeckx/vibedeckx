"use client";

import type { Task } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SourceSessionLink } from "@/components/agent/source-session-link";
import { Streamdown } from "streamdown";
import { statusConfig, priorityConfig } from "./task-utils";
import { TASK_MARKDOWN_CLASS } from "./task-properties";

interface TaskDetailDialogProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Jump to the conversation a proposed task came from. */
  onOpenSourceSession?: (task: Task) => void;
  /** Show the task on the Tasks page (its side panel, row in view). */
  onOpenInTasks?: (task: Task) => void;
}

export function TaskDetailDialog({ task, open, onOpenChange, onOpenSourceSession, onOpenInTasks }: TaskDetailDialogProps) {
  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped height with a scrolling body; min-w-0 + wrapping keep long
          code lines and URLs inside the dialog instead of widening it. */}
      <DialogContent className="flex max-h-[min(32rem,80vh)] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="text-base leading-snug break-words">{task.title}</DialogTitle>
        </DialogHeader>
        <div className="-mr-6 min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-6">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${statusConfig[task.status].color}`}>
              {statusConfig[task.status].label}
            </Badge>
            <Badge variant="outline" className={`text-xs ${priorityConfig[task.priority].color}`}>
              {priorityConfig[task.priority].label}
            </Badge>
            {onOpenInTasks && (
              <button
                type="button"
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => {
                  onOpenChange(false);
                  onOpenInTasks(task);
                }}
              >
                Open in Tasks
                <ArrowUpRight className="h-3 w-3" />
              </button>
            )}
          </div>
          {task.description && (
            <Streamdown
              mode="static"
              className={`min-w-0 text-sm text-foreground break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto ${TASK_MARKDOWN_CLASS}`}
            >
              {task.description}
            </Streamdown>
          )}
          {task.source_session && (
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="shrink-0 text-muted-foreground">From session</span>
              <SourceSessionLink
                source={task.source_session}
                onOpen={onOpenSourceSession ? () => {
                  onOpenChange(false);
                  onOpenSourceSession(task);
                } : undefined}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pt-2 border-t">
            <span>Created: {new Date(task.created_at).toLocaleString()}</span>
            <span>Updated: {new Date(task.updated_at).toLocaleString()}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
