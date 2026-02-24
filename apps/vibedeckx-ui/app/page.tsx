'use client';
import { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProjectSelector } from '@/components/project/project-selector';
import { ProjectCard } from '@/components/project/project-card';
import { useProjects } from '@/hooks/use-projects';
import { useWorktrees } from '@/hooks/use-worktrees';
import { useTasks } from '@/hooks/use-tasks';
import { useSessionStatuses } from '@/hooks/use-session-statuses';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { CreateProjectDialog } from '@/components/project/create-project-dialog';
import { CreateWorktreeDialog } from '@/components/project/create-worktree-dialog';
import { RightPanel } from '@/components/right-panel';
import { AgentConversation, AgentConversationHandle } from '@/components/agent';
import { AppSidebar, type ActiveView } from '@/components/layout';
import { TasksView } from '@/components/task';
import { FilesView } from '@/components/files';
import type { ExecutionMode, Task } from '@/lib/api';

export type WorkspaceStatus = 'idle' | 'assigned' | 'working' | 'completed';

function isValidTab(value: string | null): value is ActiveView {
  return value === 'workspace' || value === 'tasks' || value === 'files';
}

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const urlProject = searchParams.get('project');
  const urlTab = searchParams.get('tab');
  const urlBranch = searchParams.get('branch');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createWorktreeDialogOpen, setCreateWorktreeDialogOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(urlBranch);
  const [activeView, setActiveView] = useState<ActiveView>(isValidTab(urlTab) ? urlTab : 'tasks');
  const agentRef = useRef<AgentConversationHandle>(null);
  const prevProjectId = useRef<string | undefined>(undefined);

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
  const workspaceStatuses = useMemo(() => {
    const map = new Map<string, WorkspaceStatus>();
    if (!worktrees) return map;

    const selectedKey = selectedBranch === null ? "" : selectedBranch;

    for (const wt of worktrees) {
      const branchKey = wt.branch === null ? "" : wt.branch;

      // 1. Event-driven status (user has interacted with this branch)
      const realtimeStatus = realtimeWorkspaceStatuses.get(branchKey);
      if (realtimeStatus !== undefined) {
        map.set(branchKey, realtimeStatus);
        continue;
      }

      // 2. Fallback: polling + task data
      //    Ignore polling for selected branch (auto-start creates idle "running" sessions)
      const sessionStatus = branchKey === selectedKey
        ? undefined
        : sessionStatuses.get(branchKey);
      const assignedTaskForBranch = tasks.find(t => t.assigned_branch === branchKey);

      if (assignedTaskForBranch && assignedTaskForBranch.status === "done") {
        map.set(branchKey, "completed");
      } else if (sessionStatus === "running") {
        map.set(branchKey, "working");
      } else if (assignedTaskForBranch) {
        map.set(branchKey, "assigned");
      } else {
        map.set(branchKey, "idle");
      }
    }
    return map;
  }, [worktrees, sessionStatuses, tasks, selectedBranch, realtimeWorkspaceStatuses]);

  // Agent started working → blue
  const handleStatusChange = useCallback(() => {
    const branchKey = selectedBranch === null ? "" : selectedBranch;
    setRealtimeWorkspaceStatuses(prev => {
      const next = new Map(prev);
      next.set(branchKey, "working");
      return next;
    });
  }, [selectedBranch]);

  // Task completed → green (+ sync DB data in background)
  const handleTaskCompleted = useCallback(() => {
    const branchKey = selectedBranch === null ? "" : selectedBranch;
    setRealtimeWorkspaceStatuses(prev => {
      const next = new Map(prev);
      next.set(branchKey, "completed");
      return next;
    });
    refetchTasks();
    refetchSessionStatuses();
  }, [selectedBranch, refetchTasks, refetchSessionStatuses]);

  const handleSessionStarted = useCallback(() => {
    refetchSessionStatuses();
  }, [refetchSessionStatuses]);

  // Compute assigned task for the currently selected branch
  const assignedTask = useMemo(() => {
    // Map selectedBranch (null = main) to assigned_branch value ("" = main)
    const branchKey = selectedBranch === null ? "" : selectedBranch;
    return tasks.find((t) => t.assigned_branch === branchKey) ?? null;
  }, [tasks, selectedBranch]);

  const handleStartTask = useCallback((task: Task) => {
    agentRef.current?.submitMessage(task.description ?? task.title);
  }, []);

  const handleResetTask = useCallback((taskId: string) => {
    // Clear realtime status so the branch falls back to polling/task-derived (idle)
    const branchKey = selectedBranch === null ? "" : selectedBranch;
    setRealtimeWorkspaceStatuses(prev => {
      const next = new Map(prev);
      next.delete(branchKey);
      return next;
    });
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
    const params = new URLSearchParams();
    if (currentProject) params.set('project', currentProject.id);
    if (activeView !== 'tasks') params.set('tab', activeView);
    if (selectedBranch) params.set('branch', selectedBranch);
    const url = params.toString() ? `?${params.toString()}` : window.location.pathname;
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
            workspaceStatuses={workspaceStatuses}
          />

          {/* Workspace View — kept mounted, hidden via CSS to preserve WebSocket */}
          <div className={activeView !== 'workspace' ? 'hidden' : 'contents'}>
            {/* Left Panel: Project Card + Agent Conversation */}
            <div className="w-1/2 flex flex-col border-r overflow-hidden">
              {currentProject && (
                <div className="p-4 border-b flex-shrink-0">
                  <ProjectCard
                    project={currentProject}
                    selectedBranch={selectedBranch}
                    onBranchChange={setSelectedBranch}
                    onUpdateProject={updateProject}
                    onDeleteProject={deleteProject}
                    onSyncPrompt={handleSyncPrompt}
                    worktrees={worktrees}
                    onWorktreesRefetch={refetchWorktrees}
                    assignedTask={assignedTask}
                    onStartTask={handleStartTask}
                    onResetTask={handleResetTask}
                  />
                </div>
              )}
              <div className="flex-1 overflow-hidden">
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
              </div>
            </div>

            {/* Right Panel: Executors + Diff */}
            <div className="w-1/2 flex flex-col overflow-hidden">
              <RightPanel
                projectId={currentProject?.id ?? null}
                selectedBranch={selectedBranch}
                onMergeRequest={handleMergeRequest}
                project={currentProject}
                onExecutorModeChange={handleExecutorModeChange}
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
      </div>
  );
}
