"use client";

import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileCode, FileText, Loader2, Copy, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

function dragFiles(e: React.DragEvent): File[] {
  const items = e.dataTransfer.items;
  // Prefer the items API so we can skip dropped directories (files only).
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry();
      if (entry?.isDirectory) continue; // ignore dropped folders
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return Array.from(e.dataTransfer.files);
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

function DeleteButton({
  entryPath,
  type,
  deleting,
  onRequestDelete,
}: {
  entryPath: string;
  type: "file" | "directory";
  deleting: boolean;
  onRequestDelete: (entryPath: string, type: "file" | "directory") => void;
}) {
  if (deleting) {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onRequestDelete(entryPath, type);
      }}
      className="p-0.5 rounded hover:bg-destructive/20 transition-colors"
      title={`Delete ${entryPath}`}
      aria-label={`Delete ${entryPath}`}
    >
      <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
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
  uploadingDirs: Set<string>;
  dragOverPath: string | null;
  deletingPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
  onSetDragOverPath: (path: string | null) => void;
  onRequestDelete: (entryPath: string, type: "file" | "directory") => void;
}

function FileTreeNode({
  entry,
  path: nodePath,
  depth,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  uploadingDirs,
  dragOverPath,
  deletingPaths,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
  onSetDragOverPath,
  onRequestDelete,
}: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(nodePath);
  const isLoading = loadingDirs.has(nodePath);
  const children = directoryContents.get(nodePath);
  const isHidden = entry.name.startsWith(".");

  if (entry.type === "directory") {
    const FolderIcon = isExpanded ? FolderOpen : Folder;
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
    const isDragOver = dragOverPath === nodePath;
    const isUploading = uploadingDirs.has(nodePath);
    const isDeleting = deletingPaths.has(nodePath);

    return (
      <div>
        <div
          className={cn(
            "group flex items-center w-full px-2 py-2 text-sm rounded-sm transition-colors cursor-pointer",
            isDragOver ? "bg-primary/15 outline-2 -outline-offset-2 outline-dashed outline-primary/60" : "hover:bg-accent",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => onToggleDirectory(nodePath)}
          onDragOver={(e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            onSetDragOverPath(nodePath);
          }}
          onDrop={(e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            onSetDragOverPath(null);
            const files = dragFiles(e);
            if (files.length) onUploadFiles(nodePath, files);
          }}
        >
          <div className="flex items-center gap-1 min-w-0 flex-1">
            {isUploading || isLoading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <FolderIcon className={cn("h-4 w-4 shrink-0 text-blue-500", isHidden && "opacity-60")} />
            <span className={cn("truncate", isHidden && "text-muted-foreground")}>{entry.name}</span>
          </div>
          <div className={cn("shrink-0 ml-1 items-center gap-1", isDeleting ? "flex" : "hidden group-hover:flex")}>
            <CopyPathButton path={nodePath} />
            <DeleteButton entryPath={nodePath} type="directory" deleting={isDeleting} onRequestDelete={onRequestDelete} />
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
                  uploadingDirs={uploadingDirs}
                  dragOverPath={dragOverPath}
                  deletingPaths={deletingPaths}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                  onUploadFiles={onUploadFiles}
                  onSetDragOverPath={onSetDragOverPath}
                  onRequestDelete={onRequestDelete}
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
  const parentPath = nodePath.includes("/") ? nodePath.slice(0, nodePath.lastIndexOf("/")) : "";
  const isDeleting = deletingPaths.has(nodePath);

  return (
    <div
      className={cn(
        "group flex items-center w-full px-2 py-1 text-sm rounded-sm transition-colors cursor-pointer",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: `${depth * 16 + 8 + 18}px` }}
      onClick={() => onSelectFile(nodePath)}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onSetDragOverPath(parentPath);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onSetDragOverPath(null);
        const files = dragFiles(e);
        if (files.length) onUploadFiles(parentPath, files);
      }}
    >
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <FileIcon className={cn("h-4 w-4 shrink-0 text-muted-foreground", isHidden && "opacity-60")} />
        <span className={cn("truncate", isHidden && "text-muted-foreground")}>{entry.name}</span>
      </div>
      <div className="shrink-0 flex items-center gap-2 ml-1">
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.mtime && formatRelativeTime(entry.mtime)}
        </span>
        <span className="text-[11px] text-muted-foreground/70 group-hover:hidden whitespace-nowrap w-[52px] text-right tabular-nums">
          {entry.size != null && formatFileSize(entry.size)}
        </span>
        <div className={cn("items-center gap-1", isDeleting ? "flex" : "hidden group-hover:flex")}>
          <CopyPathButton path={nodePath} />
          <DeleteButton entryPath={nodePath} type="file" deleting={isDeleting} onRequestDelete={onRequestDelete} />
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
  uploadingDirs: Set<string>;
  rootLoading: boolean;
  deletingPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUploadFiles: (dirPath: string, files: File[]) => void;
  onDeleteEntry: (entryPath: string, type: "file" | "directory") => void;
}

export function FileTree({
  entries,
  expandedDirs,
  directoryContents,
  loadingDirs,
  selectedFile,
  uploadingDirs,
  rootLoading,
  deletingPaths,
  onToggleDirectory,
  onSelectFile,
  onUploadFiles,
  onDeleteEntry,
}: FileTreeProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; type: "file" | "directory" } | null>(null);
  const isRootDragOver = dragOverPath === "";
  const isRootUploading = uploadingDirs.has("");

  const requestDelete = useCallback((path: string, type: "file" | "directory") => {
    setPendingDelete({ path, type });
  }, []);

  const pendingName = pendingDelete
    ? (pendingDelete.path.includes("/") ? pendingDelete.path.slice(pendingDelete.path.lastIndexOf("/") + 1) : pendingDelete.path)
    : "";

  // The drop zone wraps the whole panel (outside the ScrollArea) so the empty
  // area below the file list also accepts drops. Folder/file rows stop
  // propagation, so they capture their own drops before reaching here.
  return (
    <div
      className={cn(
        "h-full transition-colors",
        isRootDragOver && "bg-accent/30 outline-2 -outline-offset-2 outline-dashed outline-primary/50",
      )}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDragOverPath("");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverPath(null);
        }
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDragOverPath(null);
        const files = dragFiles(e);
        if (files.length) onUploadFiles("", files);
      }}
    >
      <ScrollArea className="h-full">
        <div className="py-1">
          {isRootUploading && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading…
            </div>
          )}
          {rootLoading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              Loading files...
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
              {isRootDragOver ? "Drop files to upload" : "No files found. Drop files here to upload."}
            </div>
          ) : (
            entries.map(entry => {
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
                  uploadingDirs={uploadingDirs}
                  dragOverPath={dragOverPath}
                  deletingPaths={deletingPaths}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                  onUploadFiles={onUploadFiles}
                  onSetDragOverPath={setDragOverPath}
                  onRequestDelete={requestDelete}
                />
              );
            })
          )}
        </div>
      </ScrollArea>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.type === "directory" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.type === "directory" ? (
                <>
                  <span className="font-medium text-foreground">{pendingName}</span> and all its
                  contents will be permanently deleted. This can&apos;t be undone.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">{pendingName}</span> will be
                  permanently deleted. This can&apos;t be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }), "border-transparent")}
              onClick={() => {
                if (pendingDelete) onDeleteEntry(pendingDelete.path, pendingDelete.type);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
