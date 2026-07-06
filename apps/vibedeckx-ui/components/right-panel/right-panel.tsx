'use client';

import { type ReactNode, useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  // Whether the workspace view is currently shown. The panel stays mounted
  // (hidden via CSS) on other views, so this gates the file-ref index load.
  active?: boolean;
}

type TabType = 'agent' | 'executors' | 'diff' | 'terminal' | 'preview' | 'files';

function usePersistedTab(projectId: string | null, branch: string | null | undefined): [TabType, (tab: TabType) => void] {
  const key = `vibedeckx:activeTab:${projectId ?? 'none'}:${branch ?? 'main'}`;
  const [activeTab, setActiveTabState] = useState<TabType>(() => {
    if (typeof window === 'undefined') return 'agent';
    return (localStorage.getItem(key) as TabType) ?? 'agent';
  });

  useEffect(() => {
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
  active = true,
}: RightPanelProps) {
  const [activeTab, setActiveTab] = usePersistedTab(projectId, selectedBranch);
  const prevActivateAgentTabNonceRef = useRef(activateAgentTabNonce);

  useEffect(() => {
    if (activateAgentTabNonce === undefined) return;
    if (prevActivateAgentTabNonceRef.current === activateAgentTabNonce) return;
    prevActivateAgentTabNonceRef.current = activateAgentTabNonce;
    setActiveTab('agent');
  }, [activateAgentTabNonce, setActiveTab]);

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
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-0.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
              activeTab === id
                ? 'text-foreground border-primary'
                : 'text-muted-foreground border-transparent hover:text-foreground/70'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
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
            activeTab !== 'agent' && 'invisible pointer-events-none'
          )}
        >
          {agentSlot}
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", activeTab !== 'executors' && 'hidden')}>
          <ExecutorPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
            onExecutorModeChange={onExecutorModeChange}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", activeTab !== 'diff' && 'hidden')}>
          <DiffPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            onMergeRequest={onMergeRequest}
            project={project}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", activeTab !== 'terminal' && 'hidden')}>
          <TerminalPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", activeTab !== 'preview' && 'hidden')}>
          <PreviewPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
          />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", activeTab !== 'files' && 'hidden')}>
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
