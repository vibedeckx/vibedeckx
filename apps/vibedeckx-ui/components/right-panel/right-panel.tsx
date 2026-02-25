'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Terminal, GitBranch, SquareTerminal } from 'lucide-react';
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
}

type TabType = 'executors' | 'diff' | 'terminal';

export function RightPanel({ projectId, selectedBranch, onMergeRequest, project, onExecutorModeChange }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('executors');

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b h-14">
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

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'executors' ? (
          <ExecutorPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
            onExecutorModeChange={onExecutorModeChange}
          />
        ) : activeTab === 'diff' ? (
          <DiffPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            onMergeRequest={onMergeRequest}
            project={project}
          />
        ) : (
          <TerminalPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            project={project}
          />
        )}
      </div>
    </div>
  );
}
