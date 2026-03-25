"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
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
  // Determine target based on project config — if no local path, try remote
  const target = project && !project.path ? "remote" as const : undefined;

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
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <RefreshCw className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to browse files.</p>
        </div>
      </div>
    );
  }

  const downloadUrl = selectedFile && projectId
    ? api.getFileDownloadUrl(projectId, selectedFile, selectedBranch, target)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 flex-shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Files</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Browse and preview project files</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={fetchRoot} title="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${rootLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Split content */}
      <ResizablePanelGroup direction="horizontal" autoSaveId="files-panels" className="flex-1">
        {/* File tree (left) */}
        <ResizablePanel defaultSize={33} minSize={20}>
          <ScrollArea className="h-full">
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
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* File preview (right) */}
        <ResizablePanel defaultSize={67} minSize={25}>
          <div className="h-full overflow-hidden">
            <FilePreview
              filePath={selectedFile}
              fileContent={fileContent}
              loading={fileLoading}
              downloadUrl={downloadUrl}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
