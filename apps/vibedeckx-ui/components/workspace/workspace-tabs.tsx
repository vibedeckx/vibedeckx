"use client";

import { useEffect, useRef, useState } from "react";
import { RulesList } from "@/components/rules/rules-list";
import type { RulesListHandle } from "@/components/rules/rules-list";
import { CommandsList } from "@/components/commands/commands-list";
import type { CommandsListHandle } from "@/components/commands/commands-list";
import { Button } from "@/components/ui/button";
import { Check, Pencil, Plus } from "lucide-react";
import type { Rule, Command, Task } from "@/lib/api";

type Tab = "task" | "rules" | "commands";

interface WorkspaceTabsProps {
  assignedTask: Task | null;
  rules: Rule[];
  commands: Command[];
  onCreateRule: (opts: { name: string; content: string; enabled?: boolean }) => Promise<Rule | null>;
  onUpdateRule: (id: string, opts: { name?: string; content?: string; enabled?: boolean }) => Promise<Rule | null>;
  onDeleteRule: (id: string) => Promise<void>;
  onCreateCommand: (opts: { name: string; content: string }) => Promise<Command | null>;
  onUpdateCommand: (id: string, opts: { name?: string; content?: string }) => Promise<Command | null>;
  onDeleteCommand: (id: string) => Promise<void>;
  onExecuteCommand: (content: string) => void;
  onUpdateTaskTitle?: (taskId: string, title: string) => void;
  onCompleteTask?: (taskId: string) => void;
}

export function WorkspaceTabs({
  assignedTask,
  rules,
  commands,
  onCreateRule,
  onUpdateRule,
  onDeleteRule,
  onCreateCommand,
  onUpdateCommand,
  onDeleteCommand,
  onExecuteCommand,
  onUpdateTaskTitle,
  onCompleteTask,
}: WorkspaceTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("task");
  const rulesListRef = useRef<RulesListHandle>(null);
  const commandsListRef = useRef<CommandsListHandle>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync local title value when the assigned task changes
  useEffect(() => {
    if (assignedTask) {
      setTitleValue(assignedTask.title);
    }
    setEditingTitle(false);
  }, [assignedTask?.id, assignedTask?.title]);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleValue.trim();
    if (trimmed && assignedTask && trimmed !== assignedTask.title) {
      onUpdateTaskTitle?.(assignedTask.id, trimmed);
    } else if (assignedTask) {
      setTitleValue(assignedTask.title);
    }
  };

  const handleEdit = () => {
    if (!assignedTask) return;
    setTitleValue(assignedTask.title);
    setEditingTitle(true);
    // Focus after React renders the input
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  return (
    <div className="space-y-2">
      {/* Tab bar */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setActiveTab("task")}
          className={`text-xs font-medium pb-1 border-b-2 transition-colors ${
            activeTab === "task"
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground/70"
          }`}
        >
          Task
        </button>
        <button
          onClick={() => setActiveTab("rules")}
          className={`text-xs font-medium pb-1 border-b-2 transition-colors ${
            activeTab === "rules"
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground/70"
          }`}
        >
          Rules
        </button>
        <button
          onClick={() => setActiveTab("commands")}
          className={`text-xs font-medium pb-1 border-b-2 transition-colors ${
            activeTab === "commands"
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground/70"
          }`}
        >
          Commands
        </button>
        {/* Right-side action buttons — always rendered for consistent height */}
        <div className="flex items-center gap-1 ml-auto">
          {activeTab === "task" && assignedTask ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={handleEdit}
                title="Edit task title"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={() => onCompleteTask?.(assignedTask.id)}
                title="Complete task"
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : activeTab === "rules" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6"
              onClick={() => rulesListRef.current?.openAdd()}
              title="Add rule"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : activeTab === "commands" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6"
              onClick={() => commandsListRef.current?.openAdd()}
              title="Add command"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : (
            // Invisible placeholder to maintain consistent height
            <Button variant="ghost" size="icon-sm" className="h-6 w-6 invisible">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Tab content — both panels share the same grid cell so height stays consistent */}
      <div className="grid [&>*]:col-start-1 [&>*]:row-start-1">
        <div className={activeTab !== "task" ? "invisible" : undefined}>
          {assignedTask ? (
            editingTitle ? (
              <input
                ref={inputRef}
                className="w-full bg-transparent border-b border-primary outline-none text-sm py-0.5"
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") {
                    setTitleValue(assignedTask.title);
                    setEditingTitle(false);
                  }
                }}
              />
            ) : (
              <p className="text-sm text-foreground truncate" title={assignedTask.title}>
                {assignedTask.title}
              </p>
            )
          ) : (
            <p className="text-xs text-muted-foreground py-3 text-center">
              No task assigned to this workspace.
            </p>
          )}
        </div>
        <div className={activeTab !== "rules" ? "invisible" : undefined}>
          <RulesList
            ref={rulesListRef}
            hideHeader
            rules={rules}
            onCreateRule={onCreateRule}
            onUpdateRule={onUpdateRule}
            onDeleteRule={onDeleteRule}
          />
        </div>
        <div className={activeTab !== "commands" ? "invisible" : undefined}>
          <CommandsList
            ref={commandsListRef}
            hideHeader
            commands={commands}
            onCreateCommand={onCreateCommand}
            onUpdateCommand={onUpdateCommand}
            onDeleteCommand={onDeleteCommand}
            onExecuteCommand={onExecuteCommand}
          />
        </div>
      </div>
    </div>
  );
}
