'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, GitBranch, GitMerge, ChevronsUpDown, Monitor, Cloud } from 'lucide-react';
import { FileDiff } from './file-diff';
import { CommitSelector } from './commit-selector';
import { ExecutionModeToggle, type ExecutionModeTarget } from '@/components/ui/execution-mode-toggle';
import { useProjectRemotes } from '@/hooks/use-project-remotes';
import { useDiff } from '@/hooks/use-diff';
import { useCommits } from '@/hooks/use-commits';
import type { Project } from '@/lib/api';

interface DiffPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
}

export function DiffPanel({ projectId, selectedBranch, onMergeRequest, project }: DiffPanelProps) {
  const [sinceCommit, setSinceCommit] = useState<string | null>(null);
  const { remotes } = useProjectRemotes(project?.id ?? undefined);

  // Build execution mode targets from local path + project remotes
  const diffTargets: ExecutionModeTarget[] = [];
  if (project?.path) diffTargets.push({ id: 'local', label: 'Local', icon: Monitor });
  for (const r of remotes) {
    diffTargets.push({ id: r.remote_server_id, label: r.server_name, icon: Cloud });
  }

  const defaultTarget = project?.path ? 'local' : (remotes.length > 0 ? remotes[0].remote_server_id : 'local');
  const [diffTarget, setDiffTarget] = useState<string>(defaultTarget);
  const [allExpanded, setAllExpanded] = useState(true);
  const [expandKey, setExpandKey] = useState(0);

  // Map diffTarget to 'local' | 'remote' for hooks that still use old API.
  // When the project has no local path, omit target so the backend auto-detects remote.
  const hookTarget: 'local' | 'remote' | undefined =
    diffTarget === 'local' ? (project?.path ? 'local' : undefined) : 'remote';
  const { diff, loading, error, refresh } = useDiff(projectId, selectedBranch, sinceCommit, hookTarget);
  const { commits, loading: commitsLoading, refetch: refetchCommits } = useCommits(projectId, selectedBranch, undefined, hookTarget);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refetchCommits();
  }, [refetchCommits]);

  // Reset sinceCommit when branch changes
  useEffect(() => {
    setSinceCommit(null);
  }, [selectedBranch]);

  // Reset diffTarget when project changes
  useEffect(() => {
    setDiffTarget(defaultTarget);
  }, [projectId, defaultTarget]);

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <GitBranch className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to view changes</p>
        </div>
      </div>
    );
  }

  const fileCount = diff?.files.length ?? 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 h-10">
        <div className="flex items-center gap-4">
          {fileCount > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                {fileCount} file{fileCount !== 1 ? 's' : ''} changed
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAllExpanded(prev => !prev);
                  setExpandKey(prev => prev + 1);
                }}
                title={allExpanded ? 'Collapse all' : 'Expand all'}
              >
                <ChevronsUpDown className="h-4 w-4 mr-1" />
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {diffTargets.length > 1 && (
            <ExecutionModeToggle
              targets={diffTargets}
              activeTarget={diffTarget}
              onTargetChange={setDiffTarget}
              disabled={loading}
            />
          )}
          <span className="text-sm text-muted-foreground whitespace-nowrap">Changes since:</span>
          <CommitSelector
            commits={commits}
            selectedCommit={sinceCommit}
            onSelectCommit={setSinceCommit}
            loading={commitsLoading}
            disabled={loading}
          />
          <Button size="sm" variant="outline" onClick={onMergeRequest} disabled={loading || fileCount === 0}>
            <GitMerge className="h-4 w-4 mr-1" />
            Merge
          </Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 overflow-hidden">
        <div className="p-4 space-y-4">
          {loading && !diff ? (
            <div className="text-center text-muted-foreground py-8">
              Loading changes...
            </div>
          ) : error ? (
            <div className="text-center text-red-400 py-8">
              {error}
            </div>
          ) : fileCount === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              <p>{sinceCommit ? 'No changes since this commit' : 'No changes'}</p>
              {sinceCommit && (
                <p className="text-sm mt-1">Try selecting an earlier commit</p>
              )}
            </div>
          ) : (
            diff?.files.map((file, index) => (
              <FileDiff key={`${index}-${expandKey}`} file={file} defaultOpen={allExpanded} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
