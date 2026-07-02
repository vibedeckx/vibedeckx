"use client";

import { Columns3, ListTodo, FolderOpen, Plus, Trash2, Globe, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { Worktree, Project, Schedule } from "@/lib/api";
import type { WorkspaceStatus } from "@/app/page";

export type ActiveView = "workspace" | "tasks" | "schedules" | "remote-servers" | "settings" | "project-info";

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
  schedules?: Schedule[];
  selectedScheduleId?: string | null;
  onScheduleSelect?: (id: string) => void;
  onCreateScheduleOpen?: () => void;
}

function StatusDot({ status }: { status?: WorkspaceStatus }) {
  const base = "relative h-[7px] w-[7px] rounded-full shrink-0";
  if (!status || status === "idle") {
    return <span className={cn(base, "bg-muted-foreground/40")} />;
  }
  if (status === "working") {
    return (
      <span className={cn(base, "bg-blue-500")}>
        <span
          className="absolute inset-[-2px] rounded-full bg-blue-500"
          style={{ animation: "status-dot-pulse 1.6s ease-out infinite", opacity: 0.5 }}
        />
      </span>
    );
  }
  if (status === "main-running") {
    return (
      <span className={cn(base, "bg-violet-500")}>
        <span
          className="absolute inset-[-2px] rounded-full bg-violet-500"
          style={{ animation: "status-dot-pulse 1.6s ease-out infinite", opacity: 0.5 }}
        />
      </span>
    );
  }
  if (status === "main-completed") {
    // Cool green for workspace completion; agent-completed uses a warm
    // yellow-green (lime) so the two completion states stay clearly distinct.
    return <span className={cn(base, "bg-emerald-500")} />;
  }
  if (status === "stopped") {
    return <span className={cn(base, "bg-amber-500")} />;
  }
  return <span className={cn(base, "bg-lime-400")} />;
}

// Last-run status for a scheduled task; blue pulse while a run is active
// (same visual language as StatusDot, plus red for failures).
function ScheduleDot({ schedule }: { schedule: Schedule }) {
  const base = "relative h-[7px] w-[7px] rounded-full shrink-0";
  if (schedule.running) {
    return (
      <span className={cn(base, "bg-blue-500")}>
        <span
          className="absolute inset-[-2px] rounded-full bg-blue-500"
          style={{ animation: "status-dot-pulse 1.6s ease-out infinite", opacity: 0.5 }}
        />
      </span>
    );
  }
  const last = schedule.last_run;
  if (!last || last.status === "skipped") {
    return <span className={cn(base, "bg-muted-foreground/40")} />;
  }
  if (last.status === "completed") {
    return <span className={cn(base, "bg-emerald-500")} />;
  }
  if (last.status === "failed" || last.status === "timeout" || last.status === "killed") {
    return <span className={cn(base, "bg-red-500")} />;
  }
  return <span className={cn(base, "bg-blue-500")} />;
}

function ProjectStatusDot({ project }: { project: Project }) {
  const hasLocal = !!project.path;
  const hasRemote = project.is_remote || !!project.remote_path;
  const base = "h-[7px] w-[7px] rounded-full shrink-0";
  if (hasLocal && hasRemote) {
    return <span className={cn(base, "bg-purple-500")} />;
  }
  if (hasRemote) {
    return <span className={cn(base, "bg-blue-500")} />;
  }
  return <span className={cn(base, "bg-muted-foreground/40")} />;
}

// Section grouping — design's `.sidebar-section` with hairline divider between
function SidebarSection({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("px-2 pt-2.5 pb-1.5 border-t border-border/50 first:border-t-0", className)}>
      {children}
    </div>
  );
}

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
      <span>{children}</span>
      {action}
    </div>
  );
}

// Top-level nav row — design's `.nav-item` with accent left bar on active
function NavItem({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative w-full flex items-center gap-[9px] rounded-md px-2 py-[5px] text-[12.5px] font-normal transition-colors",
        disabled && "text-muted-foreground/40 cursor-not-allowed",
        !disabled && !active && "text-foreground/75 hover:bg-muted hover:text-foreground",
        active && "bg-card text-foreground font-medium shadow-sm"
      )}
    >
      {active && (
        <span className="absolute -left-2 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary" />
      )}
      <span className={cn("shrink-0 flex items-center justify-center", active ? "text-foreground" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="truncate text-left">{label}</span>
    </button>
  );
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
  schedules,
  selectedScheduleId,
  onScheduleSelect,
  onCreateScheduleOpen,
}: AppSidebarProps) {
  return (
    <nav className="w-[220px] border-r border-border bg-sidebar flex flex-col overflow-hidden">
      {/* Projects Section */}
      <SidebarSection>
        <SectionLabel
          action={
            <button
              onClick={onCreateProjectOpen}
              className="p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors text-muted-foreground"
              title="Create new project"
            >
              <Plus className="h-3 w-3" />
            </button>
          }
        >
          Projects
        </SectionLabel>
        {projects && projects.length > 0 ? (
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto mt-0.5">
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
                          "relative w-full flex items-center gap-[9px] rounded-md px-2 py-[5px] text-[12.5px] transition-colors min-w-0",
                          !isActiveInfo && "text-foreground/75 hover:bg-muted hover:text-foreground",
                          isActiveInfo &&
                            "bg-card text-foreground font-medium shadow-sm",
                          isSelected && !isActiveInfo && "text-foreground font-medium"
                        )}
                      >
                        {isActiveInfo && (
                          <span className="absolute -left-2 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary" />
                        )}
                        <ProjectStatusDot project={project} />
                        <span className="truncate flex-1 text-left">{project.name}</span>
                        {isSelected && <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground ml-auto" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{project.name}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
        ) : (
          <span className="block px-2 mt-1 text-[11.5px] text-muted-foreground/60">No projects yet</span>
        )}
      </SidebarSection>

      {/* Navigation Section */}
      <SidebarSection>
        <SectionLabel>Navigation</SectionLabel>
        <div className="flex flex-col gap-0.5 mt-0.5">
          <NavItem
            icon={<ListTodo className="h-3.5 w-3.5" />}
            label="Tasks"
            active={activeView === "tasks" && hasProject}
            disabled={!hasProject}
            onClick={() => {
              if (!hasProject) return;
              onBranchChange?.(null);
              onViewChange("tasks");
            }}
          />
        </div>
      </SidebarSection>

      {/* Schedule Section — cron tasks for the current project */}
      <SidebarSection>
        <SectionLabel
          action={
            currentProject ? (
              <button
                onClick={onCreateScheduleOpen}
                className="p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors text-muted-foreground"
                title="Create scheduled task"
              >
                <Plus className="h-3 w-3" />
              </button>
            ) : undefined
          }
        >
          Schedule
        </SectionLabel>
        {currentProject && schedules && schedules.length > 0 && (
          <div className="flex flex-col gap-px">
            {schedules.map((s) => {
              const isActive = activeView === "schedules" && selectedScheduleId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => onScheduleSelect?.(s.id)}
                  className={cn(
                    "w-full min-w-0 flex items-center gap-2 rounded-[5px] px-2 py-1 text-[11.5px] transition-colors overflow-hidden",
                    !isActive && "text-foreground/80 hover:bg-muted",
                    isActive && "bg-accent text-accent-foreground font-medium",
                    !s.enabled && "opacity-50"
                  )}
                >
                  <ScheduleDot schedule={s} />
                  <span className="truncate text-left">{s.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {currentProject && schedules && schedules.length === 0 && (
          <span className="block px-2 mt-1 text-[11.5px] text-muted-foreground/60">No scheduled tasks</span>
        )}
      </SidebarSection>

      {/* Workspace Section — branches as mono tree */}
      <SidebarSection className="flex-1 overflow-y-auto">
        <SectionLabel
          action={
            currentProject ? (
              <button
                onClick={onCreateWorktreeOpen}
                className="p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors text-muted-foreground"
                title="Create new worktree"
              >
                <Plus className="h-3 w-3" />
              </button>
            ) : undefined
          }
        >
          Workspace
        </SectionLabel>

        {currentProject && worktrees && worktrees.length > 0 && (
          <>
            <TooltipProvider delayDuration={300}>
              <div className="flex flex-col gap-px">
                {worktrees.map((wt) => {
                  const isActive = activeView === "workspace" && selectedBranch === wt.branch;
                  return (
                    <div key={wt.branch ?? "__main__"} className="group relative flex items-center min-w-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => {
                              onBranchChange?.(wt.branch);
                              onViewChange("workspace");
                            }}
                            className={cn(
                              "flex-1 min-w-0 flex items-center gap-2 rounded-[5px] pl-2 pr-6 py-1 font-mono text-[11.5px] transition-colors overflow-hidden",
                              !isActive && "text-foreground/80 hover:bg-muted",
                              isActive && "bg-accent text-accent-foreground font-medium"
                            )}
                          >
                            <StatusDot status={workspaceStatuses?.get(wt.branch === null ? "" : wt.branch)} />
                            <span className="truncate text-left">{wt.branch ?? "main"}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">{wt.branch ?? "main"}</TooltipContent>
                      </Tooltip>
                      {wt.branch !== null && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteWorktree?.(wt);
                          }}
                          className="absolute right-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-all"
                          title="Delete worktree"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </TooltipProvider>
          </>
        )}

        {(!worktrees || worktrees.length === 0) && (
          <div className="mt-0.5">
            <NavItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Workspace"
              active={activeView === "workspace"}
              onClick={() => onViewChange("workspace")}
            />
          </div>
        )}
      </SidebarSection>

      {/* Bottom Section */}
      <SidebarSection>
        <div className="flex flex-col gap-0.5">
          <NavItem
            icon={<Globe className="h-3.5 w-3.5" />}
            label="Remote Servers"
            active={activeView === "remote-servers"}
            onClick={() => onViewChange("remote-servers")}
          />
          <NavItem
            icon={<Settings className="h-3.5 w-3.5" />}
            label="Settings"
            active={activeView === "settings"}
            onClick={() => onViewChange("settings")}
          />
        </div>
      </SidebarSection>
    </nav>
  );
}
