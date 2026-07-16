'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from 'react';
import { WorkspaceTabs } from '@/components/workspace/workspace-tabs';
import { useRules } from '@/hooks/use-rules';
import { useCommands } from '@/hooks/use-commands';
import { ProjectInfoView } from '@/components/project/project-info-view';
import { useProjects } from '@/hooks/use-projects';
import { useWorktrees } from '@/hooks/use-worktrees';
import {
  effectiveTarget,
  useMergeStatus,
  useMergeStatusAutoRefresh,
} from '@/hooks/use-merge-status';
import { useTasks } from '@/hooks/use-tasks';
import { useSchedules } from '@/hooks/use-schedules';
import { SchedulesView } from '@/components/schedule';
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
import type { AgentSession } from '@/hooks/use-agent-session';
import { ProjectRemotesProvider } from '@/hooks/project-remotes-context';
import { MainConversation, type MainConversationHandle } from '@/components/conversation';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AppSidebar, PageHeader, type ActiveView } from '@/components/layout';
import { TasksView } from '@/components/task';
import { api, type ExecutionMode, type Task, type Worktree, type SearchResultWorkspace, type SearchResultSession } from '@/lib/api';
import { QuickSwitcher } from '@/components/search/quick-switcher';
import { useGlobalEvents } from '@/hooks/use-global-events';
import { useCompletionNotifications } from '@/hooks/use-completion-notifications';
import { useResidentSessions, type ResidentSidebarSession } from '@/hooks/use-resident-sessions';
import { CompletionNotificationsMenu } from '@/components/layout/completion-notifications-menu';
import { ConnectionStatusIndicator } from '@/components/layout/connection-status-indicator';
import { useUrlState } from '@/hooks/use-url-state';
import { buildUrl } from '@/lib/url-state';
import {
  type WorkspaceStatus,
  toBranchKey,
  computeWorkspaceStatuses,
} from '@/lib/workspace-status';
import {
  matchesPendingSessionSelection,
  shouldClearSessionAfterWorkspaceChange,
  type PendingSessionSelection,
} from '@/lib/session-url-sync';
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
  const [residentSessionSeed, setResidentSessionSeed] = useState<ResidentSidebarSession | null>(null);

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
  const [activateAgentTabNonce, setActivateAgentTabNonce] = useState(0);
  const [diffCompareNonce, setDiffCompareNonce] = useState(0);
  const agentRef = useRef<AgentConversationHandle>(null);
  // The project id we last reset the branch for. State (not a ref) so the
  // render-time reset below is concurrent-safe.
  const [branchResetProjectId, setBranchResetProjectId] = useState<string | undefined>(undefined);
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

  // Reset the selected branch the instant the project changes — DURING render,
  // not in an effect. An effect runs after this render commits and after child
  // effects fire, so children (file-ref index, rules, commands) would observe a
  // mismatched (newProject, oldBranch) pair for one render and query the new
  // project with the PREVIOUS project's branch — e.g. asking project "eve" for
  // its files on branch "dev3", which it doesn't have, yielding an empty list.
  // Skip the initial undefined→id load so a URL-restored branch survives.
  if (currentProject?.id !== branchResetProjectId) {
    if (branchResetProjectId !== undefined) {
      setSelectedBranch(null);
    }
    setBranchResetProjectId(currentProject?.id);
  }

  const { worktrees, loading: worktreesLoading, refetch: refetchWorktrees } = useWorktrees(currentProject?.id ?? null);
  const {
    statuses: mergeStatuses,
    defaultTarget: mergeDefaultTarget,
    repositoryLabel: mergeRepositoryLabel,
    setTarget: setMergeTarget,
    refetch: refetchMergeStatus,
  } = useMergeStatus(currentProject?.id ?? null, worktrees);
  const residentSessions = useResidentSessions(currentProject?.id ?? null, worktrees, residentSessionSeed);
  const { tasks, loading: tasksLoading, createTask, updateTask, deleteTask, archive, unarchive, refetch: refetchTasks } = useTasks(currentProject?.id ?? null);

  const {
    schedules,
    loading: schedulesLoading,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    runNow: runScheduleNow,
  } = useSchedules(currentProject?.id ?? null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [scheduleCreateOpen, setScheduleCreateOpen] = useState(false);

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

  // Keep sidebar merge badges live: refetch when an agent finishes a turn,
  // on window focus, when an executor for this project stops, and on a
  // visible-tab backstop poll (30s active / 60s idle).
  useMergeStatusAutoRefresh(refetchMergeStatus, workspaceStatuses, currentProject?.id ?? null);

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

  const pendingSessionSelectionRef = useRef<PendingSessionSelection | null>(null);

  // Task panel refresh — sidebar dot is driven by useBranchActivity directly,
  // so this handler no longer has any branch-activity side effect.
  const handleTaskCompleted = useCallback(() => {
    refetchTasks();
  }, [refetchTasks]);

  // Select a specific session in the given branch: the pending-selection ref
  // keeps the URL-sync effect from stripping ?session= on the branch change
  // it causes. Shared by the sidebar resident-session click and the
  // completion-notification click-through.
  const selectBranchSession = useCallback((branch: string | null, sessionId: string, projectId?: string) => {
    pendingSessionSelectionRef.current = {
      projectId: projectId ?? currentProject?.id,
      branch,
      sessionId,
    };
    setSelectedBranch(branch);
    setSessionUrlParam(sessionId);
    setActivateAgentTabNonce((nonce) => nonce + 1);
  }, [currentProject?.id, setSessionUrlParam]);

  const handleResidentSessionSelect = useCallback((resident: ResidentSidebarSession) => {
    selectBranchSession(resident.branch, resident.id);
    setActiveView('workspace');
  }, [selectBranchSession]);

  const handleSessionStarted = useCallback((startedSession: AgentSession) => {
    refetchBranchActivity();
    if (startedSession.processAlive === false) return;
    setResidentSessionSeed({
      id: startedSession.id,
      projectId: startedSession.projectId,
      branch: startedSession.branch,
      title: 'New Session',
      status: startedSession.status,
      processAlive: true,
      updated_at: new Date().toISOString(),
    });
  }, [refetchBranchActivity]);

  const handleSessionTitleUpdated = useCallback((sessionId: string, title: string) => {
    if (!currentProject?.id || !title.trim()) return;
    setResidentSessionSeed((prev) => ({
      id: sessionId,
      projectId: currentProject.id,
      branch: prev?.id === sessionId ? prev.branch : selectedBranch,
      title,
      status: prev?.id === sessionId ? prev.status : 'running',
      processAlive: true,
      updated_at: prev?.id === sessionId ? prev.updated_at : new Date().toISOString(),
    }));
  }, [currentProject?.id, selectedBranch]);

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

  // A cross-project notification click sets this to the workspace (branch +
  // optional session) we want selected once the target project's worktrees
  // finish loading. Without it, the project-change effect above resets
  // selectedBranch to null and the auto-select effect below picks worktrees[0]
  // before our intended branch can take hold. `undefined` = no pending
  // navigation.
  const pendingWorkspaceRef = useRef<
    { branch: string | null; sessionId: string | null } | undefined
  >(undefined);

  // Auto-select first worktree if current selection is not in the list
  useEffect(() => {
    if (worktreesLoading || worktrees.length === 0) return;
    // Honor a pending cross-project workspace selection before any fallback.
    const pending = pendingWorkspaceRef.current;
    if (pending !== undefined) {
      if (worktrees.some(w => w.branch === pending.branch)) {
        pendingWorkspaceRef.current = undefined;
        if (pending.sessionId) {
          selectBranchSession(pending.branch, pending.sessionId);
        } else {
          setSelectedBranch(pending.branch);
        }
        return;
      }
      // Target branch isn't in the freshly-loaded project — drop it and fall
      // through to the normal auto-select.
      pendingWorkspaceRef.current = undefined;
    }
    if (!worktrees.some(w => w.branch === selectedBranch)) {
      setSelectedBranch(worktrees[0].branch);
    }
  }, [worktrees, worktreesLoading, selectedBranch, selectBranchSession]);

  // Jump to the workspace a completion notification points at. Same project →
  // select the branch (and, when known, the exact completed session) directly;
  // different project → switch projects and let the auto-select effect honor
  // pendingWorkspaceRef once its worktrees load.
  const handleNavigateToWorkspace = useCallback(
    (projectId: string, branch: string | null, sessionId: string | null = null) => {
      setActiveView('workspace');
      if (projectId === currentProject?.id) {
        if (sessionId) {
          selectBranchSession(branch, sessionId);
        } else {
          setSelectedBranch(branch);
        }
        return;
      }
      const target = projects.find((p) => p.id === projectId);
      if (!target) return;
      pendingWorkspaceRef.current = { branch, sessionId };
      selectProject(target);
    },
    [currentProject?.id, projects, selectProject, selectBranchSession],
  );

  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Cmd/Ctrl+K opens the quick switcher (same pattern as the sidebar's Cmd+B).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSwitcherOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Cross-target navigation: agent_mode is the single source of truth for
  // which worker a project talks to — switch it (and wait) before navigating.
  const resolveProjectForTarget = useCallback(async (projectId: string, targetId: string) => {
    let project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    const desiredMode = targetId === "local" ? "local" : targetId;
    if ((project.agent_mode ?? "local") !== desiredMode) {
      project = await api.updateProjectMode(project.id, "agentMode", desiredMode);
    }
    return project;
  }, [projects]);

  const handleSwitcherProject = useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    selectProject(project);
    setActiveView("project-info");
    setSwitcherOpen(false);
  }, [projects, selectProject]);

  const handleSwitcherWorkspace = useCallback(async (w: SearchResultWorkspace) => {
    const project = await resolveProjectForTarget(w.projectId, w.targetId);
    if (!project) return;
    selectProject(project);
    setSelectedBranch(w.branch);
    setSessionUrlParam(null);
    setActiveView("workspace");
    setSwitcherOpen(false);
  }, [resolveProjectForTarget, selectProject, setSessionUrlParam]);

  const handleSwitcherSession = useCallback(async (s: SearchResultSession) => {
    const project = await resolveProjectForTarget(s.projectId, s.targetId);
    if (!project) return;
    selectProject(project);
    selectBranchSession(s.branch, s.sessionId, s.projectId);
    setActiveView("workspace");
    setSwitcherOpen(false);
  }, [resolveProjectForTarget, selectProject, selectBranchSession]);

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

    const pendingSessionSelection = pendingSessionSelectionRef.current;
    const matchesPendingSession = matchesPendingSessionSelection(
      pendingSessionSelection,
      currentProject?.id,
      selectedBranch,
      urlSessionId,
    );

    if (matchesPendingSession) {
      pendingSessionSelectionRef.current = null;
    }

    if (
      shouldClearSessionAfterWorkspaceChange({
        branchChanged,
        projectChanged,
        urlSessionId,
        pendingSessionSelection,
        currentProjectId: currentProject?.id,
        selectedBranch,
      })
    ) {
      pendingSessionSelectionRef.current = null;
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
          <div className="flex items-center gap-2.5">
            <ConnectionStatusIndicator />
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
            mergeStatuses={mergeStatuses}
            mergeDefaultTarget={mergeDefaultTarget}
            mergeRepositoryLabel={mergeRepositoryLabel}
            onMergeTargetChange={setMergeTarget}
            onMergeBadgeClick={(branch) => {
              setSelectedBranch(branch);
              setActiveView("workspace");
              setDiffCompareNonce((n) => n + 1);
            }}
            workspaceStatuses={workspaceStatuses}
            residentSessions={residentSessions}
            selectedSessionId={urlSessionId}
            onResidentSessionSelect={handleResidentSessionSelect}
            hasProject={!needsProject}
            projects={projects}
            onSelectProject={selectProject}
            onCreateProjectOpen={() => setCreateDialogOpen(true)}
            schedules={schedules}
            selectedScheduleId={selectedScheduleId}
            onScheduleSelect={(id) => {
              setSelectedScheduleId(id);
              setActiveView("schedules");
            }}
            onCreateScheduleOpen={() => {
              setActiveView("schedules");
              setScheduleCreateOpen(true);
            }}
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
                    active={activeView === 'workspace'}
                    projectId={currentProject?.id ?? null}
                    selectedBranch={selectedBranch}
                    activateAgentTabNonce={activateAgentTabNonce}
                    diffCompareNonce={diffCompareNonce}
                    mergeTarget={
                      selectedBranch
                        ? (effectiveTarget(mergeStatuses.get(selectedBranch)) ??
                          mergeDefaultTarget)
                        : null
                    }
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
                        onSessionTitleUpdated={handleSessionTitleUpdated}
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
              onArchiveTask={archive}
              onUnarchiveTask={unarchive}
            />
          </div>

          {/* Project Info View — only mounted when active to avoid background polling */}
          {activeView === 'project-info' && !needsProject && currentProject && (
            <div className="flex-1 overflow-hidden">
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
            </div>
          )}

          {/* Schedules View — only mounted when active to avoid background polling */}
          {activeView === 'schedules' && !needsProject && currentProject && (
            <div className="flex-1 overflow-hidden">
              <SchedulesView
                projectId={currentProject?.id ?? ""}
                schedules={schedules}
                loading={schedulesLoading}
                selectedId={selectedScheduleId}
                onSelect={setSelectedScheduleId}
                worktrees={worktrees}
                onCreate={createSchedule}
                onUpdate={updateSchedule}
                onDelete={async (id) => {
                  await deleteSchedule(id);
                  if (selectedScheduleId === id) setSelectedScheduleId(null);
                }}
                onRunNow={runScheduleNow}
                createOpen={scheduleCreateOpen}
                onCreateOpenChange={setScheduleCreateOpen}
              />
            </div>
          )}

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
        <QuickSwitcher
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          onNavigateProject={handleSwitcherProject}
          onNavigateWorkspace={handleSwitcherWorkspace}
          onNavigateSession={handleSwitcherSession}
        />
      </div>
  );
}
