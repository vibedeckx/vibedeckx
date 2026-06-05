"use client";

import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { api, type BrowseEntry, type FileContentResponse } from "@/lib/api";

interface UseFileBrowserOptions {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
  showHidden?: boolean;
}

export function useFileBrowser({ projectId, branch, target, showHidden = false }: UseFileBrowserOptions) {
  const [rootEntries, setRootEntries] = useState<BrowseEntry[]>([]);
  const [directoryContents, setDirectoryContents] = useState<Map<string, BrowseEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  // Track which directories are currently loading
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  // Track which directories are currently receiving an upload ("" = root)
  const [uploadingDirs, setUploadingDirs] = useState<Set<string>>(new Set());
  // Track which entry paths are currently being deleted
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  // Track the last fetched params to detect stale results
  const fetchKeyRef = useRef(0);

  const fetchRoot = useCallback(async () => {
    if (!projectId) return;
    setRootLoading(true);
    const key = ++fetchKeyRef.current;
    try {
      const result = await api.browseProjectDirectory(projectId, undefined, branch, target, showHidden);
      if (key !== fetchKeyRef.current) return;
      setRootEntries(result.items);
      setDirectoryContents(new Map());
      setExpandedDirs(new Set());
      setSelectedFile(null);
      setFileContent(null);
    } catch (err) {
      console.error("Failed to browse root directory:", err);
      if (key !== fetchKeyRef.current) return;
      setRootEntries([]);
      toast.error("Failed to browse files", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (key === fetchKeyRef.current) setRootLoading(false);
    }
  }, [projectId, branch, target, showHidden]);

  const toggleDirectory = useCallback(async (dirPath: string) => {
    if (!projectId) return;

    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });

    // Lazy load: only fetch if not already loaded
    if (!directoryContents.has(dirPath)) {
      setLoadingDirs(prev => new Set(prev).add(dirPath));
      try {
        const result = await api.browseProjectDirectory(projectId, dirPath, branch, target, showHidden);
        setDirectoryContents(prev => {
          const next = new Map(prev);
          next.set(dirPath, result.items);
          return next;
        });
      } catch (err) {
        console.error("Failed to browse directory:", err);
        toast.error(`Failed to open ${dirPath}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoadingDirs(prev => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    }
  }, [projectId, branch, target, showHidden, directoryContents]);

  const selectFile = useCallback(async (filePath: string) => {
    if (!projectId) return;

    setSelectedFile(filePath);
    setFileLoading(true);
    setFileContent(null);

    try {
      const result = await api.getFileContent(projectId, filePath, branch, target);
      setFileContent(result);
    } catch (err) {
      console.error("Failed to get file content:", err);
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }, [projectId, branch, target]);

  // Re-fetch a single directory's listing without resetting tree state.
  // dirPath "" refreshes the root.
  const refreshDirectory = useCallback(async (dirPath: string) => {
    if (!projectId) return;
    if (dirPath === "") {
      const result = await api.browseProjectDirectory(projectId, undefined, branch, target, showHidden);
      setRootEntries(result.items);
    } else {
      const result = await api.browseProjectDirectory(projectId, dirPath, branch, target, showHidden);
      setDirectoryContents(prev => {
        const next = new Map(prev);
        next.set(dirPath, result.items);
        return next;
      });
    }
  }, [projectId, branch, target, showHidden]);

  // Upload files into dirPath ("" = root), then refresh that directory.
  const uploadFiles = useCallback(async (dirPath: string, files: File[]) => {
    if (!projectId || files.length === 0) return;
    setUploadingDirs(prev => new Set(prev).add(dirPath));
    try {
      const { uploaded } = await api.uploadFiles(projectId, files, dirPath, branch, target);
      // Expand the folder so newly uploaded files are visible.
      if (dirPath !== "") {
        setExpandedDirs(prev => new Set(prev).add(dirPath));
      }
      await refreshDirectory(dirPath);
      toast.success(`Uploaded ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.error("Failed to upload files:", err);
      toast.error("Upload failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingDirs(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [projectId, branch, target, refreshDirectory]);

  // Delete a file or directory, then refresh its parent and clear the preview
  // if the deleted entry (or something inside it) was selected.
  const deleteEntry = useCallback(async (entryPath: string) => {
    if (!projectId || !entryPath) return;
    setDeletingPaths(prev => new Set(prev).add(entryPath));
    try {
      await api.deleteFile(projectId, entryPath, branch, target);
      setSelectedFile(prev => {
        if (prev === entryPath || (prev && prev.startsWith(`${entryPath}/`))) {
          setFileContent(null);
          return null;
        }
        return prev;
      });
      const parent = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
      await refreshDirectory(parent);
      toast.success("Deleted");
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingPaths(prev => {
        const next = new Set(prev);
        next.delete(entryPath);
        return next;
      });
    }
  }, [projectId, branch, target, refreshDirectory]);

  return {
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
    refreshDirectory,
    deleteEntry,
  };
}
