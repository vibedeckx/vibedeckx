"use client";

import { useState } from "react";
import { FolderOpen, Globe } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskDetailDialog } from "@/components/task/task-detail-dialog";
import { useCreateProjectChatThread } from "@/hooks/use-create-project-chat-thread";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type { Project, ProjectRemote, SyncButtonConfig, Task } from "@/lib/api";
import { projectInitials } from "@/lib/project-initials";
import { cn } from "@/lib/utils";
import { ProjectActivityView } from "./project-activity-view";
import { ProjectSettingsForm } from "./project-settings-form";

/** Shared horizontal rhythm: hero, tab bar and content all align to one gutter. */
const GUTTER = "mx-auto w-full max-w-[1200px] px-5 sm:px-7";

function StatusBadge({ project }: { project: Project }) {
  const hasLocal = !!project.path;
  const hasRemote = project.is_remote || !!project.remote_path;

  const [label, tone] = hasLocal && hasRemote
    ? ["Local + Remote", "bg-violet-500/10 text-violet-600 dark:text-violet-400"]
    : hasRemote
      ? ["Remote", "bg-blue-500/10 text-blue-600 dark:text-blue-400"]
      : ["Local", "bg-muted text-muted-foreground"];

  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-[1.35]", tone)}>
      {label}
    </span>
  );
}

/** Mono chip for one of the places this project lives. */
function LocationChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-secondary px-2 py-0.5 font-mono text-[11.5px] text-secondary-foreground">
      <span className="shrink-0 text-muted-foreground/70">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

function remoteLabel(remote: ProjectRemote): string {
  return remote.remote_path ? `${remote.server_name}:${remote.remote_path}` : remote.server_name;
}

interface ProjectInfoViewProps {
  project: Project;
  /** Unread attention milestones for this project — see ProjectActivityViewProps. */
  waitingCount: number;
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

const TAB_TRIGGER = cn(
  "relative rounded-none border-0 bg-transparent px-2.5 py-2.5 text-[12.5px] font-medium text-muted-foreground shadow-none",
  "transition-colors hover:text-foreground focus-visible:ring-offset-0",
  "data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
  "after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-[1px] after:bg-primary after:opacity-0",
  "data-[state=active]:after:opacity-100",
);

export function ProjectInfoView({
  project,
  waitingCount,
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
    <Tabs defaultValue="home" className="flex h-full flex-col overflow-hidden">
      {/* One scroller for hero + tabs + panel, so the hero scrolls away under a sticky tab bar. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="relative overflow-hidden border-b bg-card py-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage: "radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)",
              backgroundSize: "16px 16px",
              maskImage: "linear-gradient(to bottom right, #000, transparent 62%)",
              WebkitMaskImage: "linear-gradient(to bottom right, #000, transparent 62%)",
            }}
          />
          <div className={cn("relative", GUTTER)}>
            <div className="flex flex-wrap items-start gap-4">
              <span
                aria-hidden="true"
                className="relative grid size-13 shrink-0 place-items-center overflow-hidden rounded-xl border bg-secondary font-mono text-[19px] font-semibold tracking-[-0.04em] text-primary shadow-sm after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-primary after:opacity-55"
              >
                {projectInitials(project.name)}
              </span>

              <div className="min-w-0 flex-1 basis-[380px]">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70">
                  <span>Project</span>
                  <span aria-hidden="true">·</span>
                  <span>created {new Date(project.created_at).toLocaleDateString()}</span>
                </div>

                <h1 className="flex flex-wrap items-center gap-2.5 font-mono text-[25px] font-semibold tracking-[-0.025em]">
                  <span className="min-w-0 break-all">{project.name}</span>
                  <StatusBadge project={project} />
                </h1>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {project.path ? (
                    <LocationChip icon={<FolderOpen className="size-[11px]" aria-hidden="true" />}>
                      {project.path}
                    </LocationChip>
                  ) : null}
                  {remotes.map((remote) => (
                    <LocationChip key={remote.id} icon={<Globe className="size-[11px]" aria-hidden="true" />}>
                      {remoteLabel(remote)}
                    </LocationChip>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </header>

        <div className="sticky top-0 z-10 border-b bg-card">
          <TabsList className={cn("h-auto justify-start gap-0.5 rounded-none bg-transparent p-0", GUTTER)}>
            <TabsTrigger value="home" className={TAB_TRIGGER}>Home</TabsTrigger>
            <TabsTrigger value="settings" className={TAB_TRIGGER}>Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="home" className={cn("mt-0 py-5 pb-15", GUTTER)}>
          <ProjectActivityView
            projectId={project.id}
            waitingCount={waitingCount}
            onCreateThread={onOpenProjectChatThread ? createThread : undefined}
            onOpenThread={onOpenProjectChatThread}
            onOpenAgentSession={onOpenAgentSession}
            onOpenScheduleRun={onOpenScheduleRun}
            onRunScheduleAgain={onRunScheduleAgain}
            onOpenTask={openTask}
            onViewAllTasks={onViewAllTasks}
          />
        </TabsContent>

        <TabsContent value="settings" className={cn("mt-0 py-5 pb-15", GUTTER)}>
          <ProjectSettingsForm project={project} onSave={onProjectUpdated} />
        </TabsContent>
      </div>

      <TaskDetailDialog task={selectedTask} open={taskDetailOpen} onOpenChange={setTaskDetailOpen} />
    </Tabs>
  );
}
