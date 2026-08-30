'use client';

import { Fragment, type ReactNode, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { Terminal, GitBranch, SquareTerminal, Bot, Globe, FolderOpen } from 'lucide-react';
import { ExecutorPanel } from '@/components/executor';
import { DiffPanel } from '@/components/diff';
import { TerminalPanel } from '@/components/terminal';
import { PreviewPanel } from '@/components/preview';
import { FilesView } from '@/components/files';
import type { Project, ExecutionMode } from '@/lib/api';
import { FileNavigationProvider } from '@/components/agent/file-navigation-context';
import { matchTabShortcut, isMacPlatform, tabShortcutHint, TAB_SHORTCUTS, type TabShortcutTarget } from '@/lib/tab-shortcuts';
import { useFileRefIndex } from '@/hooks/use-file-ref-index';
import { AgentTabFocusProvider } from '@/hooks/agent-tab-focus-context';
import { useFocusRegion } from '@/components/locate/focus-region';

interface RightPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
  onExecutorModeChange?: (mode: ExecutionMode) => void;
  agentSlot?: ReactNode;
  activateAgentTabNonce?: number;
  diffCompareNonce?: number;
  mergeTarget?: string | null;
  // True while a session-targeted navigation is still resolving (notably a
  // cross-project jump, where the project switches and worktrees reload before
  // the branch/session — and the activateAgentTabNonce bump — land). During
  // that window selectedBranch is null and the panel would otherwise show the
  // new project's persisted tab (often Executors) until the deferred selection
  // completes. Forcing Agent here keeps that intermediate tab from showing.
  forceAgentTab?: boolean;
  // Whether the workspace view is currently shown. The panel stays mounted
  // (hidden via CSS) on other views, so this gates the file-ref index load.
  active?: boolean;
}

type TabType = TabShortcutTarget;

// Ids/labels/keys come from the shared registry (lib/tab-shortcuts.ts, which
// also documents the shortcut design rationale); only the icons are local.
const TAB_ICONS: Record<TabType, typeof Bot> = {
  agent: Bot,
  executors: Terminal,
  diff: GitBranch,
  terminal: SquareTerminal,
  preview: Globe,
  files: FolderOpen,
};

const TABS = TAB_SHORTCUTS.map((t) => ({ ...t, icon: TAB_ICONS[t.id] }));

const noopSubscribe = () => () => {};

// Tab reconciliation must run before the browser paints, otherwise navigating
// to a session (which bumps activateAgentTabNonce) paints the persisted tab
// (e.g. Executors) for one frame before the effect switches to Agent, causing a
// visible flash. useLayoutEffect runs after DOM mutation but before paint; fall
// back to useEffect on the server (static export) to avoid the SSR warning.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function usePersistedTab(projectId: string | null, branch: string | null | undefined): [TabType, (tab: TabType) => void] {
  const key = `vibedeckx:activeTab:${projectId ?? 'none'}:${branch ?? 'main'}`;
  const [activeTab, setActiveTabState] = useState<TabType>(() => {
    if (typeof window === 'undefined') return 'agent';
    return (localStorage.getItem(key) as TabType) ?? 'agent';
  });

  useIsomorphicLayoutEffect(() => {
    const saved = localStorage.getItem(key) as TabType | null;
    setActiveTabState(saved ?? 'agent');
  }, [key]);

  const setActiveTab = useCallback((tab: TabType) => {
    setActiveTabState(tab);
    localStorage.setItem(key, tab);
  }, [key]);

  return [activeTab, setActiveTab];
}

export function RightPanel({
  projectId,
  selectedBranch,
  onMergeRequest,
  project,
  onExecutorModeChange,
  agentSlot,
  activateAgentTabNonce,
  diffCompareNonce,
  mergeTarget,
  forceAgentTab = false,
  active = true,
}: RightPanelProps) {
  const [activeTab, setActiveTab] = usePersistedTab(projectId, selectedBranch);
  // What the UI actually renders. While a session navigation is still resolving
  // we pin Agent, masking the transient persisted tab (e.g. Executors) that the
  // internal activeTab state briefly holds before the branch/nonce land.
  const displayTab: TabType = forceAgentTab ? 'agent' : activeTab;
  const prevActivateAgentTabNonceRef = useRef(activateAgentTabNonce);

  useIsomorphicLayoutEffect(() => {
    if (activateAgentTabNonce === undefined) return;
    if (prevActivateAgentTabNonceRef.current === activateAgentTabNonce) return;
    prevActivateAgentTabNonceRef.current = activateAgentTabNonce;
    setActiveTab('agent');
  }, [activateAgentTabNonce, setActiveTab]);

  const prevDiffCompareNonceRef = useRef(diffCompareNonce);
  useIsomorphicLayoutEffect(() => {
    if (diffCompareNonce === undefined) return;
    if (prevDiffCompareNonceRef.current === diffCompareNonce) return;
    prevDiffCompareNonceRef.current = diffCompareNonce;
    setActiveTab('diff');
  }, [diffCompareNonce, setActiveTab]);

  // Asking for the Agent tab is an event, not a state: `displayTab === 'agent'`
  // is already true when you press the shortcut from the sidebar or after
  // clicking into the transcript, so the composer's activation effect would
  // never re-run. Bumping this on every explicit request (shortcut or tab
  // click) gives it something to fire on. Deliberately NOT bumped by
  // activateAgentTabNonce: when that arrives from another tab it already flips
  // `active` and focuses (a tab switch to Agent, same as any other), but when
  // Agent is already open it's a sidebar/cross-project jump landing on a new
  // session — grabbing focus there would feel like a steal.
  const [agentFocusNonce, setAgentFocusNonce] = useState(0);
  const requestAgentFocus = useCallback(() => setAgentFocusNonce((n) => n + 1), []);

  // Executors has panel-level keyboard commands (notably ←/→ for target
  // switching) but no natural text/control focus target like Agent or Terminal.
  // An explicit tab click/shortcut therefore moves DOM focus off the tab button
  // and onto the stable panel wrapper. The pending flag makes this an event, not
  // a consequence of displayTab changing: persisted/programmatic tab changes
  // must not steal focus during navigation or initial mount.
  const executorPanelRef = useRef<HTMLDivElement>(null);
  const pendingExecutorFocusRef = useRef(false);
  const [executorFocusNonce, setExecutorFocusNonce] = useState(0);
  const requestExecutorFocus = useCallback(() => {
    pendingExecutorFocusRef.current = true;
    setExecutorFocusNonce((n) => n + 1);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!pendingExecutorFocusRef.current) return;
    pendingExecutorFocusRef.current = false;
    if (!active || projectId === null || displayTab !== 'executors') return;
    executorPanelRef.current?.focus({ preventScroll: true });
  }, [active, displayTab, executorFocusNonce, projectId]);

  // Keyboard focus region: pointerdown/focusin inside the panel claims it
  // (via the data-focus-region attribute below), an idle Esc releases it.
  // While claimed, type-to-locate targets this panel's tab instead of the
  // sidebar workspace list, and the active tab's underline keeps its accent
  // color — the "typing lands here" signal.
  const { region, setRegion } = useFocusRegion();
  const regionFocused = region === 'right-panel';

  // Tab shortcuts (see lib/tab-shortcuts.ts). Deliberately active even while
  // an input/textarea is focused — the modifier pairs don't produce text, and
  // jumping to a tab mid-typing is the point. The panel stays mounted on
  // other views, so `active` gates the listener. Jumping to a tab by shortcut
  // also claims the focus region — it's the keyboard way in, mirroring Esc out.
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const tab = matchTabShortcut(event);
      if (!tab) return;
      event.preventDefault();
      setActiveTab(tab);
      setRegion('right-panel');
      if (tab === 'agent') requestAgentFocus();
      if (tab === 'executors') requestExecutorFocus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, setActiveTab, setRegion, requestAgentFocus, requestExecutorFocus]);

  // The server snapshot (static-export prerender, no `navigator`) is false;
  // useSyncExternalStore re-reads on the client so hydration stays clean.
  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);

  const target = project && !project.path ? ("remote" as const) : undefined;
  const index = useFileRefIndex({ projectId, branch: selectedBranch, target, enabled: active });

  const navNonce = useRef(0);
  const [navRequest, setNavRequest] = useState<
    { path: string; line: number | null; nonce: number } | null
  >(null);

  const openFile = useCallback(
    (path: string, line: number | null = null) => {
      setActiveTab("files");
      setNavRequest({ path, line, nonce: ++navNonce.current });
    },
    [setActiveTab],
  );

  const navValue = useMemo(() => ({ openFile, index }), [openFile, index]);

  const agentTabFocus = useMemo(
    () => ({
      // Gated on projectId too: page.tsx keeps this panel mounted but
      // display:none until a project resolves (its `needsProject`), and passes
      // projectId=null over exactly that window. Without the gate the flag
      // would turn true during the cold-load render, focus would no-op against
      // a display:none textarea, and nothing would fire again once the project
      // landed.
      active: active && projectId !== null && displayTab === 'agent',
      requestNonce: agentFocusNonce,
    }),
    [active, projectId, displayTab, agentFocusNonce],
  );

  return (
    <FileNavigationProvider value={navValue}>
    <div data-focus-region="right-panel" className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex items-center px-3 gap-4 border-b border-border">
        {TABS.map(({ id, icon: Icon, label, code }) => (
          <Fragment key={id}>
            <button
              onClick={() => {
                setActiveTab(id);
                if (id === 'agent') requestAgentFocus();
                if (id === 'executors') requestExecutorFocus();
              }}
              title={`${label} (${tabShortcutHint(isMac, code)})`}
              className={cn(
                'flex items-center gap-0.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
                // Two-level selection: which tab is open (always visible) vs
                // whether the panel holds the keyboard focus region — the
                // accent underline is reserved for the latter.
                displayTab === id
                  ? cn('text-foreground', regionFocused ? 'border-primary' : 'border-foreground/25')
                  : 'text-muted-foreground border-transparent hover:text-foreground/70'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
            {id === 'agent' && <span className="h-4 w-px bg-border/60 mx-1.5" aria-hidden />}
          </Fragment>
        ))}
      </div>

      {/* Tab Content — panels share a relative wrapper so each fills the same
          box. Inactive panels are display:none, except the Agent panel which
          stays laid out (visibility:hidden, out of flow) so its scroll position
          is preserved across tab switches. Using `hidden` on the agent panel
          collapses its scroll container to 0 height, which makes
          use-stick-to-bottom think it's at the bottom and snap there on return. */}
      <div className="relative flex-1 overflow-hidden">
        <div
          className={cn(
            "absolute inset-0 overflow-hidden",
            displayTab !== 'agent' && 'invisible pointer-events-none'
          )}
        >
          {/* visibility:hidden also blurs the composer on the way out, so the
              agent panel needs to be told when it comes back — same contract as
              the terminal's `active` prop below, delivered by context because
              agentSlot is created in page.tsx but rendered here. */}
          <AgentTabFocusProvider value={agentTabFocus}>
            {agentSlot}
          </AgentTabFocusProvider>
        </div>
        <div
          ref={executorPanelRef}
          tabIndex={-1}
          className={cn(
            "absolute inset-0 overflow-hidden outline-hidden",
            displayTab !== 'executors' && 'hidden',
          )}
        >
          <ExecutorPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
            onExecutorModeChange={onExecutorModeChange}
            locateActive={active && displayTab === 'executors'}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", displayTab !== 'diff' && 'hidden')}>
          <DiffPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            onMergeRequest={onMergeRequest}
            project={project}
            mergeTarget={mergeTarget}
            compareRequestNonce={diffCompareNonce}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", displayTab !== 'terminal' && 'hidden')}>
          <TerminalPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
            active={active && displayTab === 'terminal'}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", displayTab !== 'preview' && 'hidden')}>
          <PreviewPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", displayTab !== 'files' && 'hidden')}>
          <FilesView
            projectId={projectId}
            project={project}
            selectedBranch={selectedBranch}
            navRequest={navRequest}
          />
        </div>
      </div>
    </div>
    </FileNavigationProvider>
  );
}
