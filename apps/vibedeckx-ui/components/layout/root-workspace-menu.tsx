"use client";

import { useState } from "react";
import { Anchor, MoreHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface RootWorkspaceMenuProps {
  projectId: string;
  /** Branch this workspace is anchored to, shown as checked. */
  anchoredBranch: string | null;
  onAnchorChange: (branch: string) => void;
}

/**
 * The main workspace's anchor is captured once, from whatever branch the
 * repository sat on when it was first listed, so a project can end up named
 * after a feature branch forever. This is the only way to correct that without
 * a checkout — the branch chosen here need not be the one checked out.
 */
export function RootWorkspaceMenu({ projectId, anchoredBranch, onAnchorChange }: RootWorkspaceMenuProps) {
  // Stored per project, not as one current list: the root row's key is constant
  // across projects, so this instance is reused rather than remounted. A single
  // slot would both offer the previous project's branches and, when a request
  // outlives the switch that started it, let the late response overwrite the
  // list the user is now looking at.
  const [branchesByProject, setBranchesByProject] = useState<Record<string, string[]>>({});
  const branches = branchesByProject[projectId] ?? null;

  const loadBranches = async () => {
    if (branches !== null) return;
    const list = await api.getProjectBranches(projectId);
    setBranchesByProject((previous) => ({ ...previous, [projectId]: list }));
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
            <Anchor className="h-3.5 w-3.5 mr-1.5" />
            Anchor to branch
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {branches === null ? (
              <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
            ) : branches.length === 0 ? (
              <DropdownMenuItem disabled>No branches</DropdownMenuItem>
            ) : (
              branches.map((b) => (
                <DropdownMenuCheckboxItem
                  key={b}
                  checked={b === anchoredBranch}
                  onCheckedChange={() => {
                    if (b !== anchoredBranch) onAnchorChange(b);
                  }}
                >
                  <span className="font-mono text-xs">{b}</span>
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
