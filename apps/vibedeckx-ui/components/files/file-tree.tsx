"use client";

import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileCode, FileText, Loader2 } from "lucide-react";
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
        <button
          onClick={() => onToggleDirectory(nodePath)}
          className={cn(
            "flex items-center gap-1 w-full px-2 py-1 text-sm rounded-sm hover:bg-accent transition-colors",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <FolderIcon className="h-4 w-4 shrink-0 text-blue-500" />
          <span className="truncate">{entry.name}</span>
        </button>
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
    <button
      onClick={() => onSelectFile(nodePath)}
      className={cn(
        "flex items-center gap-1 w-full px-2 py-1 text-sm rounded-sm transition-colors",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: `${depth * 16 + 8 + 18}px` }}
    >
      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
    </button>
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
