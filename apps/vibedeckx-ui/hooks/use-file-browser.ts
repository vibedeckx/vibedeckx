"use client";

import { useState, useCallback, useRef } from "react";
import { api, type BrowseEntry, type FileContentResponse } from "@/lib/api";

interface UseFileBrowserOptions {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
}

export function useFileBrowser({ projectId, branch, target }: UseFileBrowserOptions) {
  const [rootEntries, setRootEntries] = useState<BrowseEntry[]>([]);
  const [directoryContents, setDirectoryContents] = useState<Map<string, BrowseEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  // Track which directories are currently loading
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  // Track the last fetched params to detect stale results
  const fetchKeyRef = useRef(0);

  const fetchRoot = useCallback(async () => {
    if (!projectId) return;
    setRootLoading(true);
    const key = ++fetchKeyRef.current;
    try {
      const result = await api.browseProjectDirectory(projectId, undefined, branch, target);
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
    } finally {
      if (key === fetchKeyRef.current) setRootLoading(false);
    }
  }, [projectId, branch, target]);

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
        const result = await api.browseProjectDirectory(projectId, dirPath, branch, target);
        setDirectoryContents(prev => {
          const next = new Map(prev);
          next.set(dirPath, result.items);
          return next;
        });
      } catch (err) {
        console.error("Failed to browse directory:", err);
      } finally {
        setLoadingDirs(prev => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    }
  }, [projectId, branch, target, directoryContents]);

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

  return {
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
  };
}
