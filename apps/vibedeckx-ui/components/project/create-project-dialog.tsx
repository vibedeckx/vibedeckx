"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderOpen, Loader2, Check, X, Plus, Trash2, Server, Globe } from "lucide-react";
import { api, type RemoteServer, type Project } from "@/lib/api";
import { RemoteDirectoryBrowser } from "./remote-directory-browser";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectCreated: (opts: {
    name: string;
    path?: string;
    remotePath?: string;
    remoteUrl?: string;
    remoteApiKey?: string;
  }) => Promise<void> | Promise<unknown>;
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";

interface PendingRemote {
  serverId: string;
  serverName: string;
  serverUrl: string | null;
  remotePath: string;
}

type AddRemoteStep = "closed" | "pick-server" | "new-server" | "pick-path";

export function CreateProjectDialog({
  open,
  onOpenChange,
  onProjectCreated,
}: CreateProjectDialogProps) {
  // Project name
  const [name, setName] = useState("");

  // Local project state
  const [path, setPath] = useState("");

  // Multi-remote state
  const [pendingRemotes, setPendingRemotes] = useState<PendingRemote[]>([]);

  // "Add Remote" flow state
  const [addRemoteStep, setAddRemoteStep] = useState<AddRemoteStep>("closed");
  const [existingServers, setExistingServers] = useState<RemoteServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<RemoteServer | null>(null);
  const [selectedRemotePath, setSelectedRemotePath] = useState("");

  // New server creation
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [newServerApiKey, setNewServerApiKey] = useState("");
  const [newServerStatus, setNewServerStatus] = useState<ConnectionStatus>("idle");
  const [newServerError, setNewServerError] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setName("");
    setPath("");
    setPendingRemotes([]);
    resetAddRemoteFlow();
    setError("");
  };

  const resetAddRemoteFlow = () => {
    setAddRemoteStep("closed");
    setSelectedServer(null);
    setSelectedRemotePath("");
    setNewServerName("");
    setNewServerUrl("");
    setNewServerApiKey("");
    setNewServerStatus("idle");
    setNewServerError("");
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  };

  const handleSelectFolder = async () => {
    const result = await api.selectFolder();
    if (result.path) {
      setPath(result.path);
      if (!name) {
        const folderName = result.path.split("/").pop() || "";
        setName(folderName);
      }
    }
  };

  // Fetch existing servers when opening the picker
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

  const handleStartNewServer = () => {
    setAddRemoteStep("new-server");
    setNewServerName("");
    setNewServerUrl("");
    setNewServerApiKey("");
    setNewServerStatus("idle");
    setNewServerError("");
  };

  const handleTestNewServer = async () => {
    if (!newServerUrl || !newServerApiKey) {
      setNewServerError("URL and API key are required");
      return;
    }
    setNewServerStatus("testing");
    setNewServerError("");
    try {
      await api.testRemoteConnection(newServerUrl, newServerApiKey);
      setNewServerStatus("success");
    } catch (e) {
      setNewServerStatus("error");
      setNewServerError(e instanceof Error ? e.message : "Connection failed");
    }
  };

  const handleCreateAndSelectServer = async () => {
    if (!newServerName.trim() || !newServerUrl.trim()) return;
    try {
      const server = await api.createRemoteServer({
        name: newServerName.trim(),
        url: newServerUrl.trim(),
        apiKey: newServerApiKey.trim() || undefined,
      });
      setSelectedServer(server);
      setSelectedRemotePath("");
      setAddRemoteStep("pick-path");
    } catch (e) {
      setNewServerError(e instanceof Error ? e.message : "Failed to create server");
    }
  };

  const handleRemotePathSelect = (remPath: string) => {
    setSelectedRemotePath(remPath);
  };

  const handleConfirmAddRemote = () => {
    if (!selectedServer || !selectedRemotePath) return;
    // Don't add duplicates
    const alreadyAdded = pendingRemotes.some(
      r => r.serverId === selectedServer.id && r.remotePath === selectedRemotePath
    );
    if (alreadyAdded) {
      resetAddRemoteFlow();
      return;
    }
    setPendingRemotes(prev => [
      ...prev,
      {
        serverId: selectedServer.id,
        serverName: selectedServer.name,
        serverUrl: selectedServer.url,
        remotePath: selectedRemotePath,
      },
    ]);
    if (!name) {
      const folderName = selectedRemotePath.split("/").pop() || "";
      setName(folderName);
    }
    resetAddRemoteFlow();
  };

  const handleRemoveRemote = (index: number) => {
    setPendingRemotes(prev => prev.filter((_, i) => i !== index));
  };

  const hasLocalPath = path.trim().length > 0;
  const hasRemotes = pendingRemotes.length > 0;

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    if (!hasLocalPath && !hasRemotes) {
      setError("Please provide a local folder, remote server, or both");
      return;
    }

    setLoading(true);
    setError("");
    try {
      // Call the parent callback which creates the project and returns it
      const result = await onProjectCreated({
        name: name.trim(),
        ...(hasLocalPath ? { path: path.trim() } : {}),
      });

      // If we have remotes to add, we need the project ID
      if (hasRemotes && result && typeof result === "object" && "id" in result) {
        const project = result as Project;
        for (const remote of pendingRemotes) {
          await api.addProjectRemote(project.id, {
            remoteServerId: remote.serverId,
            remotePath: remote.remotePath,
          });
        }
        // Auto-set agent_mode to first remote when no local path
        if (!hasLocalPath) {
          await api.updateProject(project.id, { agentMode: pendingRemotes[0].serverId });
        }
      }

      resetForm();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Project Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Project Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
            />
          </div>

          {/* Local Folder Section */}
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

          {/* Remote Servers Section */}
          <div className="space-y-3">
            <label className="text-sm font-medium">Remote Servers</label>

            {/* List of added remotes */}
            {pendingRemotes.length > 0 && (
              <div className="space-y-2">
                {pendingRemotes.map((remote, index) => (
                  <div
                    key={`${remote.serverId}-${remote.remotePath}`}
                    className="flex items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{remote.serverName}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {remote.remotePath}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 w-7 shrink-0"
                      onClick={() => handleRemoveRemote(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Remote flow */}
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
                  <label className="text-xs font-medium">Select a Remote Server</label>
                  <Button variant="ghost" size="sm" onClick={resetAddRemoteFlow}>
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
                          <p className="text-xs text-muted-foreground truncate">{server.url}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartNewServer}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Server
                </Button>
              </div>
            )}

            {addRemoteStep === "new-server" && (
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Create New Server</label>
                  <Button variant="ghost" size="sm" onClick={resetAddRemoteFlow}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Input
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                  placeholder="Server name"
                />
                <Input
                  value={newServerUrl}
                  onChange={(e) => {
                    setNewServerUrl(e.target.value);
                    setNewServerStatus("idle");
                  }}
                  placeholder="http://remote-server:5173"
                />
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={newServerApiKey}
                    onChange={(e) => {
                      setNewServerApiKey(e.target.value);
                      setNewServerStatus("idle");
                    }}
                    placeholder="API key"
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTestNewServer}
                    disabled={newServerStatus === "testing" || !newServerUrl || !newServerApiKey}
                  >
                    {newServerStatus === "testing" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : newServerStatus === "success" ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : newServerStatus === "error" ? (
                      <X className="h-4 w-4 text-red-500" />
                    ) : (
                      "Test"
                    )}
                  </Button>
                </div>
                {newServerError && (
                  <p className="text-xs text-red-500">{newServerError}</p>
                )}
                {newServerStatus === "success" && (
                  <>
                    <p className="text-xs text-green-500">Connection successful</p>
                    <Button
                      size="sm"
                      onClick={handleCreateAndSelectServer}
                      disabled={!newServerName.trim()}
                    >
                      Create &amp; Continue
                    </Button>
                  </>
                )}
              </div>
            )}

            {addRemoteStep === "pick-path" && selectedServer && (
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">
                    Select Directory on {selectedServer.name}
                  </label>
                  <Button variant="ghost" size="sm" onClick={resetAddRemoteFlow}>
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
                      Selected: <span className="font-mono">{selectedRemotePath}</span>
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

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? "Creating..." : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
