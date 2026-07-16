"use client";

import { useState } from "react";
import { GitMerge, MoreHorizontal, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface WorkspaceRowMenuProps {
  projectId: string;
  branch: string;
  /** Effective compare target shown as checked (persisted choice or default). */
  currentTarget: string | null;
  onTargetChange: (target: string) => void;
  onTargetReset: () => void;
  onDelete: () => void;
}

export function WorkspaceRowMenu({
  projectId,
  branch,
  currentTarget,
  onTargetChange,
  onTargetReset,
  onDelete,
}: WorkspaceRowMenuProps) {
  const [branches, setBranches] = useState<string[] | null>(null);

  const loadBranches = async () => {
    if (branches !== null) return;
    const list = await api.getProjectBranches(projectId);
    setBranches(list.filter((b) => b !== branch));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-muted transition-all"
          title="Workspace menu"
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger onPointerEnter={loadBranches} onFocus={loadBranches}>
            <GitMerge className="h-3.5 w-3.5 mr-1.5" />
            Compare against
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {branches === null ? (
              <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
            ) : branches.length === 0 ? (
              <DropdownMenuItem disabled>No other branches</DropdownMenuItem>
            ) : (
              branches.map((b) => (
                <DropdownMenuCheckboxItem
                  key={b}
                  checked={b === currentTarget}
                  onCheckedChange={() => onTargetChange(b)}
                >
                  <span className="font-mono text-xs">{b}</span>
                </DropdownMenuCheckboxItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onTargetReset}>
              <span className="text-xs">Default branch (auto)</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete worktree
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
