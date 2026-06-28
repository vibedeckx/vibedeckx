"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
} from "react";
import {
  Download,
  FileWarning,
  Copy,
  Code,
  Eye,
  ListCollapse,
  ListTree,
} from "lucide-react";
import rehypeSlug from "rehype-slug";
import { defaultRehypePlugins } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockCopyButton,
  type CodeBlockHandle,
} from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, type FileContentResponse } from "@/lib/api";
import type { BundledLanguage } from "shiki";
import { SymbolNavPopover } from "./symbol-nav-popover";
import { ImagePreview } from "./image-preview";
import {
  classifyColumn,
  tokenizeFile,
  type SymbolTokenIndex,
} from "@/lib/files/symbol-tokens";

// Raster image extensions previewed inline (when the backend flags the file
// binary). Larger than this cap, the bytes aren't fetched — a download card is
// shown instead, so big assets don't get pulled silently into memory.
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);
const IMAGE_PREVIEW_MAX_SIZE = 10 * 1024 * 1024;

function isImage(filePath: string): boolean {
  const ext = filePath.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

// A double-clicked selection is treated as a symbol only if it's a bare identifier.
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Custom "selection" highlight for a double-clicked symbol, via the CSS Custom
// Highlight API. The highlight stands in for the native selection (which opening
// the popover clears). It is (re)built from the click coordinates AFTER the
// popover mounts — never from a captured node/range, because the code's text
// nodes get replaced on re-render, so any captured node ends up detached.
const SYMBOL_HL = "symbol-nav";

// A stable, DOM-node-free anchor for the highlight: which code line (by the
// `data-line` attribute the CodeBlock stamps on every line) and the character
// span within it. Captured from the live selection in the double-click handler,
// then re-resolved against the live DOM after the popover mounts — so it survives
// both the selection being cleared and the code's text nodes being replaced.
interface LineColAnchor {
  line: string;
  start: number;
  end: number;
}

// Character offset of (container, offset) from the start of `root`'s text. Using
// a Range handles text- and element-typed containers uniformly.
function charOffsetWithin(root: Element, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(container, offset);
  return r.toString().length;
}

function anchorFromRange(range: Range): LineColAnchor | null {
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const lineEl = startEl?.closest("[data-line]");
  if (!lineEl || !lineEl.contains(range.endContainer)) return null;
  const line = lineEl.getAttribute("data-line");
  if (line === null) return null;
  const start = charOffsetWithin(lineEl, range.startContainer, range.startOffset);
  const end = charOffsetWithin(lineEl, range.endContainer, range.endOffset);
  if (start >= end) return null;
  return { line, start, end };
}

// Locate the text node + offset for a character position within `root`.
function charToPoint(root: Element, target: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const len = (n.textContent ?? "").length;
    if (target <= total + len) return { node: n, offset: target - total };
    total += len;
  }
  return null;
}

function rangeFromAnchor(anchor: LineColAnchor): Range | null {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-line="${CSS.escape(anchor.line)}"]`)
  );
  // CodeBlock renders two copies (light/dark); resolve against the visible one.
  const lineEl = els.find((el) => el.offsetParent !== null) ?? els[0];
  if (!lineEl) return null;
  const startPt = charToPoint(lineEl, anchor.start);
  const endPt = charToPoint(lineEl, anchor.end);
  if (!startPt || !endPt) return null;
  const range = document.createRange();
  range.setStart(startPt.node, startPt.offset);
  range.setEnd(endPt.node, endPt.offset);
  return range;
}

const WORD_CHAR = /[A-Za-z0-9_$]/;

// Find the identifier under a viewport point (used for single-click, which has no
// native selection to read). Returns the word + its stable line+col anchor.
// When a token index is supplied, words that aren't real symbols (inside a
// comment/string, or a language keyword) are rejected so the popover only opens
// on something worth a definition/reference lookup.
function wordFromPoint(
  x: number,
  y: number,
  index?: SymbolTokenIndex | null
): { word: string; anchor: LineColAnchor } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  if (start >= end) return null;
  const word = text.slice(start, end);
  if (!SYMBOL_RE.test(word)) return null;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const anchor = anchorFromRange(range);
  if (!anchor) return null;
  // Reject non-symbols when we have a token index. The line element carries a
  // synthetic line-number prefix (the bare number CodeBlock stamps via its
  // line-number transformer), so the source column is the in-line character
  // offset minus that prefix's length. A null classification (line/col not
  // covered, or index not built yet) leaves the click allowed.
  if (index) {
    const sourceCol = anchor.start - anchor.line.length;
    const kind = classifyColumn(index, Number(anchor.line), sourceCol);
    if (kind && kind !== "code") return null;
  }
  return { word, anchor };
}

function highlightApiAvailable(): boolean {
  return (
    typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
  );
}

// The ::highlight() rule is injected at runtime, not in globals.css: the build's
// Lightning CSS rejects ::highlight() as an unknown pseudo-element, while the
// browser engine backing the Highlight API parses it fine. A literal color is
// used because var(--primary)/color-mix don't resolve inside ::highlight().
let symbolHlStyleInjected = false;
function ensureSymbolHlStyle() {
  if (symbolHlStyleInjected || typeof document === "undefined") return;
  symbolHlStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `::highlight(${SYMBOL_HL}){background-color:rgba(255, 196, 0, 0.32);}`;
  document.head.appendChild(style);
}

function clearSymbolHighlight() {
  if (highlightApiAvailable()) CSS.highlights.delete(SYMBOL_HL);
}

const EXTENSION_LANGUAGE_MAP: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  json: "json",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  md: "markdown",
  mdx: "mdx",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  r: "r",
  scala: "scala",
  zig: "zig",
};

function getLanguage(filePath: string): BundledLanguage {
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";

  // Handle special filenames
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "makefile") return "makefile";

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGE_MAP[ext] ?? "text";
}

function isMarkdown(filePath: string): boolean {
  const lang = getLanguage(filePath);
  return lang === "markdown" || lang === "mdx";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FilePreviewProps {
  filePath: string | null;
  fileContent: FileContentResponse | null;
  loading: boolean;
  downloadUrl: string | null;
  projectId: string;
  branch?: string | null;
  target?: "local" | "remote";
  scrollToLine?: number | null;
  scrollKey?: number;
  onJump: (file: string, line: number) => void;
}

export function FilePreview({
  filePath,
  fileContent,
  loading,
  downloadUrl,
  projectId,
  branch,
  target,
  scrollToLine,
  scrollKey,
  onJump,
}: FilePreviewProps) {
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  const [symbolNav, setSymbolNav] = useState<{
    symbol: string;
    x: number;
    y: number;
    anchor: LineColAnchor | null;
    // true when triggered by a double-click — the effect re-asserts a real native
    // selection over the word instead of the custom amber highlight.
    selectWord: boolean;
  } | null>(null);

  // Per-file token scopes, built off-thread by Shiki, used to gate clicks to
  // real symbols. Held in a ref so the click handler reads the latest index
  // without being recreated. Null until built (and on build failure) — in which
  // case every identifier stays clickable, the prior behavior.
  const tokenIndexRef = useRef<SymbolTokenIndex | null>(null);
  const codeBlockRef = useRef<CodeBlockHandle>(null);

  // Mirror the popover-open state into a ref so the click handler can read it
  // synchronously (its deps are empty). React flushes this effect before the next
  // discrete click, so it reflects the committed state by the time a click fires.
  const symbolNavOpenRef = useRef(false);
  useEffect(() => {
    symbolNavOpenRef.current = symbolNav !== null;
  }, [symbolNav]);

  // Single + double click are distinguished by MouseEvent.detail (no timer):
  //   detail 1 (single click) → custom amber highlight + popover
  //   detail 2 (double click) → real native selection + popover (no amber)
  // Both find the word from the click point (single-click has no native selection
  // to read). A drag-select (non-collapsed selection on a plain click) is ignored.
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.detail >= 2) {
      const sel = window.getSelection();
      if (symbolNavOpenRef.current) {
        // A symbol: upgrade the open popover to a real native selection. Reuse the
        // FIRST click's stored anchor (the effect lays it down) — the popover may
        // cover the point, so re-detecting from coordinates could hit it.
        sel?.removeAllRanges();
        setSymbolNav((prev) => (prev ? { ...prev, selectWord: true } : prev));
        return;
      }
      // A non-symbol (keyword/string/comment): no popover opened. The native
      // double-click selection was suppressed on mousedown (handleMouseDown), so
      // nothing is selected yet — establish a tight word-only range here.
      // wordFromPoint without the token index skips the symbol gate but still trims
      // to a bare identifier.
      const found = wordFromPoint(e.clientX, e.clientY);
      const range = found ? rangeFromAnchor(found.anchor) : null;
      if (range) {
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }
    const existing = window.getSelection();
    if (existing && !existing.isCollapsed) return; // drag-select
    const found = wordFromPoint(e.clientX, e.clientY, tokenIndexRef.current);
    if (!found) return;
    // Kill the native (blue) selection now so it can't flash before the highlight.
    existing?.removeAllRanges();
    setSymbolNav({
      symbol: found.word,
      x: e.clientX,
      y: e.clientY,
      anchor: found.anchor,
      selectWord: false,
    });
  }, []);

  // Suppress the browser's native double-click word selection at its source. The
  // selection is made on the second mousedown and painted while the button is
  // held — and in this white-space:pre block it greedily includes the trailing
  // whitespace (Shiki emits it as a leading space on the next token), so it would
  // visibly flash a too-wide selection before the click handler could correct it.
  // preventDefault here stops it; handleClick then lays down a tight word range.
  // Only for the second click (detail 2) — single clicks/drags select normally.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.detail >= 2) e.preventDefault();
  }, []);

  // Apply the symbol affordance after the popover mounts (the re-render swaps the
  // code's text nodes, so we re-resolve the anchor against the live DOM here).
  // single-click → custom amber highlight; double-click → native selection.
  useEffect(() => {
    if (!symbolNav?.anchor) {
      clearSymbolHighlight();
      return;
    }
    const range = rangeFromAnchor(symbolNav.anchor);
    if (!range) {
      clearSymbolHighlight();
      return;
    }
    if (symbolNav.selectWord) {
      clearSymbolHighlight();
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    if (!highlightApiAvailable()) {
      clearSymbolHighlight();
      return;
    }
    ensureSymbolHlStyle();
    CSS.highlights.set(SYMBOL_HL, new Highlight(range));
    return clearSymbolHighlight;
  }, [symbolNav]);

  // Build the token scope index for the open file (source preview only). Clears
  // immediately on file change so a stale index can't gate the next file, then
  // fills in asynchronously once Shiki tokenizes.
  useEffect(() => {
    tokenIndexRef.current = null;
    const content = fileContent?.content;
    if (
      !filePath ||
      content == null ||
      fileContent?.binary ||
      fileContent?.tooLarge
    ) {
      return;
    }
    let cancelled = false;
    tokenizeFile(content, getLanguage(filePath))
      .then((idx) => {
        if (!cancelled) tokenIndexRef.current = idx;
      })
      .catch(() => {
        // Leave the gate open (every word clickable) on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, fileContent]);
  const markdownRef = useRef<HTMLDivElement>(null);
  const realignCleanupRef = useRef<(() => void) | null>(null);

  // Scroll an in-document target into view and keep it aligned while the layout
  // settles. Streamdown renders code blocks (Shiki), Mermaid diagrams and images
  // asynchronously, so content above the target keeps changing height for a
  // moment after the click — a single scroll would leave the target stranded at
  // the wrong offset. Re-align on every reflow until the user scrolls away or a
  // short window elapses.
  const scrollToHashTarget = useCallback((rawId: string) => {
    const root = markdownRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[id="${CSS.escape(rawId)}"]`);
    if (!target) return;

    // Cancel any re-alignment still running from a previous click.
    realignCleanupRef.current?.();

    const align = () => target.scrollIntoView({ block: "start", behavior: "auto" });
    align();

    const observer = new ResizeObserver(align);
    observer.observe(root);

    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", stop);
      realignCleanupRef.current = null;
    };
    // User intent to scroll wins immediately; otherwise give async content ~1s
    // to settle, which covers Shiki/Mermaid/image rendering in practice.
    const timer = window.setTimeout(stop, 1000);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", stop);
    realignCleanupRef.current = stop;
  }, []);

  // Tear down a pending re-alignment if the preview unmounts mid-window.
  useEffect(() => () => realignCleanupRef.current?.(), []);

  // Streamdown ships no rehype-slug, so rendered headings have no `id` for an
  // in-document link ([xxx](#yyy)) to scroll to. Append rehype-slug after the
  // default plugins (so it runs after rehype-sanitize and its ids aren't
  // rewritten with a `user-content-` prefix) to give headings GitHub-style ids.
  const rehypePlugins = useMemo(
    () => [...Object.values(defaultRehypePlugins), rehypeSlug],
    []
  );

  // Streamdown renders every link with target="_blank", which makes in-document
  // references open in a new tab instead of jumping within the current file.
  // Mirror Streamdown's own anchor styling, but for hash links scroll inside the
  // preview instead of opening a new tab.
  const markdownComponents = useMemo(
    () => ({
      a: ({
        href,
        children,
        className,
        node,
        ...props
      }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
        // `node` is the hast node injected by the markdown renderer; drop it so
        // it isn't spread onto the DOM element.
        void node;
        const isHashLink = typeof href === "string" && href.startsWith("#");
        return (
          <a
            href={href}
            className={cn(
              "wrap-anywhere font-medium text-primary underline",
              className
            )}
            data-streamdown="link"
            {...(isHashLink
              ? {
                  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
                    e.preventDefault();
                    scrollToHashTarget(decodeURIComponent(href.slice(1)));
                  },
                }
              : { target: "_blank", rel: "noreferrer" })}
            {...props}
          >
            {children}
          </a>
        );
      },
    }),
    [scrollToHashTarget]
  );

  // Reset to rendered mode whenever a different file is opened.
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setViewMode("rendered");
    setSymbolNav(null);
  }

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a file to preview.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0">
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-2" />
          <Skeleton className="h-4 w-5/6 mb-2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  if (!fileContent) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Failed to load file.
      </div>
    );
  }

  const handleCopyPath = () => {
    navigator.clipboard.writeText(filePath);
  };

  const handleDownload = () => {
    if (!filePath) return;
    void api.downloadFile(projectId, filePath, branch, target).catch((err) => {
      console.error("Failed to download file", err);
    });
  };

  // Markdown files with previewable content can toggle between rendered and source.
  const canToggleMarkdown =
    isMarkdown(filePath) && !fileContent.tooLarge && !fileContent.binary && !!fileContent.content;
  const showRendered = canToggleMarkdown && viewMode === "rendered";
  // The foldable source CodeBlock is on screen (not rendered markdown, binary,
  // or an oversized file) — gate the Fold/Expand-all controls on this.
  const showingCode =
    !fileContent.tooLarge &&
    !fileContent.binary &&
    !showRendered &&
    fileContent.content !== null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-mono truncate">{filePath}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatSize(fileContent.size)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canToggleMarkdown && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setViewMode((m) => (m === "rendered" ? "source" : "rendered"))}
              title={showRendered ? "View source" : "View rendered"}
            >
              {showRendered ? <Code className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          )}
          {showingCode && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => codeBlockRef.current?.foldAll()}
                title="Fold all"
              >
                <ListCollapse className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => codeBlockRef.current?.expandAll()}
                title="Expand all"
              >
                <ListTree className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCopyPath} title="Copy path">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          {downloadUrl && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleDownload} title="Download">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {fileContent.tooLarge ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <FileWarning className="h-10 w-10" />
            <p className="text-sm">File too large to preview ({formatSize(fileContent.size)})</p>
            {downloadUrl && (
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}
          </div>
        ) : fileContent.binary && isImage(filePath) && fileContent.size <= IMAGE_PREVIEW_MAX_SIZE ? (
          <ImagePreview
            key={filePath}
            projectId={projectId}
            filePath={filePath}
            branch={branch}
            target={target}
            onDownload={handleDownload}
          />
        ) : fileContent.binary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <FileWarning className="h-10 w-10" />
            <p className="text-sm">
              {isImage(filePath)
                ? `Image too large to preview (${formatSize(fileContent.size)})`
                : `Binary file (${formatSize(fileContent.size)})`}
            </p>
            {downloadUrl && (
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}
          </div>
        ) : showRendered ? (
          <div
            className="p-4"
            style={{ fontSize: "var(--files-content-font-size, 14px)" }}
            ref={markdownRef}
          >
            <MessageResponse
              components={markdownComponents}
              rehypePlugins={rehypePlugins}
            >
              {fileContent.content ?? ""}
            </MessageResponse>
          </div>
        ) : fileContent.content !== null ? (
          <div
            className="h-full [&_pre]:text-[length:var(--files-content-font-size,14px)]! [&_code]:text-[length:var(--files-content-font-size,14px)]!"
            onMouseDown={handleMouseDown}
            onClick={handleClick}
          >
            <CodeBlock
              ref={codeBlockRef}
              code={fileContent.content}
              language={getLanguage(filePath)}
              showLineNumbers
              foldable
              scrollToLine={scrollToLine}
              scrollKey={scrollKey}
              className="border-0 rounded-none"
            >
              <CodeBlockCopyButton />
            </CodeBlock>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Empty file.
          </div>
        )}
      </div>

      {symbolNav && (
        <SymbolNavPopover
          projectId={projectId}
          symbol={symbolNav.symbol}
          branch={branch}
          target={target}
          currentFile={filePath}
          anchor={{ x: symbolNav.x, y: symbolNav.y }}
          onJump={onJump}
          onClose={() => setSymbolNav(null)}
        />
      )}
    </div>
  );
}
