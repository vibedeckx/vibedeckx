"use client";

import { useRef, useState } from "react";
import { RulesList } from "@/components/rules/rules-list";
import type { RulesListHandle } from "@/components/rules/rules-list";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { Rule, Task } from "@/lib/api";

type Tab = "task" | "rules";

interface WorkspaceTabsProps {
  assignedTask: Task | null;
  rules: Rule[];
  onCreateRule: (opts: { name: string; content: string; enabled?: boolean }) => Promise<Rule | null>;
  onUpdateRule: (id: string, opts: { name?: string; content?: string; enabled?: boolean }) => Promise<Rule | null>;
  onDeleteRule: (id: string) => Promise<void>;
}

export function WorkspaceTabs({
  assignedTask,
  rules,
  onCreateRule,
  onUpdateRule,
  onDeleteRule,
}: WorkspaceTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("task");
  const rulesListRef = useRef<RulesListHandle>(null);

  return (
    <div className="space-y-2">
      {/* Tab bar */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setActiveTab("task")}
          className={`text-xs font-medium uppercase tracking-wider pb-1 border-b-2 transition-colors ${
            activeTab === "task"
              ? "text-foreground border-foreground"
              : "text-muted-foreground border-transparent hover:text-foreground/70"
          }`}
        >
          Task
        </button>
        <button
          onClick={() => setActiveTab("rules")}
          className={`text-xs font-medium uppercase tracking-wider pb-1 border-b-2 transition-colors ${
            activeTab === "rules"
              ? "text-foreground border-foreground"
              : "text-muted-foreground border-transparent hover:text-foreground/70"
          }`}
        >
          Rules
        </button>
        {activeTab === "rules" && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 ml-auto"
            onClick={() => rulesListRef.current?.openAdd()}
            title="Add rule"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Tab content — both panels share the same grid cell so height stays consistent */}
      <div className="grid [&>*]:col-start-1 [&>*]:row-start-1">
        <div className={activeTab !== "task" ? "invisible" : undefined}>
          {assignedTask ? (
            <p className="text-sm text-foreground truncate" title={assignedTask.title}>
              {assignedTask.title}
            </p>
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
      </div>
    </div>
  );
}
