"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Eye, EyeOff, Search, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group";
import { Command, CommandList, CommandItem } from "@/components/ui/command";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { PageHeader } from "@/components/layout";
import { useFileBrowser } from "@/hooks/use-file-browser";
import { useFileSearch } from "@/hooks/use-file-search";
import { api, type Project } from "@/lib/api";

interface FilesViewProps {
  projectId: string | null;
  project?: Project | null;
  selectedBranch?: string | null;
}

export function FilesView({ projectId, project, selectedBranch }: FilesViewProps) {
  // Determine target based on project config — if no local path, try remote
  const target = project && !project.path ? "remote" as const : undefined;

  const [showHidden, setShowHidden] = useState(false);

  const {
    rootEntries,
    directoryContents,
    expandedDirs,
    selectedFile,
    fileContent,
    fileLoading,
    rootLoading,
    loadingDirs,
    uploadingDirs,
    deletingPaths,
    fetchRoot,
    toggleDirectory,
    selectFile,
    uploadFiles,
    deleteEntry,
  } = useFileBrowser({
    projectId,
    branch: selectedBranch,
    target,
    showHidden,
  });

  const search = useFileSearch({ projectId, branch: selectedBranch, target });

  useEffect(() => {
    fetchRoot();
  }, [fetchRoot]);

  // Refresh both the tree and the search cache so re-fetch picks up new files.
  const handleRefresh = useCallback(() => {
    fetchRoot();
    search.refresh();
  }, [fetchRoot, search]);

  // Open a search hit in the preview pane, then clear the query so the tree returns.
  const handleSelectResult = useCallback((path: string) => {
    selectFile(path);
    search.setQuery("");
  }, [selectFile, search]);

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
      <PageHeader
        title="Files"
        actions={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 hover:text-foreground ${showHidden ? "text-foreground" : "text-muted-foreground"}`}
              onClick={() => setShowHidden(v => !v)}
              title={showHidden ? "Hide hidden files" : "Show hidden files"}
              aria-pressed={showHidden}
            >
              {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleRefresh} title="Refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${rootLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      {/* Split content */}
      <ResizablePanelGroup direction="horizontal" autoSaveId="files-panels" className="flex-1">
        {/* File tree + search (left) */}
        <ResizablePanel defaultSize={33} minSize={20}>
          {/* The search input lives inside <Command> so its keydown events bubble
              to cmdk, giving the results list free arrow-key nav + Enter-to-open. */}
          <Command shouldFilter={false} className="flex h-full flex-col bg-transparent">
            <div className="border-b p-2">
              <InputGroup>
                <InputGroupAddon>
                  <Search className="h-3.5 w-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  placeholder="Search files..."
                  value={search.query}
                  onFocus={search.ensureLoaded}
                  onChange={(e) => search.setQuery(e.target.value)}
                />
                {search.query && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => search.setQuery("")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </div>

            {search.query ? (
              <CommandList className="max-h-none flex-1">
                {search.loading && search.results.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading files…
                  </div>
                ) : search.results.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No matching files.
                  </div>
                ) : (
                  <>
                    {search.results.map((r) => {
                      const slash = r.path.lastIndexOf("/");
                      const dir = slash >= 0 ? r.path.slice(0, slash + 1) : "";
                      const base = slash >= 0 ? r.path.slice(slash + 1) : r.path;
                      return (
                        <CommandItem
                          key={r.path}
                          value={r.path}
                          onSelect={() => handleSelectResult(r.path)}
                          className="flex-col items-start gap-0"
                        >
                          <span className="font-medium">{base}</span>
                          {dir && (
                            <span className="w-full truncate text-xs text-muted-foreground">{dir}</span>
                          )}
                        </CommandItem>
                      );
                    })}
                    {search.truncated && (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        Showing first 50,000 files — refine your search to narrow results.
                      </div>
                    )}
                  </>
                )}
              </CommandList>
            ) : (
              <div className="flex-1 overflow-hidden">
                <FileTree
                  entries={rootEntries}
                  expandedDirs={expandedDirs}
                  directoryContents={directoryContents}
                  loadingDirs={loadingDirs}
                  selectedFile={selectedFile}
                  uploadingDirs={uploadingDirs}
                  rootLoading={rootLoading}
                  deletingPaths={deletingPaths}
                  onToggleDirectory={toggleDirectory}
                  onSelectFile={selectFile}
                  onUploadFiles={uploadFiles}
                  onDeleteEntry={deleteEntry}
                />
              </div>
            )}
          </Command>
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
