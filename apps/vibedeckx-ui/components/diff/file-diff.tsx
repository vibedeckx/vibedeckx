'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffLine } from './diff-line';
import type { FileDiff as FileDiffType } from '@/lib/api';

interface FileDiffProps {
  file: FileDiffType;
  defaultOpen?: boolean;
}

const statusColors = {
  modified: 'bg-yellow-500/20 text-yellow-500',
  added: 'bg-green-500/20 text-green-500',
  deleted: 'bg-red-500/20 text-red-500',
  renamed: 'bg-blue-500/20 text-blue-500',
};

const statusLabels = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

export function FileDiff({ file, defaultOpen = true }: FileDiffProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border border-border rounded-lg overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 px-4 py-2 bg-secondary border-b border-border w-full cursor-pointer hover:bg-muted transition-colors">
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-[11.5px] flex-1 min-w-0 truncate text-left text-foreground font-medium">
          {file.oldPath && file.status === 'renamed' ? (
            <>
              <span className="text-muted-foreground font-normal">{file.oldPath}</span>
              <span className="mx-2 text-muted-foreground">→</span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <Badge variant="secondary" className={statusColors[file.status]}>
          {statusLabels[file.status]}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div>
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex}>
              <div className="px-4 py-0.5 bg-accent text-accent-foreground text-[11px] font-mono font-medium sticky top-0">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLine key={lineIndex} line={line} />
              ))}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
