"use client";

import { useState, useEffect, useRef } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  Play,
  Square,
  MoreVertical,
  Pencil,
  Trash2,
  GripVertical,
} from "lucide-react";
import { ExecutorOutput } from "./executor-output";
import { ExecutorForm } from "./executor-form";
import { useExecutorLogs } from "@/hooks/use-executor-logs";
import type { ExecutorWithProcess } from "@/hooks/use-executors";
import type { ExecutorType, PromptProvider } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface ExecutorItemProps {
  executor: ExecutorWithProcess;
  executorMode?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: () => Promise<string | null>;
  onStop: (processId?: string) => Promise<void>;
  onUpdate: (data: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null }) => Promise<unknown>;
  onDelete: () => Promise<void>;
  onProcessFinished: (processId: string | null) => void;
}

export function ExecutorItem({
  executor,
  executorMode,
  isOpen,
  onOpenChange,
  onStart,
  onStop,
  onUpdate,
  onDelete,
  onProcessFinished,
}: ExecutorItemProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [localProcessId, setLocalProcessId] = useState<string | null>(
    executor.currentProcessId
  );
  const processFinishedCalledRef = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: executor.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? 'relative' as const : undefined,
    opacity: isDragging ? 1 : undefined,
  };

  const { logs, status, exitCode, isPty, sendInput, sendResize } = useExecutorLogs(localProcessId, executorMode);

  // Sync local process ID with executor's current process
  useEffect(() => {
    setLocalProcessId(executor.currentProcessId);
    if (executor.currentProcessId) {
      processFinishedCalledRef.current = false; // Reset when new process starts
    }
  }, [executor.currentProcessId]);

  // Handle process finished - only call once per process
  useEffect(() => {
    if (status === "closed" && exitCode !== null && !processFinishedCalledRef.current) {
      processFinishedCalledRef.current = true;
      onProcessFinished(localProcessId);
    }
  }, [status, exitCode, localProcessId, onProcessFinished]);

  const handleStart = async () => {
    console.log(`[ExecutorItem] Starting executor ${executor.id}`);
    processFinishedCalledRef.current = false; // Reset for new process
    const processId = await onStart();
    console.log(`[ExecutorItem] Got processId: ${processId}`);
    if (processId) {
      setLocalProcessId(processId);
      onOpenChange(true); // Auto-expand on start
    }
  };

  const handleStop = async () => {
    await onStop(localProcessId || undefined);
  };

  const isRunning = executor.isRunning;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={onOpenChange}>
        <div
          ref={setNodeRef}
          style={style}
          className={cn("border rounded-lg", isDragging && "shadow-lg bg-background")}
        >
          <CollapsibleTrigger asChild>
            <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
                  {...attributes}
                  {...listeners}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripVertical className="h-4 w-4" />
                </button>
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <span className="font-medium">{executor.name}</span>
                <Badge
                  variant={isRunning ? "default" : "secondary"}
                  className={cn(
                    isRunning && "bg-green-600 hover:bg-green-600"
                  )}
                >
                  {isRunning
                    ? "Running"
                    : exitCode !== null
                    ? exitCode === 0
                      ? "Completed"
                      : "Failed"
                    : "Stopped"}
                </Badge>
              </div>
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleStop}
                  >
                    <Square className="h-3 w-3 mr-1" />
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" onClick={handleStart}>
                    <Play className="h-3 w-3 mr-1" />
                    Start
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-8 w-8">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditDialogOpen(true)}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onDelete}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-3 pb-3">
              <div className="text-xs text-muted-foreground mb-2 font-mono">
                {executor.executor_type === 'prompt'
                  ? `${executor.prompt_provider ?? 'claude'} → ${executor.command}`
                  : `$ ${executor.command}`}
              </div>
              <ExecutorOutput
                logs={logs}
                isPty={isPty}
                onInput={sendInput}
                onResize={sendResize}
              />
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <ExecutorForm
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        executor={executor}
        onSubmit={async (data) => {
          await onUpdate(data);
        }}
      />
    </>
  );
}
