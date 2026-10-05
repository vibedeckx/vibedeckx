"use client";

import type { Task } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
}

export function TaskDetailDialog({ task, open, onOpenChange, onOpenSourceSession }: TaskDetailDialogProps) {
  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base leading-snug">{task.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${statusConfig[task.status].color}`}>
              {statusConfig[task.status].label}
            </Badge>
            <Badge variant="outline" className={`text-xs ${priorityConfig[task.priority].color}`}>
              {priorityConfig[task.priority].label}
            </Badge>
          </div>
          {task.description && (
            <Streamdown mode="static" className={`text-sm text-foreground ${TASK_MARKDOWN_CLASS}`}>
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
          <div className="flex gap-4 text-xs text-muted-foreground pt-2 border-t">
            <span>Created: {new Date(task.created_at).toLocaleString()}</span>
            <span>Updated: {new Date(task.updated_at).toLocaleString()}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
