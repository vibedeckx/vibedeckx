"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Folder, ChevronRight, ChevronUp, Loader2 } from "lucide-react";
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

  useEffect(() => {
    if (!serverId) {
      setItems([]);
      return;
    }

    const fetchDirectory = async () => {
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

    fetchDirectory();
  }, [serverId, currentPath]);

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
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="p-4 text-sm text-red-500">{error}</div>
      ) : items.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground text-center">
          No directories found
        </div>
      ) : (
        <ScrollArea className="h-[200px]">
          <div className="p-1">
            {items.map((item) => (
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
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
