"use client";

import { Download, FileWarning, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
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
