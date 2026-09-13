"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, X } from "lucide-react";
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
  // Keep (default) or Hide for the chip being typed. An explicit toggle next
  // to the box, because a `-word` prefix is invisible to anyone who hasn't
  // read the docs. The prefix still works as a shortcut. The mode survives
  // closing the box so a run of "hide this noise" entries needs one click.
  const [hideMode, setHideMode] = useState(false);

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
        // The explicit toggle wins over the prefix shortcut when both say
        // "hide"; in Keep mode the prefix alone can still negate.
        onAdd(hideMode ? { ...parsed, negate: true } : parsed);
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
          {filter.negate && <EyeOff className="h-3 w-3 shrink-0 opacity-80" />}
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
        <span
          data-testid="terminal-filter-input-group"
          className={cn(
            "flex h-6 items-center overflow-hidden rounded border bg-zinc-900/90 backdrop-blur-sm",
            hideMode ? "border-red-500/60" : "border-zinc-600 focus-within:border-sky-500/70"
          )}
        >
          <button
            type="button"
            aria-label={hideMode ? "Hide mode: chip hides matching lines" : "Keep mode: chip keeps matching lines"}
            aria-pressed={hideMode}
            title="Toggle between keeping and hiding lines that match"
            // Keep the caret in the box: switching mode is part of typing the
            // chip, not a separate task.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setHideMode((v) => !v)}
            className={cn(
              "flex h-full shrink-0 items-center gap-1 border-r px-1.5 text-[11px] font-medium",
              hideMode
                ? "border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            )}
          >
            {hideMode ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {hideMode ? "Hide" : "Keep"}
          </button>
          <input
            ref={inputRef}
            type="text"
            aria-label="Add terminal filter"
            placeholder={hideMode ? "hide lines containing…" : "keep lines containing…"}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={handleKeyDown}
            className="h-full w-36 bg-transparent px-1.5 font-mono text-[11px] text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </span>
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
