'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from 'react';
import { ProjectSelector } from '@/components/project/project-selector';
import { ProjectCard } from '@/components/project/project-card';
import { useProjects } from '@/hooks/use-projects';
import { useWorktrees } from '@/hooks/use-worktrees';
import { useTasks } from '@/hooks/use-tasks';
import { useSessionStatuses } from '@/hooks/use-session-statuses';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { CreateProjectDialog } from '@/components/project/create-project-dialog';
import { SettingsView } from '@/components/settings/settings-view';
import { RemoteServersSettings } from '@/components/settings/remote-servers-settings';
import { CreateWorktreeDialog } from '@/components/project/create-worktree-dialog';
import { DeleteWorktreeDialog } from '@/components/project/delete-worktree-dialog';
import { RightPanel } from '@/components/right-panel';
import { AgentConversation, AgentConversationHandle } from '@/components/agent';
import { MainConversation } from '@/components/conversation';
import { AppSidebar, type ActiveView } from '@/components/layout';
import { TasksView } from '@/components/task';
import { FilesView } from '@/components/files';
import type { ExecutionMode, Task, Worktree } from '@/lib/api';
import { useGlobalEvents } from '@/hooks/use-global-events';
import { useUrlState } from '@/hooks/use-url-state';
import { buildUrl } from '@/lib/url-state';
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
  applyStatusWorking,
  applyStatusCompleted,
  clearRealtimeStatus,
  applyGlobalSessionStatus,
} from '@/lib/workspace-status';

export type { WorkspaceStatus } from '@/lib/workspace-status';

export default function Home() {
  const { projectId: urlProject, tab: urlTab, branch: urlBranch } = useUrlState();

  // Redirect legacy ?project= URLs to new path format
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('project')) {
      const url = buildUrl({ projectId: urlProject, tab: urlTab, branch: urlBranch });
      window.history.replaceState(null, '', url);
    }
  }, []);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createWorktreeDialogOpen, setCreateWorktreeDialogOpen] = useState(false);
  const [deleteWorktreeDialogOpen, setDeleteWorktreeDialogOpen] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<Worktree | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(urlBranch);
  const [activeView, setActiveView] = useState<ActiveView>(urlTab);
  const agentRef = useRef<AgentConversationHandle>(null);
  const prevProjectId = useRef<string | undefined>(undefined);
  const [startingTask, startTaskTransition] = useTransition();

  const {
    projects,
    currentProject,
    loading: projectsLoading,
    createProject,
    updateProject,
    deleteProject,
    selectProject,
  } = useProjects(urlProject);

  const { worktrees, loading: worktreesLoading, refetch: refetchWorktrees } = useWorktrees(currentProject?.id ?? null);
  const { tasks, loading: tasksLoading, createTask, updateTask, deleteTask, refetch: refetchTasks } = useTasks(currentProject?.id ?? null);
  const { statuses: sessionStatuses, refetch: refetchSessionStatuses } = useSessionStatuses(currentProject?.id ?? null);

  // Per-branch real-time workspace statuses, set directly from events.
  // Persists across branch switches so switching away doesn't lose status.
  const [realtimeWorkspaceStatuses, setRealtimeWorkspaceStatuses] = useState<Map<string, WorkspaceStatus>>(new Map());

  // Compute workspace statuses for all worktrees
  const workspaceStatuses = useMemo(
    () => computeWorkspaceStatuses(worktrees, realtimeWorkspaceStatuses, sessionStatuses, tasks, selectedBranch),
    [worktrees, sessionStatuses, tasks, selectedBranch, realtimeWorkspaceStatuses]
  );

  // Agent started working → blue
  const handleStatusChange = useCallback(() => {
    setRealtimeWorkspaceStatuses(prev => applyStatusWorking(prev, selectedBranch));
  }, [selectedBranch]);

  // Task completed → green (+ sync DB data in background)
  const handleTaskCompleted = useCallback(() => {
    setRealtimeWorkspaceStatuses(prev => applyStatusCompleted(prev, selectedBranch));
    refetchTasks();
    refetchSessionStatuses();
  }, [selectedBranch, refetchTasks, refetchSessionStatuses]);

  const handleSessionStarted = useCallback(() => {
    refetchSessionStatuses();
  }, [refetchSessionStatuses]);

  // Global SSE events — updates sidebar status for non-selected workspaces
  const handleGlobalSessionStatus = useCallback((branch: string | null, status: "running" | "stopped" | "error") => {
    setRealtimeWorkspaceStatuses(prev => {
      const result = applyGlobalSessionStatus(prev, branch, status);
      if (result.shouldRefetchTasks) {
        refetchTasks();
      }
      return result.realtimeStatuses;
    });
    refetchSessionStatuses();
  }, [refetchSessionStatuses, refetchTasks]);

  const handleGlobalSessionFinished = useCallback((branch: string | null) => {
    // Clear realtime entry and refetch so fallback picks up task completion
    setRealtimeWorkspaceStatuses(prev => clearRealtimeStatus(prev, branch));
    refetchTasks();
    refetchSessionStatuses();
  }, [refetchTasks, refetchSessionStatuses]);

  const handleGlobalTaskChanged = useCallback(() => {
    refetchTasks();
  }, [refetchTasks]);

  useGlobalEvents(currentProject?.id ?? null, {
    onSessionStatus: handleGlobalSessionStatus,
    onSessionFinished: handleGlobalSessionFinished,
    onTaskChanged: handleGlobalTaskChanged,
  });

  // Compute assigned task for the currently selected branch
  const assignedTask = useMemo(() => {
    const branchKey = toBranchKey(selectedBranch);
    return tasks.find((t) => t.assigned_branch === branchKey) ?? null;
  }, [tasks, selectedBranch]);

  const handleStartTask = useCallback((task: Task) => {
    startTaskTransition(async () => {
      await agentRef.current?.submitMessage(task.description ?? task.title);
    });
  }, []);

  const handleResetTask = useCallback((taskId: string) => {
    // Clear realtime status so the branch falls back to polling/task-derived (idle)
    setRealtimeWorkspaceStatuses(prev => clearRealtimeStatus(prev, selectedBranch));
    updateTask(taskId, { assigned_branch: null });
  }, [selectedBranch, updateTask]);

  // Reset branch selection when switching between projects (not on initial load)
  useEffect(() => {
    if (prevProjectId.current !== undefined && prevProjectId.current !== currentProject?.id) {
      setSelectedBranch(null);
    }
    prevProjectId.current = currentProject?.id;
  }, [currentProject?.id]);

  // Auto-select first worktree if current selection is not in the list
  useEffect(() => {
    if (worktreesLoading || worktrees.length === 0) return;
    if (!worktrees.some(w => w.branch === selectedBranch)) {
      setSelectedBranch(worktrees[0].branch);
    }
  }, [worktrees, worktreesLoading, selectedBranch]);

  // Sync state to URL
  useEffect(() => {
    if (projectsLoading) return;
    const url = buildUrl({
      projectId: currentProject?.id,
      tab: activeView,
      branch: selectedBranch,
    });
    window.history.replaceState(null, '', url);
  }, [currentProject?.id, activeView, selectedBranch, projectsLoading]);

  const handleWorktreeCreated = useCallback((branch: string) => {
    refetchWorktrees();
    setSelectedBranch(branch);
  }, [refetchWorktrees]);

  const handleSyncPrompt = useCallback((prompt: string, executionMode: ExecutionMode) => {
    if (currentProject && executionMode !== currentProject.agent_mode) {
      updateProject(currentProject.id, { agentMode: executionMode }).then(() => {
        agentRef.current?.submitMessage(prompt);
      });
    } else {
      agentRef.current?.submitMessage(prompt);
    }
  }, [currentProject, updateProject]);

  const handleMergeRequest = useCallback(() => {
    const prompt = `Please perform the following git operations for this worktree:

1. Commit all current uncommitted changes with an appropriate commit message
2. Fetch the latest changes from the remote main branch
3. Rebase the current branch onto main (resolve any conflicts if needed)
4. Merge the current branch into main

Please proceed step by step and let me know if there are any issues or conflicts that need manual resolution.`;

    agentRef.current?.submitMessage(prompt);
  }, []);

  const handleAgentModeChange = useCallback(async (mode: ExecutionMode) => {
    if (!currentProject) return;
    try {
      await updateProject(currentProject.id, { agentMode: mode });
    } catch (error) {
      console.error('Failed to update agent mode:', error);
    }
  }, [currentProject, updateProject]);

  const handleExecutorModeChange = useCallback(async (mode: ExecutionMode) => {
    if (!currentProject) return;
    try {
      await updateProject(currentProject.id, { executorMode: mode });
    } catch (error) {
      console.error('Failed to update executor mode:', error);
    }
  }, [currentProject, updateProject]);

  if (!projectsLoading && projects.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-6">
          <h1 className="text-4xl font-bold">Welcome to Vibedeckx</h1>
          <p className="text-muted-foreground">
            Create your first project to get started
          </p>
          <Button size="lg" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-5 w-5 mr-2" />
            Create Project
          </Button>
          <CreateProjectDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
            onProjectCreated={createProject}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col w-full">
        {/* Header with Project Selector */}
        <div className="border-b p-3 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Vibedeckx</h1>
          <ProjectSelector
            projects={projects}
            currentProject={currentProject}
            onSelectProject={selectProject}
            onCreateProject={createProject}
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar Navigation */}
          <AppSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            worktrees={worktrees}
            selectedBranch={selectedBranch}
            onBranchChange={setSelectedBranch}
            currentProject={currentProject}
            onCreateWorktreeOpen={() => setCreateWorktreeDialogOpen(true)}
            onDeleteWorktree={(wt) => {
              setWorktreeToDelete(wt);
              setDeleteWorktreeDialogOpen(true);
            }}
            workspaceStatuses={workspaceStatuses}
          />

          {/* Workspace View — kept mounted, hidden via CSS to preserve WebSocket */}
          <div className={activeView !== 'workspace' ? 'hidden' : 'contents'}>
            {/* Left Panel: Project Card + Main Chat */}
            <div className="w-1/2 flex flex-col border-r overflow-hidden">
              {currentProject && (
                <div className="p-4 border-b flex-shrink-0">
                  <ProjectCard
                    project={currentProject}
                    selectedBranch={selectedBranch}
                    onUpdateProject={updateProject}
                    onDeleteProject={deleteProject}
                    onSyncPrompt={handleSyncPrompt}
                    assignedTask={assignedTask}
                    onStartTask={handleStartTask}
                    onResetTask={handleResetTask}
                    startingTask={startingTask}
                  />
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                <MainConversation projectId={currentProject?.id ?? null} branch={selectedBranch} />
              </div>
            </div>

            {/* Right Panel: Agent/Executors/Diff/Terminal as tabs */}
            <div className="w-1/2 flex flex-col overflow-hidden">
              <RightPanel
                projectId={currentProject?.id ?? null}
                selectedBranch={selectedBranch}
                onMergeRequest={handleMergeRequest}
                project={currentProject}
                onExecutorModeChange={handleExecutorModeChange}
                agentSlot={
                  <AgentConversation
                    ref={agentRef}
                    projectId={currentProject?.id ?? null}
                    branch={selectedBranch}
                    project={currentProject}
                    onAgentModeChange={handleAgentModeChange}
                    onTaskCompleted={handleTaskCompleted}
                    onSessionStarted={handleSessionStarted}
                    onStatusChange={handleStatusChange}
                  />
                }
              />
            </div>
          </div>

          {/* Tasks View — kept mounted, hidden via CSS */}
          <div className={activeView !== 'tasks' ? 'hidden' : 'flex-1 overflow-hidden'}>
            <TasksView
              projectId={currentProject?.id ?? null}
              tasks={tasks}
              loading={tasksLoading}
              worktrees={worktrees}
              onCreateTask={createTask}
              onUpdateTask={updateTask}
              onDeleteTask={deleteTask}
            />
          </div>

          {/* Files View — kept mounted, hidden via CSS */}
          <div className={activeView !== 'files' ? 'hidden' : 'flex-1 overflow-hidden'}>
            <FilesView
              projectId={currentProject?.id ?? null}
              project={currentProject}
              selectedBranch={selectedBranch}
            />
          </div>

          {/* Remote Servers View — kept mounted, hidden via CSS */}
          <div className={activeView !== 'remote-servers' ? 'hidden' : 'flex-1 overflow-hidden'}>
            <div className="h-full flex flex-col overflow-auto">
              <div className="border-b px-6 py-4 flex-shrink-0">
                <h2 className="text-lg font-semibold">Remote Servers</h2>
              </div>
              <div className="flex-1 px-6 py-4">
                <RemoteServersSettings />
              </div>
            </div>
          </div>

          {/* Settings View — kept mounted, hidden via CSS */}
          <div className={activeView !== 'settings' ? 'hidden' : 'flex-1 overflow-hidden'}>
            <SettingsView />
          </div>
        </div>

        {/* Sidebar's Create Worktree Dialog */}
        {currentProject && (
          <CreateWorktreeDialog
            projectId={currentProject.id}
            project={currentProject}
            open={createWorktreeDialogOpen}
            onOpenChange={setCreateWorktreeDialogOpen}
            onWorktreeCreated={handleWorktreeCreated}
          />
        )}
        {currentProject && (
          <DeleteWorktreeDialog
            projectId={currentProject.id}
            worktree={worktreeToDelete}
            open={deleteWorktreeDialogOpen}
            onOpenChange={setDeleteWorktreeDialogOpen}
            onWorktreeDeleted={refetchWorktrees}
          />
        )}
      </div>
  );
}
