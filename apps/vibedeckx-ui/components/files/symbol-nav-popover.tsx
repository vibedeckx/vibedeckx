"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { api, type SymbolHit } from "@/lib/api";

interface SymbolNavPopoverProps {
  projectId: string;
  symbol: string;
  branch?: string | null;
  target?: "local" | "remote";
  /** The file currently in the preview, used to sort same-file hits first. */
  currentFile: string | null;
  anchor: { x: number; y: number };
  onJump: (file: string, line: number) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 440;
const POPOVER_MAX_HEIGHT = 340;

export function SymbolNavPopover({
  projectId,
  symbol,
  branch,
  target,
  currentFile,
  anchor,
  onJump,
  onClose,
}: SymbolNavPopoverProps) {
  const [loading, setLoading] = useState(true);
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .searchSymbol(projectId, symbol, branch, target)
      .then((r) => {
        if (!alive) return;
        setHits(r.hits);
        setTruncated(r.truncated);
      })
      .catch(() => {
        if (alive) setHits([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, symbol, branch, target]);

  // Dismiss on outside click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Same-file hits first within each group.
  const sameFileFirst = (a: SymbolHit, b: SymbolHit) =>
    Number(b.file === currentFile) - Number(a.file === currentFile);
  const defs = hits.filter((h) => h.kind === "definition").sort(sameFileFirst);
  const refs = hits.filter((h) => h.kind === "reference").sort(sameFileFirst);

  // Clamp into the viewport.
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - POPOVER_WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y + 8, window.innerHeight - POPOVER_MAX_HEIGHT - 8));

  const Row = ({ hit }: { hit: SymbolHit }) => (
    <button
      type="button"
      onClick={() => {
        onJump(hit.file, hit.line);
        onClose();
      }}
      className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent"
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs">
          {hit.file.split("/").pop()}
          <span className="text-muted-foreground">:{hit.line}</span>
        </span>
        {hit.file === currentFile && (
          <span className="shrink-0 text-[10px] text-muted-foreground">this file</span>
        )}
      </span>
      <code className="w-full truncate text-xs text-muted-foreground">{hit.text.trim()}</code>
    </button>
  );

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="mb-1">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );

  return createPortal(
    <div
      ref={ref}
      style={{ left, top, width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="border-b px-3 py-1.5 text-xs font-medium">
        <span className="font-mono">{symbol}</span>
      </div>
      <div className="flex-1 overflow-auto p-1">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Searching…
          </div>
        ) : hits.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No results.</div>
        ) : (
          <>
            {defs.length > 0 && (
              <Section title={`Definitions (${defs.length})`}>
                {defs.map((h, i) => (
                  <Row key={`d-${i}`} hit={h} />
                ))}
              </Section>
            )}
            {refs.length > 0 && (
              <Section title={`References (${refs.length})`}>
                {refs.map((h, i) => (
                  <Row key={`r-${i}`} hit={h} />
                ))}
              </Section>
            )}
            {truncated && (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                Showing first matches — results truncated.
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
