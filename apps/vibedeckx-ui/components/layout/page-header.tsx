import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  count?: number | string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

// Design's `.page-head` — 14/20/12 padding, 17px h1 with -0.018em tracking,
// optional mono count chip beside the title, right-aligned actions.
export function PageHeader({ title, count, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-5 pt-[14px] pb-3 border-b border-border bg-background flex-shrink-0",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="flex items-baseline gap-2.5 m-0 text-[17px] font-semibold tracking-[-0.018em] text-foreground">
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="font-mono text-[11.5px] font-medium text-muted-foreground/80 tracking-normal">
              {count}
            </span>
          )}
        </h1>
        {description && (
          <p className="text-[11.5px] text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

interface FilterBarProps {
  children: React.ReactNode;
  className?: string;
}

// Design's `.filterbar` — sits below page-head, horizontal scroll, hidden scrollbar.
export function FilterBar({ children, className }: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-5 py-2 border-b border-border bg-background flex-shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface FilterChipProps {
  active?: boolean;
  count?: number | string;
  onClick?: () => void;
  children: React.ReactNode;
}

// Design's `.chip` — 999px pill, hairline border + shadow-sm on active.
export function FilterChip({ active, count, onClick, children }: FilterChipProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11.5px] font-normal transition-colors whitespace-nowrap flex-shrink-0 border",
        active
          ? "bg-card text-foreground font-medium border-border shadow-[0_1px_2px_oklch(0.2_0.02_260/0.04),0_0_0_1px_oklch(0.2_0.02_260/0.04)]"
          : "bg-transparent text-muted-foreground border-transparent hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined && (
        <span
          className={cn(
            "font-mono text-[10.5px] pl-0.5",
            active ? "text-muted-foreground" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function FilterSep() {
  return <span className="w-px h-[18px] bg-border mx-1.5 flex-shrink-0" />;
}
