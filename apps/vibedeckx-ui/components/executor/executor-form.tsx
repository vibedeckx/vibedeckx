"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Executor, ExecutorType, PromptProvider } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ExecutorFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  executor?: Executor;
  onSubmit: (data: { name: string; command: string; executor_type?: ExecutorType; prompt_provider?: PromptProvider | null; cwd?: string; pty?: boolean }) => Promise<void>;
}

export function ExecutorForm({
  open,
  onOpenChange,
  executor,
  onSubmit,
}: ExecutorFormProps) {
  const [name, setName] = useState(executor?.name ?? "");
  const [executorType, setExecutorType] = useState<ExecutorType>(executor?.executor_type ?? "command");
  const [promptProvider, setPromptProvider] = useState<PromptProvider>(executor?.prompt_provider ?? "claude");
  const [command, setCommand] = useState(executor?.command ?? "");
  const [cwd, setCwd] = useState(executor?.cwd ?? "");
  const [pty, setPty] = useState(executor?.pty ?? true);
  const [loading, setLoading] = useState(false);

  const isEdit = !!executor;

  // Sync form values only when dialog opens
  useEffect(() => {
    if (open && executor) {
      setName(executor.name);
      setExecutorType(executor.executor_type ?? "command");
      setPromptProvider(executor.prompt_provider ?? "claude");
      setCommand(executor.command);
      setCwd(executor.cwd ?? "");
      setPty(executor.pty);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;

    setLoading(true);
    try {
      await onSubmit({
        name: name.trim(),
        command: command.trim(),
        executor_type: executorType,
        prompt_provider: executorType === "prompt" ? promptProvider : null,
        cwd: cwd.trim() || undefined,
        pty: executorType === "prompt" ? true : pty,
      });
      onOpenChange(false);
      if (!isEdit) {
        setName("");
        setExecutorType("command");
        setPromptProvider("claude");
        setCommand("");
        setCwd("");
        setPty(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Executor" : "Add Executor"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input
              placeholder="e.g., Dev Server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Type</label>
            <div className="flex rounded-md border border-input overflow-hidden">
              <button
                type="button"
                className={cn(
                  "flex-1 px-3 py-1.5 text-sm font-medium transition-colors",
                  executorType === "command"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setExecutorType("command")}
              >
                Command
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 px-3 py-1.5 text-sm font-medium transition-colors border-l border-input",
                  executorType === "prompt"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setExecutorType("prompt")}
              >
                Prompt
              </button>
            </div>
          </div>
          {executorType === "prompt" && (
            <div className="flex gap-3">
              <div className="w-1/2 space-y-2">
                <label className="text-sm font-medium">Provider</label>
                <Select value={promptProvider} onValueChange={(v) => setPromptProvider(v as PromptProvider)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 space-y-2">
                <label className="text-sm font-medium">
                  Working Directory{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  placeholder="Relative to worktree root"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {executorType === "prompt" ? "Prompt" : "Command"}
            </label>
            {executorType === "prompt" ? (
              <textarea
                className="flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                placeholder="e.g., Review the code and suggest improvements"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                required
              />
            ) : (
              <Input
                placeholder="e.g., npm run dev"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                required
              />
            )}
          </div>
          {executorType === "command" && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Working Directory{" "}
                <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                placeholder="Relative to worktree root (leave empty for root)"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </div>
          )}
          {executorType === "command" && (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <label className="text-sm font-medium">Terminal Mode (PTY)</label>
                <p className="text-xs text-muted-foreground">
                  Enable for interactive commands like top, vim, htop
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={pty}
                onClick={() => setPty(!pty)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  pty ? "bg-primary" : "bg-input"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition-transform",
                    pty ? "translate-x-5" : "translate-x-0"
                  )}
                />
              </button>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !name.trim() || !command.trim()}>
              {loading ? "Saving..." : isEdit ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
