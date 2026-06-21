'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from 'react';
import { WorkspaceTabs } from '@/components/workspace/workspace-tabs';
import { useRules } from '@/hooks/use-rules';
import { useCommands } from '@/hooks/use-commands';
import { ProjectInfoView } from '@/components/project/project-info-view';
import { useProjects } from '@/hooks/use-projects';
import { useWorktrees } from '@/hooks/use-worktrees';
import { useTasks } from '@/hooks/use-tasks';
import { useBranchActivity } from '@/hooks/use-branch-activity';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { CreateProjectDialog } from '@/components/project/create-project-dialog';
import { SettingsView } from '@/components/settings/settings-view';
import { RemoteServersSettings } from '@/components/settings/remote-servers-settings';
import { CreateWorktreeDialog } from '@/components/project/create-worktree-dialog';
import { DeleteWorktreeDialog } from '@/components/project/delete-worktree-dialog';
import { UserMenu } from '@/components/auth/user-menu';
import { Logo } from '@/components/brand/logo';
import { RightPanel } from '@/components/right-panel';
import { AgentConversation, AgentConversationHandle } from '@/components/agent';
import { ProjectRemotesProvider } from '@/hooks/project-remotes-context';
import { MainConversation, type MainConversationHandle } from '@/components/conversation';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AppSidebar, PageHeader, type ActiveView } from '@/components/layout';
import { TasksView } from '@/components/task';
import type { ExecutionMode, Task, Worktree } from '@/lib/api';
import { useGlobalEvents } from '@/hooks/use-global-events';
import { useCompletionNotifications } from '@/hooks/use-completion-notifications';
import { CompletionNotificationsMenu } from '@/components/layout/completion-notifications-menu';
import { useUrlState } from '@/hooks/use-url-state';
import { buildUrl } from '@/lib/url-state';
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
} from '@/lib/workspace-status';
import {
  usePlaceholderWorkspaces,
  workspaceKey,
} from '@/lib/placeholder-workspaces';

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

  const {
    activity: branchActivity,
    since: branchActivitySince,
    refetch: refetchBranchActivity,
    setOptimisticActivity,
  } = useBranchActivity(currentProject?.id ?? null);
  const { rules, createRule, updateRule, deleteRule } = useRules(currentProject?.id ?? null, selectedBranch);
  const { commands, createCommand, updateCommand, deleteCommand } = useCommands(currentProject?.id ?? null, selectedBranch);
  const mainChatRef = useRef<MainConversationHandle>(null);

  // Placeholder set (per-workspace "user hit New Conversation, no DB session
  // yet") layered on top of the SSE-backed activity map. Without this
  // override, switching projects and back wipes the in-memory optimistic
  // "idle" — the snapshot refetch trusts the backend wholesale on a fresh
  // project, and the backend still sees the prior session as the latest
  // (completed/stopped), turning the dot green again. The placeholder set is
  // already persisted in localStorage so it survives project switches.
  const placeholderSet = usePlaceholderWorkspaces();
  const projectIdForKey = currentProject?.id ?? null;
  const agentModeForKey = currentProject?.agent_mode ?? null;
  const isPlaceholder = useCallback(
    (branch: string | null) => {
      if (!projectIdForKey) return false;
      return placeholderSet.has(workspaceKey(projectIdForKey, branch, agentModeForKey));
    },
    [placeholderSet, projectIdForKey, agentModeForKey],
  );
  // Epoch ms when the workspace was reset via New Conversation — used to order
  // the reset against a terminal `main-completed` orchestrator dot so the
  // green dot only survives a reset that predates it. See
  // `computeWorkspaceStatuses`.
  const placeholderSince = useCallback(
    (branch: string | null) => {
      if (!projectIdForKey) return undefined;
      return placeholderSet.get(workspaceKey(projectIdForKey, branch, agentModeForKey));
    },
    [placeholderSet, projectIdForKey, agentModeForKey],
  );
  const backendSince = useCallback(
    (branch: string | null) => branchActivitySince.get(toBranchKey(branch)),
    [branchActivitySince],
  );

  // Compute workspace statuses for all worktrees: SSE-backed activity, with
  // `isPlaceholder` forcing "idle" for branches in placeholder mode. The
  // existing `setOptimisticActivity` calls (send → working) still write
  // directly into the activity map for sub-50ms feedback on other transitions.
  // `timing` lets a reset that post-dates a `main-completed` keep its gray dot
  // across a project switch (the orchestrator overlay would otherwise win).
  const workspaceStatuses = useMemo(
    () =>
      computeWorkspaceStatuses(worktrees, branchActivity, isPlaceholder, {
        backendSince,
        placeholderSince,
      }),
    [worktrees, branchActivity, isPlaceholder, backendSince, placeholderSince]
  );

  // Completion notification center. Listens to the global SSE stream directly
  // (one connection for all projects), plays the completion sound — sound1 for
  // Agent completion (lime dot), sound2 for chat completion (emerald dot) — and
  // feeds the top-right bell with a read/unread list so background-project
  // completions are discoverable and one click away. `activeKey` lets a
  // completion for the workspace already on screen be listed but pre-read (no
  // unread badge for something you can see). See
  // `hooks/use-completion-notifications.ts`.
  const activeKey =
    currentProject && activeView === 'workspace'
      ? `${currentProject.id}:${selectedBranch ?? ''}`
      : null;
  const {
    notifications,
    unreadCount,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    remove: removeNotification,
    clear: clearNotifications,
  } = useCompletionNotifications(activeKey);

  // User just hit send → seed "working" into the activity map ahead of the
  // backend's branch:activity event (sub-50ms latency hide). The backend's
  // emit arrives shortly and is a no-op transition (same value).
  const handleStatusChange = useCallback(() => {
    setOptimisticActivity(selectedBranch, "working");
  }, [selectedBranch, setOptimisticActivity]);

  // Task panel refresh — sidebar dot is driven by useBranchActivity directly,
  // so this handler no longer has any branch-activity side effect.
  const handleTaskCompleted = useCallback(() => {
    refetchTasks();
  }, [refetchTasks]);

  const handleSessionStarted = useCallback(() => {
    refetchBranchActivity();
  }, [refetchBranchActivity]);

  // New Conversation seeds "idle" so the dot turns gray immediately. The
  // backend doesn't emit anything when the user clicks New Conv (no DB
  // session is created until the first message), so this optimistic seed
  // is the only signal until the first send.
  const handleNewConversation = useCallback(() => {
    setOptimisticActivity(selectedBranch, "idle");
  }, [selectedBranch, setOptimisticActivity]);

  // task:* events drive the Tasks panel. Session-status / -finished /
  // -taskCompleted SSE events are no longer consumed here — useBranchActivity
  // owns the workspace dot, and the only task auto-mutation
  // (auto-mark-done-on-success) emits task:updated downstream.
  const handleGlobalTaskChanged = useCallback(() => {
    refetchTasks();
  }, [refetchTasks]);

  useGlobalEvents(currentProject?.id ?? null, {
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
    // Unassigning a task is metadata-only — agent_sessions stays put, so
    // there's no branch-activity transition to seed here.
    updateTask(taskId, { assigned_branch: null });
  }, [updateTask]);

  // Reset branch selection when switching between projects (not on initial load)
  useEffect(() => {
    if (prevProjectId.current !== undefined && prevProjectId.current !== currentProject?.id) {
      setSelectedBranch(null);
    }
    prevProjectId.current = currentProject?.id;
  }, [currentProject?.id]);

  // A cross-project notification click sets this to the branch we want selected
  // once the target project's worktrees finish loading. Without it, the
  // project-change effect above resets selectedBranch to null and the
  // auto-select effect below picks worktrees[0] before our intended branch can
  // take hold. `undefined` = no pending navigation.
  const pendingBranchRef = useRef<string | null | undefined>(undefined);

  // Auto-select first worktree if current selection is not in the list
  useEffect(() => {
    if (worktreesLoading || worktrees.length === 0) return;
    // Honor a pending cross-project branch selection before any fallback.
    const pending = pendingBranchRef.current;
    if (pending !== undefined) {
      if (worktrees.some(w => w.branch === pending)) {
        pendingBranchRef.current = undefined;
        setSelectedBranch(pending);
        return;
      }
      // Target branch isn't in the freshly-loaded project — drop it and fall
      // through to the normal auto-select.
      pendingBranchRef.current = undefined;
    }
    if (!worktrees.some(w => w.branch === selectedBranch)) {
      setSelectedBranch(worktrees[0].branch);
    }
  }, [worktrees, worktreesLoading, selectedBranch]);

  // Jump to the workspace a completion notification points at. Same project →
  // select the branch directly; different project → switch projects and let the
  // auto-select effect honor pendingBranchRef once its worktrees load.
  const handleNavigateToWorkspace = useCallback(
    (projectId: string, branch: string | null) => {
      setActiveView('workspace');
      if (projectId === currentProject?.id) {
        setSelectedBranch(branch);
        return;
      }
      const target = projects.find((p) => p.id === projectId);
      if (!target) return;
      pendingBranchRef.current = branch;
      selectProject(target);
    },
    [currentProject?.id, projects, selectProject],
  );

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

  // Guard against double-click sending the same command twice: ignore a repeat
  // of the same content within a short window (a native double-click fires two
  // click events before the session status can update).
  const lastExecuteRef = useRef<{ content: string; at: number }>({ content: "", at: 0 });
  const handleExecuteCommand = useCallback((content: string) => {
    const now = Date.now();
    const last = lastExecuteRef.current;
    if (last.content === content && now - last.at < 600) return;
    lastExecuteRef.current = { content, at: now };
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
        <div className="border-b border-border bg-card px-3 h-[44px] flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-[9px]">
            <Logo size={22} />
            <h1 className="text-[13px] font-semibold tracking-tight text-foreground">
              VibeDeck<span className="text-primary font-bold">X</span>
            </h1>
          </div>
          <div className="flex items-center gap-1">
            <CompletionNotificationsMenu
              notifications={notifications}
              unreadCount={unreadCount}
              projects={projects}
              onNavigate={handleNavigateToWorkspace}
              markRead={markNotificationRead}
              markAllRead={markAllNotificationsRead}
              remove={removeNotification}
              clear={clearNotifications}
            />
            <UserMenu />
          </div>
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
            needsProject && (activeView === 'workspace' || activeView === 'tasks' || activeView === 'project-info')
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
                <Button variant="accent" size="lg" onClick={() => setCreateDialogOpen(true)} className="shadow-md">
                  <Plus className="h-5 w-5 mr-2" />
                  Create Project
                </Button>
              </div>
            </div>
          </div>

          {/* Workspace View — kept mounted, hidden via CSS to preserve WebSocket */}
          <div className={(activeView !== 'workspace' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden flex'}>
           <ProjectRemotesProvider projectId={currentProject?.id ?? undefined}>
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
                        onNewConversation={handleNewConversation}
                      />
                    }
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
           </ProjectRemotesProvider>
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

          {/* Project Info View */}
          <div className={(activeView !== 'project-info' || needsProject) ? 'hidden' : 'flex-1 overflow-hidden'}>
            {currentProject && (
              <ProjectInfoView
                project={currentProject}
                tasks={tasks}
                worktrees={worktrees}
                selectedBranch={selectedBranch}
                workspaceStatuses={workspaceStatuses}
                onSelectBranch={(branch) => {
                  setSelectedBranch(branch);
                  setActiveView('workspace');
                }}
                onProjectUpdated={updateProject}
              />
            )}
          </div>

          {/* Remote Servers View — only mounted when active to avoid background polling */}
          {activeView === 'remote-servers' && (
            <div className="flex-1 overflow-hidden">
              <div className="h-full flex flex-col overflow-auto">
                <PageHeader title="Remote Servers" />
                <div className="flex-1 px-6 py-5 flex justify-center">
                  <div className="w-full max-w-2xl">
                    <RemoteServersSettings />
                  </div>
                </div>
              </div>
            </div>
          )}

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
