"use client";

import { useState } from "react";
import { Calendar, FolderOpen, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskDetailDialog } from "@/components/task/task-detail-dialog";
import { useCreateProjectChatThread } from "@/hooks/use-create-project-chat-thread";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type { Project, SyncButtonConfig, Task } from "@/lib/api";
import { ProjectActivityView } from "./project-activity-view";
import { ProjectSettingsForm } from "./project-settings-form";

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

interface ProjectInfoViewProps {
  project: Project;
  onOpenProjectChatThread?: (threadId: string) => void;
  onOpenAgentSession: (sessionId: string, target: string, branch: string | null) => void;
  onOpenScheduleRun: (runId: string, scheduleId?: string) => void;
  onRunScheduleAgain: (runId: string) => Promise<void> | void;
  onViewAllTasks: () => void;
  onProjectUpdated: (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }) => Promise<void> | Promise<unknown>;
}

export function ProjectInfoView({
  project,
  onOpenProjectChatThread,
  onOpenAgentSession,
  onOpenScheduleRun,
  onRunScheduleAgain,
  onViewAllTasks,
  onProjectUpdated,
}: ProjectInfoViewProps) {
  const { remotes } = useProjectRemotes(project.id);
  const createThread = useCreateProjectChatThread(project.id);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);

  const openTask = (task: Task) => {
    setSelectedTask(task);
    setTaskDetailOpen(true);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden p-4 sm:p-6">
      <Tabs defaultValue="home" className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="home">Home</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="home" className="mt-4 flex-1 space-y-4 overflow-auto pr-1">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="truncate text-lg">{project.name}</CardTitle>
                <StatusBadge project={project} />
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {project.path ? (
                <div className="flex items-start gap-3 text-sm">
                  <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="break-all text-muted-foreground">{project.path}</span>
                </div>
              ) : null}

              {remotes.map((remote) => (
                <div key={remote.id} className="flex items-start gap-3 text-sm">
                  <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="break-all text-muted-foreground">{remote.server_name}</span>
                </div>
              ))}

              <div className="flex items-center gap-3 text-sm">
                <Calendar className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-muted-foreground">
                  Created {new Date(project.created_at).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>

          <ProjectActivityView
            projectId={project.id}
            onCreateThread={onOpenProjectChatThread ? createThread : undefined}
            onOpenThread={onOpenProjectChatThread}
            onOpenAgentSession={onOpenAgentSession}
            onOpenScheduleRun={onOpenScheduleRun}
            onRunScheduleAgain={onRunScheduleAgain}
            onOpenTask={openTask}
            onViewAllTasks={onViewAllTasks}
          />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto">
          <ProjectSettingsForm project={project} onSave={onProjectUpdated} />
        </TabsContent>
      </Tabs>

      <TaskDetailDialog task={selectedTask} open={taskDetailOpen} onOpenChange={setTaskDetailOpen} />
    </div>
  );
}
