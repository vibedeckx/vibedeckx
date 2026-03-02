'use client';

import { type ReactNode, useState } from 'react';
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

export function RightPanel({ projectId, selectedBranch, onMergeRequest, project, onExecutorModeChange, agentSlot }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('agent');

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b h-14">
        <button
          onClick={() => setActiveTab('agent')}
          className={cn(
            'flex items-center gap-2 px-4 border-b-2 transition-colors',
            activeTab === 'agent'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <Bot className="h-4 w-4" />
          Agent
        </button>
        <button
          onClick={() => setActiveTab('executors')}
          className={cn(
            'flex items-center gap-2 px-4 border-b-2 transition-colors',
            activeTab === 'executors'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <Terminal className="h-4 w-4" />
          Executors
        </button>
        <button
          onClick={() => setActiveTab('diff')}
          className={cn(
            'flex items-center gap-2 px-4 border-b-2 transition-colors',
            activeTab === 'diff'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <GitBranch className="h-4 w-4" />
          Diff
        </button>
        <button
          onClick={() => setActiveTab('terminal')}
          className={cn(
            'flex items-center gap-2 px-4 border-b-2 transition-colors',
            activeTab === 'terminal'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <SquareTerminal className="h-4 w-4" />
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
