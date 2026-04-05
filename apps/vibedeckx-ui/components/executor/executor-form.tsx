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
import { Terminal, MessageSquare, ChevronDown, ChevronRight } from "lucide-react";

interface ExecutorPreset {
  name: string;
  command: string;
  executor_type: "command" | "prompt";
  pty: boolean;
  description?: string;
}

const EXECUTOR_PRESETS: ExecutorPreset[] = [
  { name: "Dev Server", command: "pnpm dev", executor_type: "command", pty: true, description: "Start the development server with hot reload" },
  { name: "Build", command: "pnpm build", executor_type: "command", pty: true, description: "Build the project for production" },
  { name: "Lint", command: "pnpm lint", executor_type: "command", pty: true, description: "Run the linter to check code quality" },
  { name: "Type Check", command: "npx tsc --noEmit", executor_type: "command", pty: true, description: "Run TypeScript type checking without emitting files" },
  { name: "Test", command: "pnpm test", executor_type: "command", pty: true, description: "Run the test suite" },
  { name: "Rebase on and merge into main", command: "Our goal is to sync the current local branch with the local branch/worktree `main`. The two branches may have diverged.\n\nPlease do the following in order. Only proceed to the next step if the previous step succeeds:\n\n1. Rebase the current local branch onto the local branch `main`, and resolve any conflicts if needed.\n2. If, after the rebase, `main` does not yet contain the current branch's commits, switch to the `main` branch/worktree and merge the current branch into `main` using `git merge`. Do not use `git branch -f`.\n3. If the current branch is already fully contained in `main`, and `main` has newer commits, update the current branch so it includes the latest commits from `main`.\n4. Push both the current local branch and the local branch `main` to the remote.", executor_type: "prompt", pty: false, description: "Rebase current branch onto main, merge into main, and push both branches" },
  { name: "Reset to main", command: "git reset --hard main", executor_type: "command", pty: true, description: "Hard reset the current branch to match main" },
  { name: "Push to remote", command: "git push --force-with-lease", executor_type: "command", pty: true, description: "Force push to remote with lease safety check" },
  { name: "Git commit", command: "Inspect the modified and untracked and deleted files in the current repository, generate an appropriate commit message, and commit all relevant files.\n\nCommit message rules:\n- Use Conventional Commits format (feat:, fix:, chore:, refactor:, docs:, test:, ci:, build:, perf:, style:, etc.)\n- Choose the type that best matches the main purpose of the changes\n- Make the message specific to the actual changes\n- Keep it within 50 characters if possible\n- Use lowercase\n- Do not end with a period\n- Do not wrap the message in quotes, backticks, or markdown\n\nCommit requirements:\n- Include all relevant modified and untracked files\n- Do not include unrelated files\n- If there are no meaningful changes to commit, do not create a commit\n\nWhen finished, output only the final commit message.", executor_type: "prompt", pty: false, description: "Inspect changes, generate a conventional commit message, and commit" },
];

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
  const [showPresets, setShowPresets] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<ExecutorPreset | null>(null);
  const [expandedPreset, setExpandedPreset] = useState<string | null>(null);
  const [presetFilter, setPresetFilter] = useState("");

  const isEdit = !!executor;

  // Sync form values only when dialog opens
  useEffect(() => {
    if (open) {
      setShowPresets(false);
      setSelectedPreset(null);
      setExpandedPreset(null);
      setPresetFilter("");
      if (executor) {
        setName(executor.name);
        setExecutorType(executor.executor_type ?? "command");
        setPromptProvider(executor.prompt_provider ?? "claude");
        setCommand(executor.command);
        setCwd(executor.cwd ?? "");
        setPty(executor.pty);
      }
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
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>{showPresets ? "Select Preset" : isEdit ? "Edit Executor" : "Add Executor"}</DialogTitle>
            {!isEdit && !showPresets && (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowPresets(true)}
              >
                Select from presets
              </button>
            )}
          </div>
        </DialogHeader>
        <div className="h-[420px] flex flex-col">
        {!showPresets && (
        <form onSubmit={handleSubmit} className="space-y-4 flex-1 flex flex-col">
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
              <div className="w-[140px] shrink-0 space-y-2">
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
          <div className="flex-1" />
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
        )}
        {showPresets && (
          <div className="space-y-4 flex-1 flex flex-col min-h-0">
            <Input
              placeholder="Search presets..."
              value={presetFilter}
              onChange={(e) => setPresetFilter(e.target.value)}
              autoFocus
            />
            <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
              {EXECUTOR_PRESETS.filter((preset) => {
                if (!presetFilter.trim()) return true;
                const q = presetFilter.toLowerCase();
                return (
                  preset.name.toLowerCase().includes(q) ||
                  preset.command.toLowerCase().includes(q) ||
                  (preset.description?.toLowerCase().includes(q) ?? false)
                );
              }).map((preset) => {
                const isSelected = selectedPreset?.command === preset.command;
                const isExpanded = expandedPreset === preset.command;
                return (
                  <div key={preset.command} className="rounded-md overflow-hidden">
                    <button
                      type="button"
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors",
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      )}
                      onClick={() => setSelectedPreset(preset)}
                    >
                      {preset.executor_type === "command" ? (
                        <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="font-medium flex-1 text-left">{preset.name}</span>
                      <button
                        type="button"
                        className="shrink-0 p-0.5 rounded hover:bg-muted-foreground/10 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedPreset(isExpanded ? null : preset.command);
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    </button>
                    {isExpanded && (
                      <div className={cn(
                        "px-3 pb-2 pt-1 text-xs text-muted-foreground space-y-1 border-t border-border/50",
                        isSelected ? "bg-primary/5" : "bg-muted/50"
                      )}>
                        {preset.description && <p>{preset.description}</p>}
                        <pre className="whitespace-pre-wrap break-all bg-muted/50 rounded px-2 py-1 font-mono">{preset.command}</pre>
                        <div className="flex gap-3">
                          <span>Type: <span className="font-medium text-foreground/70">{preset.executor_type}</span></span>
                          <span>PTY: <span className="font-medium text-foreground/70">{preset.pty ? "on" : "off"}</span></span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowPresets(false);
                  setSelectedPreset(null);
                  setExpandedPreset(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!selectedPreset}
                onClick={() => {
                  if (selectedPreset) {
                    setName(selectedPreset.name);
                    setCommand(selectedPreset.command);
                    setExecutorType(selectedPreset.executor_type);
                    setPty(selectedPreset.pty);
                    setShowPresets(false);
                    setSelectedPreset(null);
                    setExpandedPreset(null);
                  }
                }}
              >
                Select
              </Button>
            </DialogFooter>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
