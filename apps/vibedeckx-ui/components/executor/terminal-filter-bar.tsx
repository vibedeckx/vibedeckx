"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseFilterInput, type TerminalFilter } from "@/lib/terminal-filter";

interface TerminalFilterBarProps {
  filters: TerminalFilter[];
  /** Whether the text box is showing. Chips render regardless. */
  inputOpen: boolean;
  onAdd: (filter: Omit<TerminalFilter, "id">) => void;
  onRemove: (id: string) => void;
  /** Close the text box (Escape / blur). */
  onCloseInput: () => void;
  /** matched/total logical lines while a filter is active. */
  counts: { matched: number; total: number } | null;
}

// Chips + entry box that live in the terminal's top-right toolbar row. The
// input is uncontrolled: nothing else needs its draft text, and it keeps the
// keyboard handling (Enter/Escape/Backspace-on-empty) trivial. It is an
// <input>, so ExecutorPanel's window keydown handler (←/→ switches target)
// already ignores it via isEditableTarget.
export function TerminalFilterBar({
  filters,
  inputOpen,
  onAdd,
  onRemove,
  onCloseInput,
  counts,
}: TerminalFilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputOpen) inputRef.current?.focus();
  }, [inputOpen]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    // An IME (Chinese/Japanese/Korean) uses Enter to confirm the candidate
    // word; that keystroke belongs to the composition, not to us. keyCode
    // 229 is the legacy signal some browsers send instead of isComposing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = parseFilterInput(el.value);
      if (parsed) {
        onAdd(parsed);
        el.value = "";
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Escape must not leak to the maximize layer or the shell; the
      // terminal gets its focus back through onCloseInput.
      e.stopPropagation();
      onCloseInput();
      return;
    }
    if (e.key === "Backspace" && el.value === "" && filters.length > 0) {
      e.preventDefault();
      onRemove(filters[filters.length - 1].id);
    }
  };

  return (
    <>
      {filters.map((filter) => (
        <span
          key={filter.id}
          data-testid="terminal-filter-chip"
          data-negate={filter.negate || undefined}
          className={cn(
            "flex h-6 max-w-48 items-center gap-1 rounded border pl-1.5 pr-0.5 font-mono text-[11px]",
            "bg-zinc-900/80 backdrop-blur-sm",
            filter.negate
              ? "border-red-500/50 text-red-300"
              : "border-sky-500/50 text-sky-200"
          )}
          title={filter.negate ? `Hide lines containing "${filter.pattern}"` : `Keep lines containing "${filter.pattern}"`}
        >
          {filter.negate && <span className="opacity-70">−</span>}
          <span className="truncate">{filter.pattern}</span>
          <button
            type="button"
            aria-label={`Remove filter ${filter.pattern}`}
            onClick={() => onRemove(filter.id)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {inputOpen && (
        <input
          ref={inputRef}
          type="text"
          aria-label="Add terminal filter"
          placeholder="filter… (-word hides)"
          spellCheck={false}
          autoComplete="off"
          onKeyDown={handleKeyDown}
          className={cn(
            "h-6 w-40 rounded border border-zinc-600 bg-zinc-900/90 px-1.5 font-mono text-[11px]",
            "text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-sky-500/70"
          )}
        />
      )}
      {counts && (
        <span
          data-testid="terminal-filter-count"
          className="select-none font-mono text-[11px] tabular-nums text-zinc-400"
          title="matched / total lines"
        >
          {counts.matched.toLocaleString()} / {counts.total.toLocaleString()}
        </span>
      )}
    </>
  );
}
