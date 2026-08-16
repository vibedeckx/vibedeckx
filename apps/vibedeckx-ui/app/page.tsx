'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from 'react';
import { WorkspaceTabs } from '@/components/workspace/workspace-tabs';
import { useRules } from '@/hooks/use-rules';
import { useCommands } from '@/hooks/use-commands';
import { ProjectInfoView } from '@/components/project/project-info-view';
import { ProjectChatWorkbench } from '@/components/project-chat';
import { useProjects } from '@/hooks/use-projects';
import { useWorktrees } from '@/hooks/use-worktrees';
import {
  effectiveTarget,
  useMergeStatus,
  useMergeStatusAutoRefresh,
} from '@/hooks/use-merge-status';
import { useTasks } from '@/hooks/use-tasks';
import { useSchedules } from '@/hooks/use-schedules';
import { useProjectActivityActions } from '@/hooks/use-project-activity-actions';
import { useProjectChatContextNavigation } from '@/hooks/use-project-chat-context-navigation';
import { SchedulesView } from '@/components/schedule';
import { useBranchActivity } from '@/hooks/use-branch-activity';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Plus, Search } from 'lucide-react';
import { useAppConfig } from '@/hooks/use-app-config';
import { DiscordButton } from '@/components/layout/discord-button';
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
import { TaskDetailDialog } from '@/components/task/task-detail-dialog';
import { api, type ExecutionMode, type Task, type Worktree, type SearchResultWorkspace, type SearchResultSession } from '@/lib/api';
import { QuickSwitcher } from '@/components/search/quick-switcher';
import { touchRecentSessionOpen, touchSessionStarted, updateCachedSessionTitle } from '@/lib/quick-switcher-cache';
import { toast } from 'sonner';
import { useGlobalEvents } from '@/hooks/use-global-events';
import { useCompletionNotifications } from '@/hooks/use-completion-notifications';
import { useResidentSessions, type ResidentSidebarSession } from '@/hooks/use-resident-sessions';
import { CompletionNotificationsMenu } from '@/components/layout/completion-notifications-menu';
import { KeyboardShortcutsOverlay } from '@/components/layout/keyboard-shortcuts-overlay';
import { ConnectionStatusIndicator } from '@/components/layout/connection-status-indicator';
import { useUrlState } from '@/hooks/use-url-state';
import { buildUrl } from '@/lib/url-state';
import {
  toBranchKey,
  computeWorkspaceStatuses,
} from '@/lib/workspace-status';
import {
  usePlaceholderWorkspaces,
  workspaceKey,
} from '@/lib/placeholder-workspaces';
import {
  selectionForProjectSwitch,
  type PendingWorkspaceNavigation,
} from '@/lib/pending-navigation';

export type { WorkspaceStatus } from '@/lib/workspace-status';

export default function Home() {
  const { projectId: urlProject, tab: urlTab, branch: urlBranch, threadId: urlThreadId } = useUrlState();
  const { config } = useAppConfig();

  // The workspace selection is ONE atomic value: the branch on screen plus an
  // optionally pinned session (?session=<id>). A session is scoped to its
  // branch, so every navigation must state both fields together — workspace
  // navigation pins nothing (sessionId: null), a session jump pins its id.
  // Keeping them in a single state means no effect ever has to infer whether
  // a branch change was "supposed to" keep the pin.
  const [selection, setSelection] = useState<{ branch: string | null; sessionId: string | null }>(() => ({
    branch: urlBranch,
    sessionId: typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('session'),
  }));
  const selectedBranch = selection.branch;
  const urlSessionId = selection.sessionId;
  // Workspace navigation: a branch change never carries a session pin.
  const selectWorkspace = useCallback((branch: string | null) => {
    setSelection({ branch, sessionId: null });
  }, []);
  // Pin/unpin a session within the current workspace (session picker, New
  // Conversation, commander auto-surface). The URL itself is written by the
  // URL-sync effect below.
  const setSessionUrlParam = useCallback((sessionId: string | null) => {
    setSelection((prev) => (prev.sessionId === sessionId ? prev : { ...prev, sessionId }));
  }, []);
  const [residentSessionSeed, setResidentSessionSeed] = useState<ResidentSidebarSession | null>(null);

  // Keep the pinned session in sync with browser back/forward navigation.
  // replaceState doesn't fire popstate, but a pushState elsewhere + browser
  // back could leave the URL showing ?session=<A> while state still holds <B>.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => {
      const next = new URLSearchParams(window.location.search).get('session');
      setSelection((prev) => (prev.sessionId === next ? prev : { ...prev, sessionId: next }));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Redirect legacy ?project= URLs to new path format
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('project')) {
      const url = buildUrl({ projectId: urlProject, tab: urlTab, branch: urlBranch, threadId: urlThreadId });
      window.history.replaceState(null, '', url);
    }
  }, []);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createWorktreeDialogOpen, setCreateWorktreeDialogOpen] = useState(false);
  const [deleteWorktreeDialogOpen, setDeleteWorktreeDialogOpen] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<Worktree | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(urlTab);
  const [selectedProjectChatThreadId, setSelectedProjectChatThreadId] = useState<string | null>(urlThreadId);
  const [activateAgentTabNonce, setActivateAgentTabNonce] = useState(0);
  const [diffCompareNonce, setDiffCompareNonce] = useState(0);
  // True while a cross-project session jump is still resolving: the project has
  // switched but its worktrees haven't loaded, so selectedBranch is null and the
  // activateAgentTabNonce bump hasn't landed yet. RightPanel uses this to pin the
  // Agent tab across that window instead of briefly showing the new project's
  // persisted tab (e.g. Executors). Cleared the moment the pending selection is
  // consumed (see selectBranchSession and the worktrees-loaded effect).
  const [sessionNavPending, setSessionNavPending] = useState(false);
  // Branch-only sibling of sessionNavPending: suspends the agent session hook
  // across the same cross-project window but does NOT pin the Agent tab
  // (branch-only jumps keep the target workspace's persisted tab). Without it
  // a workspace jump auto-starts at (newProject, branch=null) and loads /
  // previews main's latest session before the target branch lands.
  const [branchNavPending, setBranchNavPending] = useState(false);
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
    routeProjectPending,
    routeProjectNotFound,
  } = useProjects(urlProject);

  // A cross-project jump (quick switcher, notification click) stages the
  // workspace — branch + optional session — it is navigating to here, tagged
  // with the project it belongs to. The render-phase switch below applies it
  // immediately; the worktrees-loaded effect then validates it against the new
  // project's real branch list. `undefined` = no pending navigation.
  const pendingWorkspaceRef = useRef<PendingWorkspaceNavigation | undefined>(undefined);

  // Re-point the selection the instant the project changes — DURING render,
  // not in an effect. An effect runs after this render commits and after child
  // effects fire, so children (file-ref index, rules, commands) would observe a
  // mismatched (newProject, oldBranch) pair for one render and query the new
  // project with the PREVIOUS project's branch — e.g. asking project "eve" for
  // its files on branch "dev3", which it doesn't have, yielding an empty list.
  // Skip the initial undefined→id load so a URL-restored branch survives.
  //
  // A staged jump lands its target here rather than null (see
  // selectionForProjectSwitch): the branch is known at staging time, so there
  // is no reason for every branch-scoped consumer to query main for the length
  // of the worktree fetch first. The worktrees-loaded effect below still
  // validates the target and falls back if it no longer exists.
  if (currentProject?.id !== branchResetProjectId) {
    if (branchResetProjectId !== undefined) {
      const applied = selectionForProjectSwitch(pendingWorkspaceRef.current, currentProject?.id);
      setSelection(applied);
      // Same bump selectBranchSession makes: the panel's persisted tab for the
      // target workspace (often Executors) is read the moment the branch lands,
      // and a session jump must show Agent. Pinning via sessionNavPending no
      // longer covers this — with the branch non-null from this render on, the
      // pin's own release condition is already met.
      if (applied.sessionId) setActivateAgentTabNonce((nonce) => nonce + 1);
    }
    setBranchResetProjectId(currentProject?.id);
  }

  const { worktrees, loading: worktreesLoading, stale: worktreesStale, refetch: refetchWorktrees } = useWorktrees(
    currentProject?.id ?? null,
    selectedBranch,
    // Worktree lists are per-target: switching agent_mode must invalidate the
    // list (and its cache entry), or a cross-target jump gets validated
    // against the previous target's branches.
    currentProject?.agent_mode ?? null,
  );
  const {
    statuses: mergeStatuses,
    rootDirty: mergeRootDirty,
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
  const [selectedScheduleRunId, setSelectedScheduleRunId] = useState<string | null>(null);
  const [scheduleCreateOpen, setScheduleCreateOpen] = useState(false);
  const [projectChatContextTask, setProjectChatContextTask] = useState<Task | null>(null);

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

  // Attention-milestone notification center, hydrated from the server inbox and
  // kept fresh by `notification:created` SSE. Feeds the top-right bell with a
  // read/unread list so background-project results are discoverable and one
  // click away.
  //
  // The hook takes the EXACT session on screen, not a `project:branch` key: a
  // milestone is auto-read only when the user is looking at its own session, so
  // a sibling session finishing on the same branch still raises the badge.
  //
  // Sourced from what AgentConversation actually RENDERS, not from
  // `urlSessionId`: opening a workspace without `?session=` still shows the
  // branch's auto-restored conversation, and treating that as "nothing visible"
  // would leave its own notifications stuck unread.
  const [renderedSessionId, setRenderedSessionId] = useState<string | null>(null);
  const activeNotificationSessionId =
    activeView === 'workspace' ? renderedSessionId : null;
  const {
    notifications,
    unreadCount,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    remove: removeNotification,
    clear: clearNotifications,
  } = useCompletionNotifications(activeNotificationSessionId);

  // The project dashboard's Waiting tile. Derived from the bell's own state so
  // the two can never disagree — including the case that a server-side count
  // handles worst: reading a notification in the menu drops this immediately,
  // where the activity aggregate would not refetch at all.
  const projectWaitingCount = useMemo(
    () => notifications.filter((n) => n.project_id === currentProject?.id && n.read_at === null).length,
    [notifications, currentProject?.id],
  );

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

  // Select a specific session in the given branch. Shared by the sidebar
  // resident-session click and the completion-notification click-through.
  const selectBranchSession = useCallback((branch: string | null, sessionId: string) => {
    setSelection({ branch, sessionId });
    setActivateAgentTabNonce((nonce) => nonce + 1);
    // Selection resolved — end any pending-nav Agent-tab pin (the nonce bump
    // above now owns keeping the Agent tab active).
    setSessionNavPending(false);
    // The session being opened counts as recent from this moment (VS Code
    // MRU-by-open), even if no activity ever bumps it server-side. Id-only:
    // callers holding a full search row (quick switcher) touch it themselves.
    touchRecentSessionOpen(sessionId);
  }, []);

  const handleResidentSessionSelect = useCallback((resident: ResidentSidebarSession) => {
    selectBranchSession(resident.branch, resident.id);
    setActiveView('workspace');
  }, [selectBranchSession]);

  const handleSessionStarted = useCallback((startedSession: AgentSession) => {
    refetchBranchActivity();
    // Full-row MRU touch: the quick switcher's instant first frame renders
    // from a cached snapshot that predates this session; without a full copy
    // the overlay can't show it, so it would pop in when the first
    // /api/search lands — shifting rows under the cmdk highlight. Before the
    // processAlive gate: opening counts as recent regardless of process state.
    const startedProject = projects.find((p) => p.id === startedSession.projectId);
    touchSessionStarted({
      sessionId: startedSession.id,
      projectId: startedSession.projectId,
      projectName: startedProject?.name ?? '',
      targetId: startedProject?.agent_mode ?? 'local',
      branch: startedSession.branch,
    });
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
  }, [refetchBranchActivity, projects]);

  const handleSessionTitleUpdated = useCallback((sessionId: string, title: string) => {
    // Per-session WS path: also write the title into the quick-switcher
    // caches. The global `session:title` SSE listener (QuickSwitcher) is the
    // primary channel, but WS can deliver while the shared SSE stream is
    // stale — and the write-through is idempotent.
    if (title.trim()) updateCachedSessionTitle(sessionId, title.trim());
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

  // Auto-select first worktree if current selection is not in the list
  useEffect(() => {
    const pending = pendingWorkspaceRef.current;
    // A staged target whose project is no longer the current one was
    // superseded — by a sidebar project click, or by a later jump. Retire it
    // here, before anything else: leaving it parked would let its project
    // becoming current again (minutes later, by any route) replay a target the
    // user has long since navigated away from. Its pins go with it — nothing
    // will complete this navigation, and the pin safety net below never fires
    // while the branch is null, which the root workspace's is.
    //
    // Deliberately ahead of the worktree guards: this decision is about which
    // project is current, and needs no branch list at all.
    if (pending !== undefined && pending.projectId !== currentProject?.id) {
      pendingWorkspaceRef.current = undefined;
      setSessionNavPending(false);
      setBranchNavPending(false);
    }
    // A cache-seeded list (stale=false, fetch still revalidating) is good
    // enough to APPLY a pending selection — that is what makes a jump into a
    // previously-visited project instant. It is NOT good enough to DROP one:
    // the target branch may have been created after the cache was written, so
    // a miss is only authoritative once the fresh fetch settles (loading
    // false). The fallback auto-select stays fresh-list-only too.
    if (worktreesStale || worktrees.length === 0) return;
    // Honor a pending cross-project workspace selection before any fallback.
    if (pending !== undefined && pending.projectId === currentProject?.id) {
      if (worktrees.some(w => w.branch === pending.branch)) {
        pendingWorkspaceRef.current = undefined;
        // Normally already applied by the render-phase switch, in which case
        // confirming it costs nothing but releasing the pins. Re-apply only if
        // something moved the selection since (a superseded jump, the fallback
        // below) so the staged target still wins.
        if (selectedBranch !== pending.branch || urlSessionId !== pending.sessionId) {
          if (pending.sessionId) {
            selectBranchSession(pending.branch, pending.sessionId);
          } else {
            selectWorkspace(pending.branch);
          }
        } else if (pending.sessionId) {
          // Skipping selectBranchSession also skips its MRU touch. The quick
          // switcher records its own (full-row) open, but a notification
          // deep-link has no other path to Recents.
          touchRecentSessionOpen(pending.sessionId);
        }
        // Lift the suspension in the SAME batch the target branch lands: the
        // agent hook's reset effect runs once per (branch, sessionId) change
        // and never re-runs on suspension lift alone, so clearing a render
        // later would permanently skip the target's warm cache preview.
        setBranchNavPending(false);
        // Both pins, unconditionally: skipping the re-apply above also skips
        // selectBranchSession's own clear, and a jump to the ROOT workspace
        // leaves selectedBranch null — so the pin's safety net never fires
        // either, and it would stay stuck forcing the Agent tab.
        setSessionNavPending(false);
        return;
      }
      if (worktreesLoading) return;
      // Target branch isn't in the freshly-loaded project. Release the pins,
      // since no selection will complete for this navigation, and undo the
      // optimistic apply here rather than falling through — the generic
      // fallback below would warn about the same missing branch a second time.
      pendingWorkspaceRef.current = undefined;
      setSessionNavPending(false);
      setBranchNavPending(false);
      toast.warning(`Workspace "${pending.branch ?? 'main'}" no longer exists`);
      selectWorkspace(worktrees[0].branch);
      return;
    }
    if (worktreesLoading) return;
    if (!worktrees.some(w => w.branch === selectedBranch)) {
      // The selected workspace vanished from the authoritative list (deleted
      // worktree, or a jump targeted a branch that's gone). Fall back to the
      // first workspace; a pinned session can't outlive its branch, so say so
      // instead of silently showing a different conversation.
      if (urlSessionId) {
        toast.warning(`Workspace "${selectedBranch ?? 'main'}" no longer exists`);
      }
      selectWorkspace(worktrees[0].branch);
    }
  }, [worktrees, worktreesLoading, worktreesStale, selectedBranch, urlSessionId, currentProject?.id, selectBranchSession, selectWorkspace]);

  // Safety net for the Agent-tab pin. sessionNavPending only exists to bridge
  // the window between a cross-project session jump and its target being
  // confirmed; the explicit clears above cover the happy paths, but
  // a superseding navigation (project/workspace switch, branch-only jump that
  // overwrites pendingWorkspaceRef) or an empty worktree list could otherwise
  // leave the pin stuck, permanently forcing the Agent tab and swallowing manual
  // tab clicks. Tie its lifetime to the invariant instead: once a branch has
  // resolved (non-null), or the target project has no worktrees to resolve
  // against, the pin's job is done. It never fires during the window we need
  // (selectedBranch is null and worktrees are still loading / non-empty then).
  useEffect(() => {
    if (!sessionNavPending && !branchNavPending) return;
    if (selectedBranch !== null || (!worktreesLoading && worktrees.length === 0)) {
      setSessionNavPending(false);
      setBranchNavPending(false);
    }
  }, [sessionNavPending, branchNavPending, selectedBranch, worktreesLoading, worktrees]);

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
          selectWorkspace(branch);
        }
        return;
      }
      const target = projects.find((p) => p.id === projectId);
      if (!target) return;
      // Same cross-project Agent-tab pin as the quick switcher, but only when a
      // specific session is targeted (branch-only jumps keep their persisted
      // tab — they suspend the agent hook via branchNavPending instead).
      if (sessionId) setSessionNavPending(true);
      else setBranchNavPending(true);
      pendingWorkspaceRef.current = { projectId, branch, sessionId };
      selectProject(target);
    },
    [currentProject?.id, projects, selectProject, selectBranchSession, selectWorkspace],
  );

  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Cmd/Ctrl+K opens the quick switcher (same pattern as the sidebar's Cmd+B).
  // Cmd/Ctrl+Shift+O starts a new agent conversation — same as clicking the
  // New Conversation button. Workspace view only; also raises the Agent tab
  // so the action is visible when Diff/Terminal/Executors is in front.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSwitcherOpen((o) => !o);
        return;
      }
      if (
        event.key.toLowerCase() === "o" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        activeView === "workspace"
      ) {
        event.preventDefault();
        setActivateAgentTabNonce((nonce) => nonce + 1);
        void agentRef.current?.startNewConversation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView]);

  // Ignore further switcher selections while one navigation (which may await
  // a mode PATCH) is still in flight — a double-click or Enter+click race
  // would otherwise kick off two navigations.
  const switcherNavigationInFlightRef = useRef(false);

  // Cross-target navigation: agent_mode is the single source of truth for
  // which worker a project talks to — switch it (and wait) before navigating.
  // Uses useProjects' updateProject (the same mechanism as the header's mode
  // dropdown) so the hook's `projects` array and `currentProject` stay in
  // sync with the DB — a raw api call would leave them stale and make the
  // next cross-target check compare against an outdated agent_mode.
  const resolveProjectForTarget = useCallback(async (projectId: string, targetId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    const desiredMode = targetId === "local" ? "local" : targetId;
    if ((project.agent_mode ?? "local") !== desiredMode) {
      return updateProject(project.id, { agentMode: desiredMode });
    }
    return project;
  }, [projects, updateProject]);

  const projectActivityActions = useProjectActivityActions({
    projectId: currentProject?.id ?? null,
    resolveProjectForTarget,
    getScheduleRun: api.getScheduleRun,
    getSchedules: api.getSchedules,
    runScheduleNow: runScheduleNow,
    selectAgentSession: (branch, sessionId) => {
      setActiveView("workspace");
      selectBranchSession(branch, sessionId);
    },
    openScheduleRun: (scheduleId, runId) => {
      setSelectedScheduleId(scheduleId);
      setSelectedScheduleRunId(runId);
      setActiveView("schedules");
    },
    onRerunResult: (result) => {
      if (!result.replay || !result.status || result.status === "starting" || result.status === "running") {
        toast.success("Schedule run started");
      } else if (result.status === "completed") {
        toast.success("Schedule run already completed");
      } else {
        toast.error(`Schedule run already ${result.status}`);
      }
    },
    onError: (kind, error) => {
      console.error(`Project activity ${kind} failed:`, error);
      if (kind === "session-navigation") toast.error("Failed to open agent session");
      else if (kind === "schedule-navigation") toast.error("Failed to open schedule run");
      else toast.error(error instanceof Error ? error.message : "Failed to start schedule run");
    },
  });

  const projectChatContextNavigation = useProjectChatContextNavigation({
    projectId: currentProject?.id ?? null,
    schedules,
    getTask: api.getTask,
    resolveProjectForTarget,
    openTask: setProjectChatContextTask,
    selectAgentSession: (branch, sessionId) => {
      setActiveView("workspace");
      selectBranchSession(branch, sessionId);
    },
    selectWorkspace: (branch) => {
      selectWorkspace(branch);
      setActiveView("workspace");
    },
    selectSchedule: (scheduleId) => {
      setSelectedScheduleId(scheduleId);
      setActiveView("schedules");
    },
    openScheduleRun: projectActivityActions.openScheduleRun,
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Unable to open Context item");
    },
  });

  const openProjectChatThread = useCallback((threadId: string) => {
    setSelectedProjectChatThreadId(threadId);
    selectWorkspace(null);
    setActiveView("project-chat");
  }, [selectWorkspace]);

  const showProjectOverview = useCallback(() => {
    setSelectedProjectChatThreadId(null);
    setActiveView("project-info");
  }, []);

  // Unlike replaceState-driven in-app navigation, browser back/forward changes
  // useUrlState. Restore the selected Project Chat thread (or normal view)
  // without stopping a turn that may still be running on the server.
  useEffect(() => {
    setActiveView(urlTab);
    setSelectedProjectChatThreadId(urlTab === "project-chat" ? urlThreadId : null);
    if (urlTab === "project-chat") {
      selectWorkspace(null);
    }
  }, [urlTab, urlThreadId, selectWorkspace]);

  const handleScheduleRunOpened = useCallback((runId: string) => {
    setSelectedScheduleRunId((current) => current === runId ? null : current);
  }, []);

  const handleSwitcherProject = useCallback((projectId: string) => {
    if (switcherNavigationInFlightRef.current) return;
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setSwitcherOpen(false);
    selectProject(project);
    setActiveView("project-info");
  }, [projects, selectProject]);

  const handleSwitcherWorkspace = useCallback(async (w: SearchResultWorkspace) => {
    if (switcherNavigationInFlightRef.current) return;
    switcherNavigationInFlightRef.current = true;
    setSwitcherOpen(false);
    try {
      const project = await resolveProjectForTarget(w.projectId, w.targetId);
      if (!project) return;
      setActiveView("workspace");
      if (project.id === currentProject?.id) {
        // Same project: the render-phase branch reset only fires on a project
        // *id* change, so setting the branch synchronously is safe.
        selectWorkspace(w.branch);
      } else {
        // Cross-project: selectProject triggers the render-phase selection
        // switch and a worktree refetch — setting the branch synchronously
        // here would be overwritten by it. Stage the target instead (same
        // mechanism as the notification deep-link); the switch applies it in
        // the very render the project changes, and the worktrees-loaded effect
        // validates it. Keep the agent hook suspended across that render
        // anyway: nothing has confirmed the branch exists yet.
        setBranchNavPending(true);
        pendingWorkspaceRef.current = { projectId: project.id, branch: w.branch, sessionId: null };
        selectProject(project);
      }
    } catch (error) {
      console.error("Quick switcher navigation failed:", error);
      toast.error("Failed to open workspace");
    } finally {
      switcherNavigationInFlightRef.current = false;
    }
  }, [currentProject?.id, resolveProjectForTarget, selectProject, selectWorkspace]);

  const handleSwitcherSession = useCallback(async (s: SearchResultSession) => {
    if (switcherNavigationInFlightRef.current) return;
    switcherNavigationInFlightRef.current = true;
    setSwitcherOpen(false);
    try {
      const project = await resolveProjectForTarget(s.projectId, s.targetId);
      if (!project) return;
      // Full-row touch: keeps a copy the MRU merge can surface in Recents even
      // after this session drops out of the server's recency window. The
      // cross-project path never reaches selectBranchSession's id-only touch,
      // so this is also what records the open at all in that case.
      touchRecentSessionOpen(s.sessionId, s);
      setActiveView("workspace");
      if (project.id === currentProject?.id) {
        selectBranchSession(s.branch, s.sessionId);
      } else {
        // Cross-project session jump: stage branch + session so the
        // render-phase selection switch can apply them the moment the target
        // project becomes current, and the worktrees-loaded effect can
        // validate them once its branch list lands.
        // Pin the Agent tab for the whole load window so the new project's
        // persisted tab (e.g. Executors) never shows before the session lands.
        setSessionNavPending(true);
        pendingWorkspaceRef.current = { projectId: project.id, branch: s.branch, sessionId: s.sessionId };
        selectProject(project);
      }
    } catch (error) {
      console.error("Quick switcher navigation failed:", error);
      toast.error("Failed to open session");
    } finally {
      switcherNavigationInFlightRef.current = false;
    }
  }, [currentProject?.id, resolveProjectForTarget, selectProject, selectBranchSession]);

  // Sync state to URL. Pure serialization: `selection` is atomic (every
  // navigation states branch AND sessionId together), so there is no
  // change-detection or ?session=-stripping to do here.
  useEffect(() => {
    if (projectsLoading || routeProjectPending || routeProjectNotFound) return;

    const url = buildUrl({
      projectId: currentProject?.id,
      tab: activeView,
      branch: selectedBranch,
      threadId: selectedProjectChatThreadId,
    });
    if (urlSessionId) {
      const u = new URL(url, window.location.origin);
      u.searchParams.set('session', urlSessionId);
      window.history.replaceState(null, '', u.pathname + u.search);
    } else {
      window.history.replaceState(null, '', url);
    }
  }, [currentProject?.id, activeView, selectedBranch, selectedProjectChatThreadId, projectsLoading, routeProjectPending, routeProjectNotFound, urlSessionId]);

  const handleWorktreeCreated = useCallback((branch: string) => {
    refetchWorktrees();
    selectWorkspace(branch);
  }, [refetchWorktrees, selectWorkspace]);

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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search projects, workspaces, and sessions"
              title="Search (⌘K / Ctrl+K)"
              onClick={() => setSwitcherOpen(true)}
            >
              <Search className="h-4 w-4" />
            </Button>
            <KeyboardShortcutsOverlay />
            <DiscordButton inviteUrl={config?.discordInviteUrl} />
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
            onViewChange={(view) => {
              if (view !== "project-chat") setSelectedProjectChatThreadId(null);
              setActiveView(view);
            }}
            worktrees={worktrees}
            worktreesStale={worktreesStale}
            selectedBranch={selectedBranch}
            onBranchChange={selectWorkspace}
            currentProject={currentProject}
            onCreateWorktreeOpen={() => setCreateWorktreeDialogOpen(true)}
            onDeleteWorktree={(wt) => {
              setWorktreeToDelete(wt);
              setDeleteWorktreeDialogOpen(true);
            }}
            onAnchorRootWorkspace={async (branch) => {
              if (!currentProject) return;
              try {
                await api.anchorRootWorkspace(currentProject.id, branch);
                toast.success(`Main workspace anchored to ${branch}`);
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Failed to anchor workspace");
              }
              refetchWorktrees();
            }}
            onSetRootWorkspaceBranch={async (branch) => {
              if (!currentProject) return;
              try {
                await api.setRootWorkspaceBranch(currentProject.id, branch);
                toast.success(`Main workspace anchored to ${branch}`);
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Failed to change workspace branch");
              }
              refetchWorktrees();
            }}
            mergeStatuses={mergeStatuses}
            mergeRootDirty={mergeRootDirty}
            mergeDefaultTarget={mergeDefaultTarget}
            mergeRepositoryLabel={mergeRepositoryLabel}
            onMergeTargetChange={setMergeTarget}
            onMergeBadgeClick={(branch) => {
              selectWorkspace(branch);
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
            needsProject && (activeView === 'workspace' || activeView === 'tasks' || activeView === 'project-info' || activeView === 'project-chat')
              ? 'flex-1 overflow-hidden'
              : 'hidden'
          }>
            <div className="h-full flex items-center justify-center bg-background">
              <div className="text-center space-y-6">
                <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                  {routeProjectNotFound
                    ? <AlertTriangle className="h-8 w-8 text-destructive" />
                    : <Plus className="h-8 w-8 text-primary" />}
                </div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">
                  {routeProjectNotFound ? "Project not found" : "Welcome to VibeDeckX"}
                </h1>
                <p className="text-muted-foreground max-w-sm mx-auto leading-relaxed" role={routeProjectNotFound ? "alert" : undefined}>
                  {routeProjectNotFound
                    ? "This project does not exist or you do not have access to it."
                    : "Create your first project to get started with AI-powered development."}
                </p>
                {routeProjectNotFound ? (
                  <Button variant="outline" size="lg" onClick={() => {
                    const fallback = projects[0];
                    if (fallback) {
                      selectProject(fallback);
                    }
                    window.history.replaceState(
                      null,
                      "",
                      fallback ? buildUrl({ projectId: fallback.id, tab: "project-info" }) : "/",
                    );
                    window.dispatchEvent(new PopStateEvent("popstate"));
                    setActiveView("project-info");
                    setSelectedProjectChatThreadId(null);
                  }}>
                    Back to projects
                  </Button>
                ) : (
                  <Button variant="accent" size="lg" onClick={() => setCreateDialogOpen(true)} className="shadow-md">
                    <Plus className="h-5 w-5 mr-2" />
                    Create Project
                  </Button>
                )}
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
                    forceAgentTab={sessionNavPending}
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
                        navPending={sessionNavPending || branchNavPending}
                        setSessionUrlParam={setSessionUrlParam}
                        onActiveSessionChange={setRenderedSessionId}
                        project={currentProject}
                        onAgentModeChange={handleAgentModeChange}
                        onTaskCompleted={handleTaskCompleted}
                        onSessionStarted={handleSessionStarted}
                        onSessionTitleUpdated={handleSessionTitleUpdated}
                        onSessionSelected={touchRecentSessionOpen}
                        onStatusChange={handleStatusChange}
                        onNewConversation={handleNewConversation}
                        onOpenSchedule={(scheduleId) => {
                          setSelectedScheduleId(scheduleId);
                          setActiveView("schedules");
                        }}
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
                waitingCount={projectWaitingCount}
                onOpenProjectChatThread={openProjectChatThread}
                onOpenAgentSession={(sessionId, target, branch) => {
                  void projectActivityActions.openAgentSession(sessionId, target, branch);
                }}
                onOpenScheduleRun={(runId, scheduleId) => {
                  void projectActivityActions.openScheduleRun(runId, scheduleId);
                }}
                onRunScheduleAgain={projectActivityActions.runScheduleAgain}
                onViewAllTasks={() => setActiveView("tasks")}
                onProjectUpdated={updateProject}
              />
            </div>
          )}

          {/* Project Chat — project scoped, deliberately independent of branch/workspace. */}
          {activeView === 'project-chat' && !needsProject && currentProject && selectedProjectChatThreadId && (
            <div className="flex-1 overflow-hidden">
              <ProjectChatWorkbench
                projectId={currentProject.id}
                threadId={selectedProjectChatThreadId}
                projectName={currentProject.name}
                onBack={showProjectOverview}
                onSelectThread={openProjectChatThread}
                onOpenContext={(ref) => { void projectChatContextNavigation.open(ref); }}
                onOpenAgentSession={(sessionId, target, branch) => (
                  projectActivityActions.openAgentSession(sessionId, target, branch)
                )}
                onOpenScheduleRun={(runId, scheduleId) => (
                  projectActivityActions.openScheduleRun(runId, scheduleId)
                )}
                onRunScheduleAgain={projectActivityActions.runScheduleAgain}
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
                openRunId={selectedScheduleRunId}
                onOpenRunHandled={handleScheduleRunOpened}
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
        <TaskDetailDialog
          task={projectChatContextTask}
          open={projectChatContextTask !== null}
          onOpenChange={(open) => { if (!open) setProjectChatContextTask(null); }}
        />
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
