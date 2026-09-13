"use client";

import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface TerminalFilterViewProps {
  lines: string[];
  fontSize: number;
  fontFamily: string;
  /** PTY windows show a hint that typing is paused while filtered. */
  isPty: boolean;
  className?: string;
}

// Read-only rendering of the filtered buffer lines, laid over the live xterm.
// Plain text on purpose: colours would need per-line ANSI re-serialisation
// and a second xterm instance for little gain on log-style output. A single
// <pre> is fine up to the 100k-row scrollback cap; virtualise only if that
// ever grows.
export function TerminalFilterView({
  lines,
  fontSize,
  fontFamily,
  isPty,
  className,
}: TerminalFilterViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Follow the tail like the terminal does, unless the user scrolled up to
  // read something — then hold position as new matches arrive.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };

  return (
    <div
      data-testid="terminal-filter-view"
      className={cn("absolute inset-0 flex flex-col bg-zinc-950", className)}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // Room at the top for the toolbar row (chips, input, buttons) that
        // floats over the terminal.
        className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-9"
      >
        {lines.length === 0 ? (
          <div className="select-none py-4 text-center text-xs text-zinc-500">No lines match</div>
        ) : (
          <pre
            className="m-0 whitespace-pre text-zinc-100"
            style={{ fontSize, fontFamily, lineHeight: 1.2 }}
          >
            {lines.map((line, i) => (
              // Index keys are fine: rows are positional text with no state.
              <div key={i}>{line === "" ? " " : line}</div>
            ))}
          </pre>
        )}
      </div>
      {isPty && (
        <div className="select-none border-t border-zinc-800 px-2 py-1 text-[11px] text-zinc-500">
          Filtered view — clear filters to type into the shell
        </div>
      )}
    </div>
  );
}
