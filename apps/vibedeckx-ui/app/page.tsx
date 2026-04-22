'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from 'react';
import { WorkspaceTabs } from '@/components/workspace/workspace-tabs';
import { useRules } from '@/hooks/use-rules';
import { useCommands } from '@/hooks/use-commands';
import { ProjectInfoView } from '@/components/project/project-info-view';
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
import { UserMenu } from '@/components/auth/user-menu';
import { RightPanel } from '@/components/right-panel';
import { AgentConversation, AgentConversationHandle } from '@/components/agent';
import { MainConversation, type MainConversationHandle } from '@/components/conversation';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
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

  // ?session=<id> param is orthogonal to the path-based URL state (projectId/tab/branch).
  // We keep it here as reactive state so changes via setSessionUrlParam propagate to children.
  const [urlSessionId, setUrlSessionIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('session');
  });

  const setSessionUrlParam = useCallback((sessionId: string | null) => {
    setUrlSessionIdState(sessionId);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set('session', sessionId);
    else url.searchParams.delete('session');
    window.history.replaceState(null, '', url.toString());
  }, []);

  // Keep urlSessionId in sync with browser back/forward navigation. replaceState
  // doesn't fire popstate, but a pushState elsewhere + browser back could leave
  // the URL showing ?session=<A> while React state still holds <B>.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => {
      const next = new URLSearchParams(window.location.search).get('session');
      setUrlSessionIdState(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
    addProject,
    createProject,
    updateProject,
    deleteProject,
    selectProject,
  } = useProjects(urlProject);

  const { worktrees, loading: worktreesLoading, refetch: refetchWorktrees } = useWorktrees(currentProject?.id ?? null);
  const { tasks, loading: tasksLoading, createTask, updateTask, deleteTask, refetch: refetchTasks } = useTasks(currentProject?.id ?? null);
  const { statuses: sessionStatuses, refetch: refetchSessionStatuses } = useSessionStatuses(currentProject?.id ?? null);
  const { rules, createRule, updateRule, deleteRule } = useRules(currentProject?.id ?? null, selectedBranch);
  const { commands, createCommand, updateCommand, deleteCommand } = useCommands(currentProject?.id ?? null, selectedBranch);
  const mainChatRef = useRef<MainConversationHandle>(null);

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

  // Track previous (projectId, branch) so we can detect switches.
  // sessionId is scoped to one (projectId, branch); on switch we must drop it,
  // otherwise the Agent hook would keep loading the prior workspace's session
  // into the new one (cross-workspace content bleed).
  const prevBranchRef = useRef(selectedBranch);
  const prevProjectIdRef = useRef(currentProject?.id);
  // Distinguish the first post-loading effect pass from a real user switch.
  // Without this, `undefined -> <real id>` on initial project load is treated
  // as a project change and strips ?session= from the URL.
  const hasInitializedUrlSyncRef = useRef(false);

  // Sync state to URL
  useEffect(() => {
    if (projectsLoading) return;

    const isInitial = !hasInitializedUrlSyncRef.current;
    const branchChanged = !isInitial && prevBranchRef.current !== selectedBranch;
    const projectChanged = !isInitial && prevProjectIdRef.current !== currentProject?.id;
    prevBranchRef.current = selectedBranch;
    prevProjectIdRef.current = currentProject?.id;
    hasInitializedUrlSyncRef.current = true;

    if ((branchChanged || projectChanged) && urlSessionId) {
      // Clearing state re-triggers this effect; the URL update happens there.
      setSessionUrlParam(null);
      return;
    }

    const url = buildUrl({
      projectId: currentProject?.id,
      tab: activeView,
      branch: selectedBranch,
    });
    // Preserve ?session=<id> on tab changes within the same (projectId, branch).
    if (urlSessionId) {
      const u = new URL(url, window.location.origin);
      u.searchParams.set('session', urlSessionId);
      window.history.replaceState(null, '', u.pathname + u.search);
    } else {
      window.history.replaceState(null, '', url);
    }
  }, [currentProject?.id, activeView, selectedBranch, projectsLoading, urlSessionId, setSessionUrlParam]);

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

  const handleExecuteCommand = useCallback((content: string) => {
    mainChatRef.current?.sendMessage(content);
  }, []);

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

  const needsProject = !currentProject;

  return (
    <div className="h-screen flex flex-col w-full">
        {/* Header with Project Selector */}
        <div className="border-b border-border/60 bg-card/80 backdrop-blur-sm px-4 h-12 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center">
              <span className="text-[10px] font-bold text-primary-foreground tracking-tighter">VDX</span>
            </div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground">VibeDeckX</h1>
          </div>
          <UserMenu />
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
            hasProject={!needsProject}
            projects={projects}
            onSelectProject={selectProject}
            onCreateProjectOpen={() => setCreateDialogOpen(true)}
          />

          {/* Welcome state — shown for project-dependent views when no project exists */}
          <div className={
            needsProject && (activeView === 'workspace' || activeView === 'tasks' || activeView === 'files' || activeView === 'project-info')
              ? 'flex-1 overflow-hidden'
              : 'hidden'
          }>
            <div className="h-full flex items-center justify-center bg-background">
              <div className="text-center space-y-6">
                <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <Plus className="h-8 w-8 text-primary" />
                </div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Welcome to VibeDeckX</h1>
                <p className="text-muted-foreground max-w-sm mx-auto leading-relaxed">
                  Create your first project to get started with AI-powered development.
                </p>
                <Button size="lg" onClick={() => setCreateDialogOpen(true)} className="shadow-md">
                  <Plus className="h-5 w-5 mr-2" />
                  Create Project
                </Button>
              </div>
            </div>
          </div>

          {/* Workspace View — kept mounted, hidden via CSS to preserve WebSocket */}
          <div className={(activeView !== 'workspace' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden flex'}>
            <ResizablePanelGroup direction="horizontal" autoSaveId="workspace-panels">
              {/* Left Panel: Project Card + Main Chat */}
              <ResizablePanel defaultSize={33} minSize={25}>
                <div className="h-full flex flex-col overflow-hidden">
                  {currentProject && (
                    <div className="px-4 py-3 border-b border-border/60 flex-shrink-0">
                      <WorkspaceTabs
                        assignedTask={assignedTask}
                        rules={rules}
                        commands={commands}
                        onCreateRule={createRule}
                        onUpdateRule={updateRule}
                        onDeleteRule={deleteRule}
                        onCreateCommand={createCommand}
                        onUpdateCommand={updateCommand}
                        onDeleteCommand={deleteCommand}
                        onExecuteCommand={handleExecuteCommand}
                        onUpdateTaskTitle={(id, title) => updateTask(id, { title })}
                        onCompleteTask={(id) => {
                          updateTask(id, { status: "done", assigned_branch: null });
                          setRealtimeWorkspaceStatuses(prev => clearRealtimeStatus(prev, selectedBranch));
                        }}
                      />
                    </div>
                  )}
                  <div className="flex-1 overflow-hidden">
                    <MainConversation ref={mainChatRef} projectId={currentProject?.id ?? null} branch={selectedBranch} />
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Right Panel: Agent/Executors/Diff/Terminal as tabs */}
              <ResizablePanel defaultSize={67} minSize={25}>
                <div className="h-full flex flex-col overflow-hidden">
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
                        sessionId={urlSessionId}
                        setSessionUrlParam={setSessionUrlParam}
                        project={currentProject}
                        onAgentModeChange={handleAgentModeChange}
                        onTaskCompleted={handleTaskCompleted}
                        onSessionStarted={handleSessionStarted}
                        onStatusChange={handleStatusChange}
                      />
                    }
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>

          {/* Tasks View — kept mounted, hidden via CSS */}
          <div className={(activeView !== 'tasks' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden'}>
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
          <div className={(activeView !== 'files' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden'}>
            <FilesView
              projectId={currentProject?.id ?? null}
              project={currentProject}
              selectedBranch={selectedBranch}
            />
          </div>

          {/* Project Info View */}
          <div className={(activeView !== 'project-info' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden'}>
            {currentProject && <ProjectInfoView project={currentProject} onProjectUpdated={updateProject} />}
          </div>

          {/* Remote Servers View — kept mounted, hidden via CSS */}
          <div className={activeView !== 'remote-servers' ? 'hidden' : 'flex-1 overflow-hidden'}>
            <div className="h-full flex flex-col overflow-auto">
              <div className="border-b border-border/60 px-6 py-4 flex-shrink-0">
                <h2 className="text-sm font-semibold text-foreground">Remote Servers</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Manage your remote server connections</p>
              </div>
              <div className="flex-1 px-6 py-5 flex justify-center">
                <div className="w-full max-w-2xl">
                <RemoteServersSettings />
                </div>
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
        <CreateProjectDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onProjectCreated={(project) => {
            addProject(project);
            setActiveView("project-info");
          }}
        />
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
