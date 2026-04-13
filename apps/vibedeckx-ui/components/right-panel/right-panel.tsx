'use client';

import { type ReactNode, useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Terminal, GitBranch, SquareTerminal, Bot, Globe } from 'lucide-react';
import { ExecutorPanel } from '@/components/executor';
import { DiffPanel } from '@/components/diff';
import { TerminalPanel } from '@/components/terminal';
import { PreviewPanel } from '@/components/preview';
import type { Project, ExecutionMode } from '@/lib/api';

interface RightPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
  onExecutorModeChange?: (mode: ExecutionMode) => void;
  agentSlot?: ReactNode;
}

type TabType = 'agent' | 'executors' | 'diff' | 'terminal' | 'preview';

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

export function RightPanel({ projectId, selectedBranch, onMergeRequest, project, onExecutorModeChange, agentSlot }: RightPanelProps) {
  const [activeTab, setActiveTab] = usePersistedTab(projectId, selectedBranch);

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex items-center px-3 gap-4 border-b border-border/60">
        {([
          { id: 'agent' as const, icon: Bot, label: 'Agent' },
          { id: 'executors' as const, icon: Terminal, label: 'Executors' },
          { id: 'diff' as const, icon: GitBranch, label: 'Diff' },
          { id: 'terminal' as const, icon: SquareTerminal, label: 'Terminal' },
          { id: 'preview' as const, icon: Globe, label: 'Preview' },
        ]).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-0.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
              activeTab === id
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground/70'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content — CSS show/hide to keep all panels mounted */}
      <div className={cn("flex-1 overflow-hidden", activeTab !== 'agent' && 'hidden')}>
        {agentSlot}
      </div>
      <div className={cn("flex-1 overflow-hidden", activeTab !== 'executors' && 'hidden')}>
        <ExecutorPanel
          projectId={projectId}
          selectedBranch={selectedBranch}
          project={project}
          onExecutorModeChange={onExecutorModeChange}
        />
      </div>
      <div className={cn("flex-1 overflow-hidden", activeTab !== 'diff' && 'hidden')}>
        <DiffPanel
          projectId={projectId}
          selectedBranch={selectedBranch}
          onMergeRequest={onMergeRequest}
          project={project}
        />
      </div>
      <div className={cn("flex-1 overflow-hidden", activeTab !== 'terminal' && 'hidden')}>
        <TerminalPanel
          projectId={projectId}
          selectedBranch={selectedBranch}
          project={project}
        />
      </div>
      <div className={cn("flex-1 overflow-hidden", activeTab !== 'preview' && 'hidden')}>
        <PreviewPanel
          projectId={projectId}
          selectedBranch={selectedBranch}
          project={project}
        />
      </div>
    </div>
  );
}
