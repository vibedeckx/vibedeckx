"use client";

import { Columns3, ListTodo, FolderOpen, GitBranch, Plus, Trash2, Globe, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UserMenu } from "@/components/auth/user-menu";
import type { Worktree, Project } from "@/lib/api";
import type { WorkspaceStatus } from "@/app/page";

export type ActiveView = "workspace" | "tasks" | "files" | "remote-servers" | "settings" | "project-info";

interface AppSidebarProps {
  activeView: ActiveView;
  onViewChange: (view: ActiveView) => void;
  worktrees?: Worktree[];
  selectedBranch?: string | null;
  onBranchChange?: (branch: string | null) => void;
  currentProject?: Project | null;
  onCreateWorktreeOpen?: () => void;
  onDeleteWorktree?: (worktree: Worktree) => void;
  workspaceStatuses?: Map<string, WorkspaceStatus>;
  hasProject?: boolean;
  projects?: Project[];
  onSelectProject?: (project: Project) => void;
  onCreateProjectOpen?: () => void;
}

function StatusDot({ status }: { status?: WorkspaceStatus }) {
  if (!status || status === "idle") {
    return <span className="h-2 w-2 rounded-full bg-muted-foreground/30 shrink-0" />;
  }
  if (status === "assigned") {
    return <span className="h-2 w-2 rounded-full bg-yellow-500 shrink-0" />;
  }
  if (status === "working") {
    return <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse shrink-0" />;
  }
  // completed
  return <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />;
}

function ProjectStatusDot({ project }: { project: Project }) {
  const hasLocal = !!project.path;
  const hasRemote = project.is_remote || !!project.remote_path;
  if (hasLocal && hasRemote) {
    return <span className="h-2 w-2 rounded-full bg-purple-500 shrink-0" />;
  }
  if (hasRemote) {
    return <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />;
  }
  return <span className="h-2 w-2 rounded-full bg-muted-foreground/30 shrink-0" />;
}

export function AppSidebar({
  activeView,
  onViewChange,
  worktrees,
  selectedBranch,
  onBranchChange,
  currentProject,
  onCreateWorktreeOpen,
  onDeleteWorktree,
  workspaceStatuses,
  hasProject = true,
  projects,
  onSelectProject,
  onCreateProjectOpen,
}: AppSidebarProps) {
  return (
    <nav className="w-52 border-r border-border/60 bg-sidebar flex flex-col p-3">
      {/* Projects Section */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Projects</span>
          <button
            onClick={onCreateProjectOpen}
            className="p-0.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground"
            title="Create new project"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        {projects && projects.length > 0 ? (
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
              {projects.map((project) => {
                const isSelected = currentProject?.id === project.id;
                const isActiveInfo = isSelected && activeView === "project-info";
                return (
                  <Tooltip key={project.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          onSelectProject?.(project);
                          onViewChange("project-info");
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-all duration-150 min-w-0",
                          "hover:bg-accent/80 hover:text-accent-foreground",
                          isActiveInfo
                            ? "bg-primary/10 text-primary font-medium shadow-sm"
                            : isSelected
                              ? "font-medium text-foreground"
                              : "text-muted-foreground"
                        )}
                      >
                        <ProjectStatusDot project={project} />
                        <span className="truncate">{project.name}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{project.name}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
        ) : (
          <span className="px-3 text-xs text-muted-foreground/60">No projects yet</span>
        )}
      </div>

      {/* Navigation Section */}
      <div className="mt-4 space-y-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-3 mb-2 block">Navigation</span>
        {/* Tasks */}
        <button
          onClick={() => {
            if (!hasProject) return;
            onBranchChange?.(null);
            onViewChange("tasks");
          }}
          disabled={!hasProject}
          className={cn(
            "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
            !hasProject
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "hover:bg-accent/80 hover:text-accent-foreground",
            activeView === "tasks" && hasProject
              ? "bg-primary/10 text-primary shadow-sm"
              : !hasProject ? "" : "text-muted-foreground"
          )}
        >
          <ListTodo className="h-4 w-4 shrink-0" />
          <span>Tasks</span>
        </button>

        {/* Files */}
        <button
          onClick={() => { if (!hasProject) return; onViewChange("files"); }}
          disabled={!hasProject}
          className={cn(
            "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
            !hasProject
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "hover:bg-accent/80 hover:text-accent-foreground",
            activeView === "files" && hasProject
              ? "bg-primary/10 text-primary shadow-sm"
              : !hasProject ? "" : "text-muted-foreground"
          )}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span>Files</span>
        </button>
      </div>

      {/* Workspace Section */}
      <div className="mt-4 space-y-0.5">
        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Workspace</span>
          {currentProject && (
            <button
              onClick={onCreateWorktreeOpen}
              className="p-0.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground"
              title="Create new worktree"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Worktree sub-items */}
        {worktrees && worktrees.length > 0 && (
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-col gap-0.5">
              {worktrees.map((wt) => (
                <div key={wt.branch ?? "__main__"} className="group relative flex items-center min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          onBranchChange?.(wt.branch);
                          onViewChange("workspace");
                        }}
                        className={cn(
                          "flex-1 min-w-0 flex items-center gap-2 rounded-lg pl-3 pr-6 py-1.5 text-xs transition-all duration-150 overflow-hidden",
                          "hover:bg-accent/80 hover:text-accent-foreground",
                          activeView === "workspace" && selectedBranch === wt.branch
                            ? "bg-primary/10 text-primary font-medium shadow-sm"
                            : "text-muted-foreground"
                        )}
                      >
                        <StatusDot status={workspaceStatuses?.get(wt.branch === null ? "" : wt.branch)} />
                        <GitBranch className="h-3 w-3 shrink-0" />
                        <span className="truncate">{wt.branch ?? "main"}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {wt.branch ?? "main"}
                    </TooltipContent>
                  </Tooltip>
                  {wt.branch !== null && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteWorktree?.(wt);
                      }}
                      className="absolute right-1.5 p-0.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-all"
                      title="Delete worktree"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </TooltipProvider>
        )}

        {(!worktrees || worktrees.length === 0) && (
          <button
            onClick={() => onViewChange("workspace")}
            className={cn(
              "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
              "hover:bg-accent/80 hover:text-accent-foreground",
              activeView === "workspace"
                ? "bg-primary/10 text-primary shadow-sm"
                : "text-muted-foreground"
            )}
          >
            <Columns3 className="h-4 w-4 shrink-0" />
            <span>Workspace</span>
          </button>
        )}
      </div>

      {/* Bottom Section: Remote Servers + Settings + User */}
      <div className="mt-auto space-y-0.5">
        <div className="border-t border-border/40 mb-3" />
        <button
          onClick={() => onViewChange("remote-servers")}
          className={cn(
            "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
            "hover:bg-accent/80 hover:text-accent-foreground",
            activeView === "remote-servers"
              ? "bg-primary/10 text-primary shadow-sm"
              : "text-muted-foreground"
          )}
        >
          <Globe className="h-4 w-4 shrink-0" />
          <span>Remote Servers</span>
        </button>
        <button
          onClick={() => onViewChange("settings")}
          className={cn(
            "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
            "hover:bg-accent/80 hover:text-accent-foreground",
            activeView === "settings"
              ? "bg-primary/10 text-primary shadow-sm"
              : "text-muted-foreground"
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span>Settings</span>
        </button>
        <UserMenu />
      </div>
    </nav>
  );
}
