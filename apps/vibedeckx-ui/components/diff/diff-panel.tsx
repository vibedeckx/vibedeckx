'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, GitBranch, GitMerge, ChevronsUpDown, Monitor, Cloud } from 'lucide-react';
import { FileDiff } from './file-diff';
import { CommitSelector } from './commit-selector';
import { ExecutionModeToggle, type ExecutionModeTarget } from '@/components/ui/execution-mode-toggle';
import { useProjectRemotesContext } from '@/hooks/project-remotes-context';
import { useDiff } from '@/hooks/use-diff';
import { useCommits } from '@/hooks/use-commits';
import type { Project } from '@/lib/api';

interface DiffPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
  mergeTarget?: string | null;
  compareRequestNonce?: number;
}

export function DiffPanel({ projectId, selectedBranch, onMergeRequest, project, mergeTarget, compareRequestNonce }: DiffPanelProps) {
  const [selectedCommit, setSinceCommit] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [seenCompareNonce, setSeenCompareNonce] = useState(compareRequestNonce);
  const [seenBranch, setSeenBranch] = useState(selectedBranch);

  // Badge deep-link: a nonce bump means "show the vs-target comparison now".
  // Render-time state adjustment (same pattern as page.tsx branchResetProjectId;
  // the repo's react-hooks/set-state-in-effect rule forbids the effect form).
  // The branch-change reset is deliberately folded in here too, so both
  // triggers are reconciled in ONE pass: a badge deep-link changes branch and
  // nonce in the same commit, and an effect-based branch reset would run after
  // paint and clobber the just-set compare mode.
  const nonceBumped = compareRequestNonce !== undefined && compareRequestNonce !== seenCompareNonce;
  if (nonceBumped) {
    setSeenCompareNonce(compareRequestNonce);
    setCompareMode(true);
    setSinceCommit(null);
  }
  if (selectedBranch !== seenBranch) {
    setSeenBranch(selectedBranch);
    setSinceCommit(null);
    if (!nonceBumped) setCompareMode(false); // plain branch switch resets; deep-link wins
  }

  const { remotes } = useProjectRemotesContext();

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
  const compareTo = compareMode && mergeTarget ? mergeTarget : null;
  const { diff, loading, error, refresh } = useDiff(projectId, selectedBranch, selectedCommit, hookTarget, compareTo);
  const { commits, loading: commitsLoading, refetch: refetchCommits } = useCommits(projectId, selectedBranch, undefined, hookTarget);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refetchCommits();
  }, [refetchCommits]);

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
          <span className="text-sm text-muted-foreground whitespace-nowrap">Commit:</span>
          <CommitSelector
            commits={commits}
            selectedCommit={selectedCommit}
            onSelectCommit={(commit) => {
              setCompareMode(false);
              setSinceCommit(commit);
            }}
            compareTarget={mergeTarget}
            compareSelected={compareMode}
            onSelectCompare={() => {
              setCompareMode(true);
              setSinceCommit(null);
            }}
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
              <p>
                {compareMode && mergeTarget
                  ? `No changes vs ${mergeTarget}`
                  : selectedCommit
                    ? 'No changes in this commit'
                    : 'No uncommitted changes'}
              </p>
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
