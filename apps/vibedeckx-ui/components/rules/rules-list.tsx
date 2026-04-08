"use client";

import { useState, useImperativeHandle, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus } from "lucide-react";
import { RuleDialog } from "./rule-dialog";
import type { Rule } from "@/lib/api";

export interface RulesListHandle {
  openAdd: () => void;
}

interface RulesListProps {
  rules: Rule[];
  hideHeader?: boolean;
  onCreateRule: (opts: { name: string; content: string; enabled?: boolean }) => Promise<Rule | null>;
  onUpdateRule: (id: string, opts: { name?: string; content?: string; enabled?: boolean }) => Promise<Rule | null>;
  onDeleteRule: (id: string) => Promise<void>;
}

export const RulesList = forwardRef<RulesListHandle, RulesListProps>(function RulesList({ rules, hideHeader, onCreateRule, onUpdateRule, onDeleteRule }, ref) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      setEditingRule(null);
      setDialogOpen(true);
    },
  }));

  const handleAdd = () => {
    setEditingRule(null);
    setDialogOpen(true);
  };

  const handleEdit = (rule: Rule) => {
    setEditingRule(rule);
    setDialogOpen(true);
  };

  const handleSave = async (data: { name: string; content: string; enabled: boolean }) => {
    if (editingRule) {
      await onUpdateRule(editingRule.id, data);
    } else {
      await onCreateRule(data);
    }
  };

  const handleToggle = async (rule: Rule, checked: boolean) => {
    await onUpdateRule(rule.id, { enabled: checked });
  };

  return (
    <div className={hideHeader ? undefined : "space-y-1"}>
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rules</span>
          <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={handleAdd} title="Add rule">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {rules.length === 0 ? (
        <button
          onClick={handleAdd}
          className="w-full text-center py-3 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          No rules yet. Click to add one.
        </button>
      ) : (
        <div className="space-y-0.5 max-h-48 overflow-y-auto">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-muted/50 group cursor-pointer"
              onClick={() => handleEdit(rule)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="shrink-0"
              >
                <Checkbox
                  checked={rule.enabled === 1}
                  onCheckedChange={(checked) => handleToggle(rule, checked === true)}
                />
              </div>
              <span
                className={`text-sm truncate flex-1 ${rule.enabled === 1 ? "text-foreground" : "text-muted-foreground line-through"}`}
                title={rule.content}
              >
                {rule.name}
              </span>
            </div>
          ))}
        </div>
      )}
      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editingRule}
        onSave={handleSave}
        onDelete={async (id) => { await onDeleteRule(id); }}
      />
    </div>
  );
});
