import { cn } from '@/lib/utils';
import type { DiffLine as DiffLineType } from '@/lib/api';

interface DiffLineProps {
  line: DiffLineType;
}

// Matches the design's `.diff-line` — 36px gutters, subtle 7% tint on the
// code area and 10% on the gutter, with the line number itself colored
// emerald/rose so the side bar reads scannably even on small diffs.
export function DiffLine({ line }: DiffLineProps) {
  const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
  const isAdd = line.type === 'add';
  const isDel = line.type === 'delete';

  const codeBg = isAdd ? 'bg-emerald-500/[0.07]' : isDel ? 'bg-rose-500/[0.07]' : '';
  const gutterBg = isAdd ? 'bg-emerald-500/[0.10]' : isDel ? 'bg-rose-500/[0.10]' : 'bg-secondary';
  const gutterText = isAdd ? 'text-emerald-600' : isDel ? 'text-rose-600' : 'text-muted-foreground/70';

  return (
    <div className="flex font-mono text-[11.5px] leading-[1.55]">
      <span className={cn('w-9 flex-shrink-0 text-right pr-2 select-none border-r border-border/60', gutterBg, gutterText)}>
        {line.oldLineNo ?? ''}
      </span>
      <span className={cn('w-9 flex-shrink-0 text-right pr-2 select-none border-r border-border/60', gutterBg, gutterText)}>
        {line.newLineNo ?? ''}
      </span>
      <span className={cn('w-5 flex-shrink-0 text-center select-none', codeBg, gutterText)}>
        {prefix}
      </span>
      <span className={cn('whitespace-pre-wrap break-all pr-4 flex-1 min-w-0 pl-2', codeBg, (isAdd || isDel) && 'text-foreground')}>
        {line.content}
      </span>
    </div>
  );
}
