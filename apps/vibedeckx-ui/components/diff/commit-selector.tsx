'use client';

import { GitCommitHorizontal } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CommitEntry } from '@/lib/api';

const HEAD_SENTINEL = '__head__';

interface CommitSelectorProps {
  commits: CommitEntry[];
  selectedCommit: string | null;
  onSelectCommit: (commit: string | null) => void;
  loading?: boolean;
  disabled?: boolean;
}

export function CommitSelector({
  commits,
  selectedCommit,
  onSelectCommit,
  loading,
  disabled,
}: CommitSelectorProps) {
  return (
    <Select
      value={selectedCommit ?? HEAD_SENTINEL}
      onValueChange={(value) => {
        onSelectCommit(value === HEAD_SENTINEL ? null : value);
      }}
      disabled={disabled || loading}
    >
      <SelectTrigger size="sm" className="w-[200px]">
        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
        <SelectValue placeholder="Select commit..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={HEAD_SENTINEL}>HEAD (uncommitted)</SelectItem>
        {commits.map((commit) => (
          <SelectItem key={commit.hash} value={commit.hash}>
            <span className="font-mono text-xs">{commit.shortHash}</span>{' '}
            <span className="truncate">{commit.message.length > 40 ? commit.message.slice(0, 40) + '...' : commit.message}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
