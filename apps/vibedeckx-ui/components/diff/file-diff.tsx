'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffLine } from './diff-line';
import { pathLabelParts } from './file-path-label';
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
  const parts = pathLabelParts(file.path, file.status === 'renamed' ? file.oldPath : undefined);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border border-border rounded-lg overflow-hidden">
      {/* Grid, not flex: this sits inside Radix's `display: table` scroll
          viewport, which sizes to its content's MIN-content width — and a
          `truncate` (nowrap) label reports its full text as min-content, so a
          long rename used to stretch every diff block off the right edge with
          no way to scroll back. A `minmax(0,1fr)` track pins that to zero. */}
      <CollapsibleTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2 bg-secondary border-b border-border w-full cursor-pointer hover:bg-muted transition-colors">
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className="font-mono text-[11.5px] flex min-w-0 overflow-hidden text-left text-foreground font-medium"
          title={parts.from !== null ? `${file.oldPath} → ${file.path}` : file.path}
        >
          {parts.dir && (
            // Weighted shrink: the directory gives up all its width before the
            // names give up any, so a row only ever ellipsizes the names when
            // the names alone outrun the row.
            <span className="min-w-0 shrink-[9999] truncate text-muted-foreground font-normal">{parts.dir}/</span>
          )}
          <span className="min-w-0 truncate">
            {parts.from !== null && (
              <>
                <span className="text-muted-foreground font-normal">{parts.from}</span>
                <span className="mx-1.5 text-muted-foreground">→</span>
              </>
            )}
            {parts.to}
            {parts.suffix && (
              <span className="text-muted-foreground font-normal">/{parts.suffix}</span>
            )}
          </span>
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
