"use client";

import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { Play, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommandDialog } from "./command-dialog";
import type { Command } from "@/lib/api";

export interface CommandsListHandle {
  openAdd: () => void;
}

interface CommandsListProps {
  commands: Command[];
  hideHeader?: boolean;
  onCreateCommand: (opts: { name: string; content: string }) => Promise<Command | null>;
  onUpdateCommand: (id: string, opts: { name?: string; content?: string }) => Promise<Command | null>;
  onDeleteCommand: (id: string) => Promise<void>;
  onExecuteCommand: (content: string) => void;
}

export const CommandsList = forwardRef<CommandsListHandle, CommandsListProps>(function CommandsList(
  { commands, hideHeader, onCreateCommand, onUpdateCommand, onDeleteCommand, onExecuteCommand },
  ref
) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<Command | null>(null);
  const [executedId, setExecutedId] = useState<string | null>(null);
  const executedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (executedTimerRef.current) clearTimeout(executedTimerRef.current);
  }, []);

  const handleExecute = (command: Command) => {
    onExecuteCommand(command.content);
    setExecutedId(command.id);
    if (executedTimerRef.current) clearTimeout(executedTimerRef.current);
    executedTimerRef.current = setTimeout(() => setExecutedId(null), 1200);
  };

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      setEditingCommand(null);
      setDialogOpen(true);
    },
  }));

  const handleAdd = () => {
    setEditingCommand(null);
    setDialogOpen(true);
  };

  const handleEdit = (command: Command) => {
    setEditingCommand(command);
    setDialogOpen(true);
  };

  const handleSave = async (data: { name: string; content: string }) => {
    if (editingCommand) {
      await onUpdateCommand(editingCommand.id, data);
    } else {
      await onCreateCommand(data);
    }
  };

  return (
    <div className={hideHeader ? undefined : "space-y-1"}>
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Commands</span>
          <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={handleAdd} title="Add command">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {commands.length === 0 ? (
        <button
          onClick={handleAdd}
          className="w-full text-center py-3 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          No commands yet. Click to add one.
        </button>
      ) : (
        <div className="space-y-0.5 max-h-48 overflow-y-auto">
          {commands.map((command) => (
            <div
              key={command.id}
              className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-muted/50 group"
            >
              <span
                className="text-sm truncate flex-1 cursor-pointer text-foreground"
                title={command.content}
                onClick={() => handleEdit(command)}
              >
                {command.name}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "h-6 w-6 shrink-0 transition-all duration-150 active:scale-90",
                  executedId === command.id
                    ? "opacity-100 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "opacity-0 group-hover:opacity-100 hover:bg-primary/15 hover:text-primary active:bg-primary/25"
                )}
                onClick={() => handleExecute(command)}
                title={executedId === command.id ? "Sent to chat" : "Execute command"}
              >
                {executedId === command.id ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
      <CommandDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        command={editingCommand}
        onSave={handleSave}
        onDelete={async (id) => { await onDeleteCommand(id); }}
      />
    </div>
  );
});
