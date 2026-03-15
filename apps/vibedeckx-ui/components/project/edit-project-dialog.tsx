"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import {
  FolderOpen,
  Loader2,
  Check,
  X,
  Terminal,
  Bot,
  Monitor,
  Cloud,
  Plus,
  Trash2,
  Server,
  Globe,
} from "lucide-react";
import { api, type Project, type SyncButtonConfig, type SyncActionType, type ExecutionMode, type RemoteServer } from "@/lib/api";
import { RemoteDirectoryBrowser } from "./remote-directory-browser";
import { cn } from "@/lib/utils";

interface EditProjectDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectUpdated: (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    remoteUrl?: string | null;
    remoteApiKey?: string | null;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }) => Promise<void> | Promise<unknown>;
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";

interface SyncConfigState {
  actionType: SyncActionType;
  executionMode: ExecutionMode;
  content: string;
}

const defaultSyncConfig: SyncConfigState = {
  actionType: 'command',
  executionMode: 'local',
  content: '',
};

function fromSyncButtonConfig(config?: SyncButtonConfig): SyncConfigState {
  if (!config) return { ...defaultSyncConfig };
  return {
    actionType: config.actionType,
    executionMode: config.executionMode,
    content: config.content,
  };
}

function toSyncButtonConfig(state: SyncConfigState): SyncButtonConfig {
  return {
    actionType: state.actionType,
    executionMode: state.executionMode,
    content: state.content,
  };
}

function ActionTypeToggle({
  actionType,
  onActionTypeChange,
}: {
  actionType: SyncActionType;
  onActionTypeChange: (type: SyncActionType) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border bg-muted/50 p-0.5 text-xs">
      <button
        onClick={() => onActionTypeChange("command")}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 transition-colors",
          actionType === "command"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Terminal className="h-3 w-3" />
        Command
      </button>
      <button
        onClick={() => onActionTypeChange("prompt")}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 transition-colors",
          actionType === "prompt"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Bot className="h-3 w-3" />
        Prompt
      </button>
    </div>
  );
}

function SyncConfigForm({
  config,
  onChange,
  label,
  targets,
}: {
  config: SyncConfigState;
  onChange: (config: SyncConfigState) => void;
  label: string;
  targets: ExecutionModeTarget[];
}) {
  return (
    <div className="space-y-4 py-2">
      <label className="text-sm font-medium">{label}</label>

      {targets.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Execution Environment</label>
          <div>
            <ExecutionModeToggle
              targets={targets}
              activeTarget={config.executionMode}
              onTargetChange={(executionMode: string) => onChange({ ...config, executionMode })}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Action Type</label>
        <div>
          <ActionTypeToggle
            actionType={config.actionType}
            onActionTypeChange={(actionType) => onChange({ ...config, actionType })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">
          {config.actionType === 'command' ? 'Shell Command' : 'Agent Prompt'}
        </label>
        <Textarea
          value={config.content}
          onChange={(e) => onChange({ ...config, content: e.target.value })}
          placeholder={config.actionType === 'command' ? 'git push origin HEAD' : 'Please pull the latest changes and rebase...'}
          rows={3}
        />
      </div>
    </div>
  );
}

type AddRemoteStep = "closed" | "pick-server" | "new-server" | "pick-path";

export function EditProjectDialog({
  project,
  open,
  onOpenChange,
  onProjectUpdated,
}: EditProjectDialogProps) {
  const { remotes, refresh: refreshRemotes } = useProjectRemotes(project.id);

  // Build execution mode targets for sync config toggles
  const syncTargets: ExecutionModeTarget[] = [];
  if (project.path) syncTargets.push({ id: "local", label: "Local", icon: Monitor });
  for (const r of remotes) {
    syncTargets.push({ id: r.remote_server_id, label: r.server_name, icon: Cloud });
  }

  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [syncUpConfig, setSyncUpConfig] = useState<SyncConfigState>(defaultSyncConfig);
  const [syncDownConfig, setSyncDownConfig] = useState<SyncConfigState>(defaultSyncConfig);

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

  // Populate form when dialog opens or project changes
  useEffect(() => {
    if (open) {
      setName(project.name);
      setPath(project.path ?? "");
      setError("");
      setSyncUpConfig(fromSyncButtonConfig(project.sync_up_config));
      setSyncDownConfig(fromSyncButtonConfig(project.sync_down_config));
      resetAddRemoteFlow();
    }
  }, [open, project]);

  const handleSelectFolder = async () => {
    const result = await api.selectFolder();
    if (result.path) {
      setPath(result.path);
    }
  };

  // Add Remote flow handlers
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
        remoteUrl?: string | null;
        remoteApiKey?: string | null;
        syncUpConfig?: SyncButtonConfig | null;
        syncDownConfig?: SyncButtonConfig | null;
      } = {};

      // Only send changed fields
      if (name.trim() !== project.name) {
        opts.name = name.trim();
      }

      const newPath = hasLocalPath ? path.trim() : null;
      if (newPath !== (project.path ?? null)) {
        opts.path = newPath;
      }

      // Include sync configs
      const newSyncUp = toSyncButtonConfig(syncUpConfig);
      const origSyncUp = project.sync_up_config;
      if (JSON.stringify(newSyncUp) !== JSON.stringify(origSyncUp)) {
        opts.syncUpConfig = newSyncUp;
      }

      const newSyncDown = toSyncButtonConfig(syncDownConfig);
      const origSyncDown = project.sync_down_config;
      if (JSON.stringify(newSyncDown) !== JSON.stringify(origSyncDown)) {
        opts.syncDownConfig = newSyncDown;
      }

      await onProjectUpdated(project.id, opts);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="settings">
          <TabsList className="w-full">
            <TabsTrigger value="settings" className="flex-1">Project Settings</TabsTrigger>
            <TabsTrigger value="sync-up" className="flex-1">Sync Up</TabsTrigger>
            <TabsTrigger value="sync-down" className="flex-1">Sync Down</TabsTrigger>
          </TabsList>

          <TabsContent value="settings">
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

                {/* List of linked remotes */}
                {remotes.length > 0 && (
                  <div className="space-y-2">
                    {remotes.map((remote) => (
                      <div
                        key={remote.id}
                        className="flex items-center gap-2 rounded-md border p-2 text-sm"
                      >
                        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{remote.server_name}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {remote.remote_path}
                          </p>
                        </div>
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
                      remoteUrl={selectedServer.url}
                      apiKey="server-stored"
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
          </TabsContent>

          <TabsContent value="sync-up">
            <SyncConfigForm
              config={syncUpConfig}
              onChange={setSyncUpConfig}
              label="Sync Up Button"
              targets={syncTargets}
            />
          </TabsContent>

          <TabsContent value="sync-down">
            <SyncConfigForm
              config={syncDownConfig}
              onChange={setSyncDownConfig}
              label="Sync Down Button"
              targets={syncTargets}
            />
          </TabsContent>
        </Tabs>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
