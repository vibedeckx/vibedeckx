"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
} from "react";
import { Download, FileWarning, Copy, Code, Eye } from "lucide-react";
import rehypeSlug from "rehype-slug";
import { defaultRehypePlugins } from "streamdown";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { FileContentResponse } from "@/lib/api";
import type { BundledLanguage } from "shiki";
import { SymbolNavPopover } from "./symbol-nav-popover";

// A double-clicked selection is treated as a symbol only if it's a bare identifier.
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Custom "selection" highlight for a double-clicked symbol, via the CSS Custom
// Highlight API. We register it synchronously in the double-click handler —
// BEFORE the popover mounts and clears the native selection — because a range
// read after that point has already collapsed to empty.
const SYMBOL_HL = "symbol-nav";

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
  style.textContent = `::highlight(${SYMBOL_HL}){background-color:rgba(101, 160, 255, 0.5);}`;
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
  } | null>(null);

  // Double-click selects a word natively; if it's an identifier, paint our own
  // "selection" highlight on it and open the symbol popover. The highlight is
  // registered HERE, synchronously, while the native selection is still live —
  // opening the popover clears the native selection, and a range read after that
  // (e.g. in the popover's effect) has already collapsed to empty. We build a
  // standalone range (not derived from the selection) so clearing the selection
  // can't collapse it.
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const sel = selection?.toString().trim() ?? "";
    if (!SYMBOL_RE.test(sel)) return;

    if (selection && selection.rangeCount > 0 && highlightApiAvailable()) {
      const live = selection.getRangeAt(0);
      const range = document.createRange();
      range.setStart(live.startContainer, live.startOffset);
      range.setEnd(live.endContainer, live.endOffset);
      ensureSymbolHlStyle();
      CSS.highlights.set(SYMBOL_HL, new Highlight(range));
    }

    setSymbolNav({ symbol: sel, x: e.clientX, y: e.clientY });
  }, []);

  // Drop the highlight whenever the popover isn't open (closed, or file changed),
  // and on unmount.
  useEffect(() => {
    if (!symbolNav) clearSymbolHighlight();
  }, [symbolNav]);
  useEffect(() => clearSymbolHighlight, []);
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
    if (downloadUrl) {
      window.open(downloadUrl, "_blank");
    }
  };

  // Markdown files with previewable content can toggle between rendered and source.
  const canToggleMarkdown =
    isMarkdown(filePath) && !fileContent.tooLarge && !fileContent.binary && !!fileContent.content;
  const showRendered = canToggleMarkdown && viewMode === "rendered";

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
        ) : fileContent.binary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <FileWarning className="h-10 w-10" />
            <p className="text-sm">Binary file ({formatSize(fileContent.size)})</p>
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
            onDoubleClick={handleDoubleClick}
          >
            <CodeBlock
              code={fileContent.content}
              language={getLanguage(filePath)}
              showLineNumbers
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
