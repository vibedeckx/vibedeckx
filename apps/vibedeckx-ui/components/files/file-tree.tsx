"use client";

import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileCode, FileText, Loader2, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BrowseEntry } from "@/lib/api";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h",
  "css", "scss", "html", "vue", "svelte", "php", "swift", "kt", "sh", "bash",
  "yaml", "yml", "toml", "json", "xml", "sql", "graphql", "proto",
]);

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "log", "csv", "env", "gitignore", "dockerignore", "editorconfig",
]);

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_EXTENSIONS.has(ext)) return FileCode;
  if (TEXT_EXTENSIONS.has(ext)) return FileText;
  return File;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [path]);

  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded hover:bg-muted-foreground/20 transition-colors"
      title={`Copy path: ${path}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground" />
      )}
    </button>
  );
}

interface FileTreeNodeProps {
  entry: BrowseEntry;
  path: string;
  depth: number;
  expandedDirs: Set<string>;
  directoryContents: Map<string, BrowseEntry[]>;
  loadingDirs: Set<string>;
  selectedFile: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FileTreeNode({
  entry,
  path: nodePath,
  depth,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  onToggleDirectory,
  onSelectFile,
}: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(nodePath);
  const isLoading = loadingDirs.has(nodePath);
  const children = directoryContents.get(nodePath);

  if (entry.type === "directory") {
    const FolderIcon = isExpanded ? FolderOpen : Folder;
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

    return (
      <div>
        <div
          className="group flex items-center w-full px-2 py-1 text-sm rounded-sm hover:bg-accent transition-colors cursor-pointer"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => onToggleDirectory(nodePath)}
        >
          <div className="flex items-center gap-1 min-w-0 flex-1">
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <FolderIcon className="h-4 w-4 shrink-0 text-blue-500" />
            <span className="truncate">{entry.name}</span>
          </div>
          <div className="shrink-0 hidden group-hover:block ml-1">
            <CopyPathButton path={nodePath} />
          </div>
        </div>
        {isExpanded && children && (
          <div>
            {children.map(child => {
              const childPath = nodePath ? `${nodePath}/${child.name}` : child.name;
              return (
                <FileTreeNode
                  key={childPath}
                  entry={child}
                  path={childPath}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  directoryContents={directoryContents}
                  loadingDirs={loadingDirs}
                  selectedFile={selectedFile}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const FileIcon = getFileIcon(entry.name);
  const isSelected = selectedFile === nodePath;

  return (
    <div
      className={cn(
        "group flex items-center w-full px-2 py-1 text-sm rounded-sm transition-colors cursor-pointer",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: `${depth * 16 + 8 + 18}px` }}
      onClick={() => onSelectFile(nodePath)}
    >
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{entry.name}</span>
      </div>
      <div className="shrink-0 flex items-center gap-2 ml-1">
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.mtime && formatRelativeTime(entry.mtime)}
        </span>
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.size != null && formatFileSize(entry.size)}
        </span>
        <div className="hidden group-hover:block">
          <CopyPathButton path={nodePath} />
        </div>
      </div>
    </div>
  );
}

interface FileTreeProps {
  entries: BrowseEntry[];
  expandedDirs: Set<string>;
  directoryContents: Map<string, BrowseEntry[]>;
  loadingDirs: Set<string>;
  selectedFile: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}

export function FileTree({
  entries,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  onToggleDirectory,
  onSelectFile,
}: FileTreeProps) {
  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        No files found.
      </div>
    );
  }

  return (
    <div className="py-1">
      {entries.map(entry => {
        const entryPath = entry.name;
        return (
          <FileTreeNode
            key={entryPath}
            entry={entry}
            path={entryPath}
            depth={0}
            expandedDirs={expandedDirs}
            directoryContents={directoryContents}
            loadingDirs={loadingDirs}
            selectedFile={selectedFile}
            onToggleDirectory={onToggleDirectory}
            onSelectFile={onSelectFile}
          />
        );
      })}
    </div>
  );
}
