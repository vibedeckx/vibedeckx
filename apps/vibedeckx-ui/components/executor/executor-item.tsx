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
  Ban,
  CircleCheck,
} from "lucide-react";
import { ExecutorOutput } from "./executor-output";
import { ExecutorForm } from "./executor-form";
import { useExecutorProcessLogs } from "@/hooks/executor-logs-context";
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
  onUpdate: (data: { name?: string; command?: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string | null; target?: string; disabled?: boolean }) => Promise<unknown>;
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
  // Seed from the running process when available, otherwise from the persisted
  // last-run id. The fallback lets us reconnect to the buffered output of a
  // finished process after a workspace switch unmounts and remounts this item.
  const [localProcessId, setLocalProcessId] = useState<string | null>(
    executor.currentProcessId ?? executor.lastProcessId
  );
  const processFinishedCalledRef = useRef(false);
  const prevProcessIdRef = useRef<string | null>(executor.currentProcessId);

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

  const { logs, status, exitCode, isPty, replayingHistory, sendInput, sendResize } = useExecutorProcessLogs(localProcessId, executorMode);

  // [diag:mux] 临时诊断：item 挂载/卸载 + localProcessId 变化。
  // 用来区分“切回时一直空”是因为 item 重挂载、还是 localProcessId 掉成 null。
  useEffect(() => {
    console.log("[diag:mux] ExecutorItem MOUNT", executor.id, "localProcessId=", localProcessId);
    return () => console.log("[diag:mux] ExecutorItem UNMOUNT", executor.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    console.log("[diag:mux] localProcessId →", localProcessId, "executor=", executor.id);
  }, [localProcessId, executor.id]);

  // Sync local process ID with executor's current process.
  // Only update when a NEW process starts — don't clear to null when the process
  // finishes. This prevents a race condition where monitorRemoteExecutor detects
  // the process finished (emits executor:stopped, clearing currentProcessId) before
  // the frontend log WebSocket has connected and received the output history.
  useEffect(() => {
    const prevId = prevProcessIdRef.current;
    prevProcessIdRef.current = executor.currentProcessId;

    if (executor.currentProcessId && executor.currentProcessId !== prevId) {
      setLocalProcessId(executor.currentProcessId);
      processFinishedCalledRef.current = false;
      onOpenChange(true); // Auto-open when process starts (including from Main Chat)
    }
  }, [executor.currentProcessId, onOpenChange]);

  // Adopt the persisted last-run id once it arrives (e.g., after the executors
  // refetch resolves post-mount). No auto-open: a finished run shouldn't pop
  // the panel.
  useEffect(() => {
    if (executor.currentProcessId) return;
    if (!executor.lastProcessId) return;
    setLocalProcessId((prev) => prev ?? executor.lastProcessId);
  }, [executor.currentProcessId, executor.lastProcessId]);

  // Handle process finished - only call once per process
  useEffect(() => {
    if (status === "closed" && exitCode !== null && !processFinishedCalledRef.current) {
      processFinishedCalledRef.current = true;
      console.log(`[diag:remote-stop] ${new Date().toISOString()} executor-item marking finished executorId=${executor.id} processId=${localProcessId} exitCode=${exitCode} — removing from runningProcesses (button → Start)`);
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
  const isDisabled = executor.isDisabled;

  const lastRunLabel = executor.lastStartedAt
    ? new Date(executor.lastStartedAt).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : null;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={onOpenChange}>
        <div
          ref={setNodeRef}
          style={style}
          className={cn("border rounded-lg", isDragging && "shadow-lg bg-background")}
        >
          <CollapsibleTrigger asChild>
            <div className="group flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50">
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
                <span className={cn("font-medium", isDisabled && "text-muted-foreground line-through")}>
                  {executor.name}
                </span>
                {isDisabled ? (
                  <Badge variant="outline" className="text-muted-foreground border-muted-foreground/40 gap-1">
                    <Ban className="h-3 w-3" />
                    Disabled
                  </Badge>
                ) : (
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
                )}
              </div>
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {lastRunLabel && (
                  <span
                    className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    title={new Date(executor.lastStartedAt!).toLocaleString()}
                  >
                    Last run: {lastRunLabel}
                  </span>
                )}
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleStop}
                    className="w-20 border border-destructive"
                  >
                    <Square className="h-3 w-3 mr-1" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleStart}
                    disabled={isDisabled}
                    title={isDisabled ? "Executor is disabled" : undefined}
                    className="w-20"
                  >
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
                    <DropdownMenuItem onClick={() => onUpdate({ target: executorMode ?? "local", disabled: !isDisabled })}>
                      {isDisabled ? (
                        <>
                          <CircleCheck className="h-4 w-4 mr-2" />
                          Enable
                        </>
                      ) : (
                        <>
                          <Ban className="h-4 w-4 mr-2" />
                          Disable
                        </>
                      )}
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
                muteInput={replayingHistory}
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
