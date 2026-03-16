'use client';

import { type ReactNode, useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Terminal, GitBranch, SquareTerminal, Bot } from 'lucide-react';
import { ExecutorPanel } from '@/components/executor';
import { DiffPanel } from '@/components/diff';
import { TerminalPanel } from '@/components/terminal';
import type { Project, ExecutionMode } from '@/lib/api';

interface RightPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
  onExecutorModeChange?: (mode: ExecutionMode) => void;
  agentSlot?: ReactNode;
}

type TabType = 'agent' | 'executors' | 'diff' | 'terminal';

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
      <div className="flex items-center border-b border-border/60 h-10 px-2 gap-0.5 bg-muted/30">
        <button
          onClick={() => setActiveTab('agent')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
            activeTab === 'agent'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          Agent
        </button>
        <button
          onClick={() => setActiveTab('executors')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
            activeTab === 'executors'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
          )}
        >
          <Terminal className="h-3.5 w-3.5" />
          Executors
        </button>
        <button
          onClick={() => setActiveTab('diff')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
            activeTab === 'diff'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
          )}
        >
          <GitBranch className="h-3.5 w-3.5" />
          Diff
        </button>
        <button
          onClick={() => setActiveTab('terminal')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
            activeTab === 'terminal'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
          )}
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          Terminal
        </button>
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
    </div>
  );
}
