"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import {
  FolderOpen,
  Loader2,
  X,
  Plus,
  Trash2,
  Server,
  Globe,
  Crown,
} from "lucide-react";
import {
  api,
  type Project,
  type RemoteServer,
} from "@/lib/api";
import { RemoteDirectoryBrowser } from "./remote-directory-browser";

type AddRemoteStep = "closed" | "pick-server" | "pick-path";

export interface ProjectSettingsFormProps {
  project: Project;
  onSave: (
    id: string,
    opts: {
      name?: string;
      path?: string | null;
      remotePath?: string | null;
    }
  ) => Promise<void> | Promise<unknown>;
  onCancel?: () => void;
}

export function ProjectSettingsForm({
  project,
  onSave,
  onCancel,
}: ProjectSettingsFormProps) {
  const { remotes, refresh: refreshRemotes } = useProjectRemotes(project.id);

  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [settingPrimaryRemoteId, setSettingPrimaryRemoteId] = useState<string | null>(null);
  const [addRemoteStep, setAddRemoteStep] = useState<AddRemoteStep>("closed");
  const [existingServers, setExistingServers] = useState<RemoteServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<RemoteServer | null>(null);
  const [selectedRemotePath, setSelectedRemotePath] = useState("");

  const resetAddRemoteFlow = () => {
    setAddRemoteStep("closed");
    setSelectedServer(null);
    setSelectedRemotePath("");
  };

  useEffect(() => {
    setName(project.name);
    setPath(project.path ?? "");
    setError("");
    resetAddRemoteFlow();
  }, [project.id]);

  const handleSelectFolder = async () => {
    const result = await api.selectFolder();
    if (result.path) {
      setPath(result.path);
    }
  };

  const handleOpenAddRemote = async () => {
    setAddRemoteStep("pick-server");
    try {
      const servers = await api.getRemoteServers();
      setExistingServers(servers);
    } catch {
      setExistingServers([]);
    }
  };

  const handleSelectExistingServer = (server: RemoteServer) => {
    setSelectedServer(server);
    setSelectedRemotePath("");
    setAddRemoteStep("pick-path");
  };

  const handleRemotePathSelect = (remPath: string) => {
    setSelectedRemotePath(remPath);
  };

  const handleConfirmAddRemote = async () => {
    if (!selectedServer || !selectedRemotePath) return;
    try {
      await api.addProjectRemote(project.id, {
        remoteServerId: selectedServer.id,
        remotePath: selectedRemotePath,
      });
      await refreshRemotes();
      resetAddRemoteFlow();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add remote");
    }
  };

  const handleRemoveRemote = async (remoteId: string) => {
    try {
      await api.removeProjectRemote(project.id, remoteId);
      await refreshRemotes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove remote");
    }
  };

  const handleSetPrimaryRemote = async (remoteId: string) => {
    setError("");
    setSettingPrimaryRemoteId(remoteId);
    try {
      await api.setProjectRemotePrimary(project.id, remoteId);
      await refreshRemotes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set primary remote");
    } finally {
      setSettingPrimaryRemoteId(null);
    }
  };

  const hasLocalPath = path.trim().length > 0;

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    if (!hasLocalPath && remotes.length === 0) {
      setError("Project must have at least a local folder or remote server");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const opts: {
        name?: string;
        path?: string | null;
        remotePath?: string | null;
      } = {};

      if (name.trim() !== project.name) {
        opts.name = name.trim();
      }

      const newPath = hasLocalPath ? path.trim() : null;
      if (newPath !== (project.path ?? null)) {
        opts.path = newPath;
      }

      await onSave(project.id, opts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="space-y-5 py-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Project Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Project"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Local Folder</label>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/project (optional)"
              className="flex-1"
            />
            <Button variant="outline" onClick={handleSelectFolder}>
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-sm font-medium">Remote Servers</label>
          <p className="text-xs text-muted-foreground">
            The primary remote is used for remote-only projects and default remote
            operations. When a local checkout exists, merge status is computed locally.
          </p>

          {remotes.length > 0 && (
            <div className="space-y-2">
              {remotes.map((remote, index) => (
                <div
                  key={remote.id}
                  className="flex items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate">{remote.server_name}</p>
                      {index === 0 && (
                        <Badge variant="secondary" className="shrink-0 gap-1">
                          <Crown className="h-3 w-3" />
                          Primary
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {remote.remote_path}
                    </p>
                  </div>
                  {index !== 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0"
                      disabled={settingPrimaryRemoteId !== null}
                      onClick={() => handleSetPrimaryRemote(remote.id)}
                    >
                      {settingPrimaryRemoteId === remote.id && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Set as Primary
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleRemoveRemote(remote.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {addRemoteStep === "closed" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenAddRemote}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Remote
            </Button>
          )}

          {addRemoteStep === "pick-server" && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium">
                  Select a Remote Server
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetAddRemoteFlow}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              {existingServers.length > 0 && (
                <div className="space-y-1">
                  {existingServers.map((server) => (
                    <button
                      key={server.id}
                      className="flex items-center gap-2 w-full rounded-md p-2 text-sm text-left hover:bg-muted"
                      onClick={() => handleSelectExistingServer(server)}
                    >
                      <Server className="h-4 w-4 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="truncate">{server.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {server.status === "online"
                            ? "Connected"
                            : "Not connected"}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Add new servers in Settings → Remote Servers, then connect
                the remote machine with a connect token.
              </p>
            </div>
          )}

          {addRemoteStep === "pick-path" && selectedServer && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium">
                  Select Directory on {selectedServer.name}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetAddRemoteFlow}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <RemoteDirectoryBrowser
                serverId={selectedServer.id}
                onSelect={handleRemotePathSelect}
                selectedPath={selectedRemotePath}
              />
              {selectedRemotePath && (
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Selected:{" "}
                    <span className="font-mono">{selectedRemotePath}</span>
                  </p>
                  <Button size="sm" onClick={handleConfirmAddRemote}>
                    Add
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={loading}>
          {loading ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </>
  );
}
