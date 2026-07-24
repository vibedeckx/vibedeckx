'use client';

import { Fragment, type ReactNode, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Terminal, GitBranch, SquareTerminal, Bot, Globe, FolderOpen } from 'lucide-react';
import { ExecutorPanel } from '@/components/executor';
import { DiffPanel } from '@/components/diff';
import { TerminalPanel } from '@/components/terminal';
import { PreviewPanel } from '@/components/preview';
import { FilesView } from '@/components/files';
import type { Project, ExecutionMode } from '@/lib/api';
import { FileNavigationProvider } from '@/components/agent/file-navigation-context';
import { useFileRefIndex } from '@/hooks/use-file-ref-index';

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

type TabType = 'agent' | 'executors' | 'diff' | 'terminal' | 'preview' | 'files';

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

  return (
    <FileNavigationProvider value={navValue}>
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex items-center px-3 gap-4 border-b border-border">
        {([
          { id: 'agent' as const, icon: Bot, label: 'Agent' },
          { id: 'executors' as const, icon: Terminal, label: 'Executors' },
          { id: 'diff' as const, icon: GitBranch, label: 'Diff' },
          { id: 'terminal' as const, icon: SquareTerminal, label: 'Terminal' },
          { id: 'preview' as const, icon: Globe, label: 'Browser' },
          { id: 'files' as const, icon: FolderOpen, label: 'Files' },
        ]).map(({ id, icon: Icon, label }) => (
          <Fragment key={id}>
            <button
              onClick={() => setActiveTab(id)}
              className={cn(
                'flex items-center gap-0.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
                displayTab === id
                  ? 'text-foreground border-primary'
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
          {agentSlot}
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", displayTab !== 'executors' && 'hidden')}>
          <ExecutorPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
            onExecutorModeChange={onExecutorModeChange}
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
