"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { useFileBrowser } from "@/hooks/use-file-browser";
import { api, type Project } from "@/lib/api";

interface FilesViewProps {
  projectId: string | null;
  project?: Project | null;
  selectedBranch?: string | null;
}

export function FilesView({ projectId, project, selectedBranch }: FilesViewProps) {
  // Determine target based on project config
  const target = project
    ? (!project.path && project.remote_url ? "remote" as const : undefined)
    : undefined;

  const {
    rootEntries,
    directoryContents,
    expandedDirs,
    selectedFile,
    fileContent,
    fileLoading,
    rootLoading,
    loadingDirs,
    fetchRoot,
    toggleDirectory,
    selectFile,
  } = useFileBrowser({
    projectId,
    branch: selectedBranch,
    target,
  });

  useEffect(() => {
    fetchRoot();
  }, [fetchRoot]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a project to browse files.
      </div>
    );
  }

  const downloadUrl = selectedFile && projectId
    ? api.getFileDownloadUrl(projectId, selectedFile, selectedBranch, target)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <h2 className="text-sm font-semibold">Files</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fetchRoot} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${rootLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Split content */}
      <div className="flex-1 flex overflow-hidden">
        {/* File tree (left) */}
        <ScrollArea className="w-2/5 border-r">
          {rootLoading && rootEntries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              Loading files...
            </div>
          ) : (
            <FileTree
              entries={rootEntries}
              expandedDirs={expandedDirs}
              directoryContents={directoryContents}
              loadingDirs={loadingDirs}
              selectedFile={selectedFile}
              onToggleDirectory={toggleDirectory}
              onSelectFile={selectFile}
            />
          )}
        </ScrollArea>

        {/* File preview (right) */}
        <div className="w-3/5 overflow-hidden">
          <FilePreview
            filePath={selectedFile}
            fileContent={fileContent}
            loading={fileLoading}
            downloadUrl={downloadUrl}
          />
        </div>
      </div>
    </div>
  );
}
