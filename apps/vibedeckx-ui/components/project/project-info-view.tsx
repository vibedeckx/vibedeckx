"use client";

import { useMemo, useState } from "react";
import {
  FolderOpen,
  Globe,
  Calendar,
  GitBranch,
  Circle,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type {
  Project,
  SyncButtonConfig,
  Task,
  TaskPriority,
  TaskStatus,
  Worktree,
} from "@/lib/api";
import { toBranchKey, type WorkspaceStatus } from "@/lib/workspace-status";
import { ProjectSettingsForm } from "./project-settings-form";
import { TaskDetailDialog } from "@/components/task/task-detail-dialog";

function StatusBadge({ project }: { project: Project }) {
  const hasLocal = !!project.path;
  const hasRemote = project.is_remote || !!project.remote_path;

  if (hasLocal && hasRemote) {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-500/10 px-2.5 py-0.5 text-xs font-medium text-purple-600">
        Local + Remote
      </span>
    );
  }
  if (hasRemote) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600">
        Remote
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      Local
    </span>
  );
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />;
    case "in_progress":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 text-blue-600" />;
    case "cancelled":
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />;
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

function PriorityDot({ priority }: { priority: TaskPriority }) {
  if (priority === "urgent") {
    return <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />;
  }
  if (priority === "high") {
    return <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shrink-0" />;
  }
  return null;
}

function WorkspaceStatusDot({ status }: { status: WorkspaceStatus | undefined }) {
  const color =
    status === "working"
      ? "bg-blue-500"
      : status === "completed"
        ? "bg-green-500"
        : status === "stopped"
          ? "bg-amber-500"
          : "bg-muted-foreground/40";
  return <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${color}`} />;
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  todo: 1,
  done: 2,
  cancelled: 3,
};
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface ProjectInfoViewProps {
  project: Project;
  tasks: Task[];
  worktrees: Worktree[];
  selectedBranch: string | null;
  workspaceStatuses: Map<string, WorkspaceStatus>;
  onSelectBranch: (branch: string | null) => void;
  onProjectUpdated: (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    remoteUrl?: string | null;
    remoteApiKey?: string | null;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }) => Promise<void> | Promise<unknown>;
}

export function ProjectInfoView({
  project,
  tasks,
  worktrees,
  selectedBranch,
  workspaceStatuses,
  onSelectBranch,
  onProjectUpdated,
}: ProjectInfoViewProps) {
  const { remotes } = useProjectRemotes(project.id);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (s !== 0) return s;
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (p !== 0) return p;
      return b.updated_at.localeCompare(a.updated_at);
    });
  }, [tasks]);

  const visibleTasks = sortedTasks.slice(0, 5);

  return (
    <div className="h-full flex flex-col p-6 overflow-hidden">
      <Tabs defaultValue="home" className="w-full max-w-4xl mx-auto flex flex-col flex-1 min-h-0">
        <TabsList>
          <TabsTrigger value="home">Home</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="home" className="flex-1 overflow-auto mt-4 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{project.name}</CardTitle>
                <StatusBadge project={project} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {project.path && (
                <div className="flex items-start gap-3 text-sm">
                  <FolderOpen className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground break-all">{project.path}</span>
                </div>
              )}

              {remotes.map((r) => (
                <div key={r.id} className="flex items-start gap-3 text-sm">
                  <Globe className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="text-muted-foreground break-all">{r.server_name}</span>
                    {r.server_url && (
                      <span className="block text-xs text-muted-foreground/70 break-all">{r.server_url}</span>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  Created {new Date(project.created_at).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center justify-between">
                  <span>Tasks</span>
                  <span className="text-xs font-normal text-muted-foreground">{tasks.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {visibleTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tasks yet</p>
                ) : (
                  <ul className="space-y-2">
                    {visibleTasks.map((t) => {
                      const dim = t.status === "done" || t.status === "cancelled";
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTask(t);
                              setTaskDetailOpen(true);
                            }}
                            className="flex w-full items-center gap-2 text-sm rounded-md px-2 py-1 -mx-2 hover:bg-muted/60 transition-colors text-left"
                          >
                            <TaskStatusIcon status={t.status} />
                            <span
                              className={`flex-1 truncate ${
                                dim ? "text-muted-foreground line-through" : ""
                              }`}
                            >
                              {t.title}
                            </span>
                            <PriorityDot priority={t.priority} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {tasks.length > visibleTasks.length && (
                  <p className="text-xs text-muted-foreground mt-3">
                    +{tasks.length - visibleTasks.length} more
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center justify-between">
                  <span>Workspaces</span>
                  <span className="text-xs font-normal text-muted-foreground">{worktrees.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {worktrees.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workspaces</p>
                ) : (
                  <ul className="space-y-2">
                    {worktrees.map((wt) => {
                      const branchKey = toBranchKey(wt.branch);
                      const isSelected = selectedBranch === wt.branch;
                      return (
                        <li key={branchKey}>
                          <button
                            type="button"
                            onClick={() => onSelectBranch(wt.branch)}
                            className="flex w-full items-center gap-2 text-sm rounded-md px-2 py-1 -mx-2 hover:bg-muted/60 transition-colors text-left"
                          >
                            <WorkspaceStatusDot status={workspaceStatuses.get(branchKey)} />
                            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span
                              className={`flex-1 truncate ${
                                isSelected ? "font-medium text-foreground" : "text-muted-foreground"
                              }`}
                            >
                              {wt.branch ?? "(main)"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto">
          <ProjectSettingsForm
            project={project}
            onSave={onProjectUpdated}
          />
        </TabsContent>
      </Tabs>

      <TaskDetailDialog
        task={selectedTask}
        open={taskDetailOpen}
        onOpenChange={setTaskDetailOpen}
      />
    </div>
  );
}
