"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Folder, FolderPlus, ChevronRight, ChevronUp, Loader2 } from "lucide-react";
import { api, type RemoteBrowseItem } from "@/lib/api";

interface RemoteDirectoryBrowserProps {
  serverId: string;
  onSelect: (path: string) => void;
  selectedPath?: string;
}

export function RemoteDirectoryBrowser({
  serverId,
  onSelect,
  selectedPath,
}: RemoteDirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<RemoteBrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    if (!serverId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.browseRemoteServerDirectory(serverId, currentPath);
      setItems(result.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load directory");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Cancel any in-progress create when the directory changes.
    setCreating(false);
    setNewName("");
    setCreateError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, currentPath]);

  // Focus + select the input when the create row appears.
  useEffect(() => {
    if (creating) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [creating]);

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleGoUp = () => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    setCurrentPath(parentPath);
  };

  const handleSelect = (item: RemoteBrowseItem) => {
    onSelect(item.path);
  };

  const startCreate = () => {
    setCreateError("");
    setNewName("New Folder");
    setCreating(true);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError("");
  };

  const commitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const item = await api.createRemoteServerDirectory(serverId, currentPath, name);
      setCreating(false);
      setNewName("");
      await refresh();
      onSelect(item.path);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create folder");
    } finally {
      setCreateBusy(false);
    }
  };

  if (!serverId) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center border rounded-md">
        Select a remote server to browse directories
      </div>
    );
  }

  return (
    <div className="border rounded-md">
      <div className="flex items-center gap-2 p-2 border-b bg-muted/50">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGoUp}
          disabled={currentPath === "/" || loading}
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <span className="text-sm font-mono truncate flex-1">{currentPath}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={startCreate}
          disabled={loading || creating}
          title="New folder"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="p-4 text-sm text-red-500">{error}</div>
      ) : (
        <ScrollArea className="h-[200px]">
          <div className="p-1">
            {creating && (
              <div className="flex flex-col gap-1 p-2">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    ref={inputRef}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitCreate();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelCreate();
                      }
                    }}
                    onBlur={() => {
                      // Blur confirms, unless a request is already running.
                      if (!createBusy) void commitCreate();
                    }}
                    disabled={createBusy}
                    className="flex-1 bg-background border rounded px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                  {createBusy && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  )}
                </div>
                {createError && (
                  <span className="text-xs text-red-500 pl-6">{createError}</span>
                )}
              </div>
            )}
            {items.length === 0 && !creating ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                No directories found
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.path}
                  className={`flex items-center gap-2 p-2 rounded-md cursor-pointer hover:bg-muted ${
                    selectedPath === item.path ? "bg-muted" : ""
                  }`}
                >
                  <button
                    className="flex items-center gap-2 flex-1 text-left"
                    onClick={() => handleSelect(item)}
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm truncate">{item.name}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleNavigate(item.path)}
                    title="Open folder"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
