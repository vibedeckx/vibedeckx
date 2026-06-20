"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { api, type SymbolHit } from "@/lib/api";

// Name shared between the registered highlight and the ::highlight() CSS rule.
const HIGHLIGHT_NAME = "symbol-nav";

// The ::highlight() rule is injected at runtime rather than written in
// globals.css: the build's CSS parser (Lightning CSS) rejects ::highlight() as an
// unknown pseudo-element, but the browser engine that backs the Highlight API
// parses it fine. Inject once, lazily, the first time a highlight is shown.
let highlightStyleInjected = false;
function ensureHighlightStyle() {
  if (highlightStyleInjected || typeof document === "undefined") return;
  highlightStyleInjected = true;
  const style = document.createElement("style");
  // Literal color, not var(--primary)/color-mix: custom properties don't resolve
  // reliably inside ::highlight() (its restricted inheritance), which silently
  // dropped the background and left the highlight invisible. This blue reads as a
  // selection on both light and dark code backgrounds.
  style.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:rgba(101, 160, 255, 0.5);}`;
  document.head.appendChild(style);
}

interface SymbolNavPopoverProps {
  projectId: string;
  symbol: string;
  branch?: string | null;
  target?: "local" | "remote";
  /** The file currently in the preview, used to sort same-file hits first. */
  currentFile: string | null;
  anchor: { x: number; y: number };
  /** The double-clicked word's selection range, re-asserted after mount so the
      word stays selected (and Ctrl-C-copyable) despite the popover clearing it. */
  selectionRange: Range | null;
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
  selectionRange,
  onJump,
  onClose,
}: SymbolNavPopoverProps) {
  const [loading, setLoading] = useState(true);
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [debug, setDebug] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // The native double-click selection gets cleared the moment this popover
  // mounts, so instead of fighting to preserve it we paint our OWN highlight on
  // the word via the CSS Custom Highlight API. It styles a Range without touching
  // the DOM or the native selection, so nothing the popover does can clear it.
  // Ctrl-C is handled separately (the keydown effect below) since there's no
  // native selection to copy from. Falls back to no highlight on old browsers.
  useEffect(() => {
    const hasCSS = typeof CSS !== "undefined";
    const hasReg = hasCSS && "highlights" in CSS;
    const hasCtor = typeof Highlight !== "undefined";
    const rangeText = selectionRange ? selectionRange.toString() : "<null>";
    const collapsed = selectionRange ? selectionRange.collapsed : "n/a";
    setDebug(
      `reg=${hasReg} ctor=${hasCtor} len=${rangeText.length} collapsed=${collapsed} txt="${rangeText.slice(0, 12)}"`
    );

    if (!selectionRange) return;
    if (!hasReg || !hasCtor) return;
    ensureHighlightStyle();
    try {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(selectionRange));
      setDebug((d) => `${d} set=ok size=${CSS.highlights.size}`);
    } catch (err) {
      setDebug((d) => `${d} set=THREW:${(err as Error).message}`);
    }
    return () => {
      CSS.highlights.delete(HIGHLIGHT_NAME);
    };
  }, [selectionRange]);

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
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Ctrl/Cmd+C copies the symbol. Our highlight isn't a native selection, so
      // the browser has nothing to copy on its own — write it ourselves. Defer to
      // a real selection if the user made one (so they can still copy other text).
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
        e.preventDefault();
        void navigator.clipboard?.writeText(symbol);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, symbol]);

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
        {debug && (
          <div className="mt-1 font-mono text-[10px] font-normal text-muted-foreground break-all">
            {debug}
          </div>
        )}
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
