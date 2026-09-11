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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  ProjectRemoteUnlinkError,
  type Project,
  type RemoteInUseBody,
  type RemoteServer,
  type RemoteUnreachableBody,
  type RemoteUsage,
} from "@/lib/api";
import { RemoteDirectoryBrowser } from "./remote-directory-browser";

type AddRemoteStep = "closed" | "pick-server" | "pick-path";

/** The hub refused the unlink; which dialog to show depends on the body. */
type UnlinkRefusal =
  | { kind: "in-use"; body: RemoteInUseBody }
  | { kind: "unreachable"; remoteId: string; body: RemoteUnreachableBody };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** One line per kind of usage, empty kinds left out. */
function UsageList({ usage }: { usage: RemoteUsage }) {
  const lines: string[] = [];
  if (usage.workspaces.length > 0) {
    lines.push(`${plural(usage.workspaces.length, "workspace")}: ${usage.workspaces.join(", ")}`);
  }
  if (usage.sessions > 0 || usage.pendingSessions > 0) {
    const pending = usage.pendingSessions > 0 ? ` (${usage.pendingSessions} still being created)` : "";
    lines.push(`${plural(usage.sessions + usage.pendingSessions, "session")}${pending}`);
  }
  if (usage.schedules.length > 0) {
    lines.push(`${plural(usage.schedules.length, "schedule")}: ${usage.schedules.join(", ")}`);
  }
  if (usage.runningExecutors > 0) {
    lines.push(plural(usage.runningExecutors, "running executor"));
  }
  return (
    <ul className="list-disc pl-5 text-sm space-y-0.5">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

function unreachableHeadline(body: RemoteUnreachableBody): string {
  if (body.reason === "sync-failed") {
    return `${body.name} is online, but its workspace list could not be read (timeout or worker error). You can try again later.`;
  }
  if (body.tokenRevoked) {
    return `${body.name} has no valid connect token and will not come back online.`;
  }
  return body.lastConnectedAt
    ? `${body.name} is offline. Last online ${formatWhen(body.lastConnectedAt)}.`
    : `${body.name} is offline and has never connected.`;
}

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
  const [unlinkRefusal, setUnlinkRefusal] = useState<UnlinkRefusal | null>(null);
  const [unlinking, setUnlinking] = useState(false);

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

  // One round trip, no pre-check: the hub decides, and a refusal carries
  // everything the dialog needs.
  const handleRemoveRemote = async (remoteId: string, opts?: { force?: boolean }) => {
    setError("");
    setUnlinking(true);
    try {
      await api.removeProjectRemote(project.id, remoteId, opts);
      setUnlinkRefusal(null);
      await refreshRemotes();
    } catch (e) {
      if (e instanceof ProjectRemoteUnlinkError) {
        setUnlinkRefusal(e.body.errorCode === "remote-in-use"
          ? { kind: "in-use", body: e.body }
          : { kind: "unreachable", remoteId, body: e.body });
      } else {
        setError(e instanceof Error ? e.message : "Failed to remove remote");
      }
    } finally {
      setUnlinking(false);
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
            The primary remote is whose Git the sidebar describes: each workspace&apos;s
            merge status and uncommitted changes, plus the Files and Diff views. Where
            sessions run is chosen separately, in the session header. When a local
            checkout exists, the sidebar reads it instead.
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
                    aria-label={`Unlink ${remote.server_name}`}
                    disabled={unlinking}
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

      {/* The machine answered: the project still uses it. No override. */}
      <Dialog
        open={unlinkRefusal?.kind === "in-use"}
        onOpenChange={(open) => { if (!open) setUnlinkRefusal(null); }}
      >
        {unlinkRefusal?.kind === "in-use" && (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Cannot unlink {unlinkRefusal.body.name}</DialogTitle>
              <DialogDescription>
                This project still has the following on {unlinkRefusal.body.name}:
              </DialogDescription>
            </DialogHeader>
            <UsageList usage={unlinkRefusal.body.usage} />
            <p className="text-sm text-muted-foreground">
              To unlink it: remove the worktrees on that machine and try again, end or
              delete the sessions, move the schedules to another target, and let running
              executors finish.
            </p>
            <DialogFooter>
              <Button onClick={() => setUnlinkRefusal(null)}>Got it</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* The machine could not be asked: show what is known and let the user decide. */}
      <Dialog
        open={unlinkRefusal?.kind === "unreachable"}
        onOpenChange={(open) => { if (!open) setUnlinkRefusal(null); }}
      >
        {unlinkRefusal?.kind === "unreachable" && (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Cannot confirm what is on {unlinkRefusal.body.name}</DialogTitle>
              <DialogDescription>{unreachableHeadline(unlinkRefusal.body)}</DialogDescription>
            </DialogHeader>
            {unlinkRefusal.body.lastKnownUsage ? (
              <div className="space-y-1.5">
                <p className="text-sm">
                  As of the last sync on {formatWhen(unlinkRefusal.body.lastSyncedAt)}, this
                  project had the following on it (may be out of date):
                </p>
                <UsageList usage={unlinkRefusal.body.lastKnownUsage} />
              </div>
            ) : (
              <p className="text-sm">
                This machine&apos;s workspaces have never been read successfully.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Unlinking deletes nothing on that machine. This hub loses its references to
              the sessions, workspaces and schedules there. Linking the same machine again
              restores most of them.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUnlinkRefusal(null)} disabled={unlinking}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={unlinking}
                onClick={() => handleRemoveRemote(unlinkRefusal.remoteId, { force: true })}
              >
                {unlinking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Unlink anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
