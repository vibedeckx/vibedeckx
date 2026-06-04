"use client";

import { useMemo, useRef, useState, type AnchorHTMLAttributes } from "react";
import { Download, FileWarning, Copy, Code, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileContentResponse } from "@/lib/api";
import type { BundledLanguage } from "shiki";

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

// Approximates the heading-slug algorithm used by GitHub / common TOC tools so
// in-document links like [xxx](#yyy) can be resolved to a heading by its text.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
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
}

export function FilePreview({ filePath, fileContent, loading, downloadUrl }: FilePreviewProps) {
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  const markdownRef = useRef<HTMLDivElement>(null);

  // Streamdown renders every link with target="_blank", which makes in-document
  // references ([xxx](#yyy)) open in a new tab instead of jumping within the
  // current file. Override the anchor so hash links scroll inside the preview.
  const markdownComponents = useMemo(
    () => ({
      a: ({
        href,
        children,
        node,
        ...props
      }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
        // `node` is the hast node injected by the markdown renderer; drop it so
        // it isn't spread onto the DOM element.
        void node;
        if (typeof href === "string" && href.startsWith("#")) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                const root = markdownRef.current;
                if (!root) return;
                const id = decodeURIComponent(href.slice(1));
                const escaped = id.replace(/["\\]/g, "\\$&");
                const target =
                  root.querySelector<HTMLElement>(`[id="${escaped}"]`) ??
                  Array.from(
                    root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")
                  ).find((h) => slugify(h.textContent ?? "") === id);
                target?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              {...props}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
    }),
    []
  );

  // Reset to rendered mode whenever a different file is opened.
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setViewMode("rendered");
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
          <div className="p-4 text-sm" ref={markdownRef}>
            <MessageResponse components={markdownComponents}>
              {fileContent.content ?? ""}
            </MessageResponse>
          </div>
        ) : fileContent.content !== null ? (
          <CodeBlock
            code={fileContent.content}
            language={getLanguage(filePath)}
            showLineNumbers
            className="border-0 rounded-none"
          >
            <CodeBlockCopyButton />
          </CodeBlock>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Empty file.
          </div>
        )}
      </div>
    </div>
  );
}
