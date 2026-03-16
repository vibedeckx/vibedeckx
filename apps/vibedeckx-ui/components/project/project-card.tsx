"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderOpen, Calendar, Trash2, Globe, MoreVertical, Pencil, ArrowUp, ArrowDown, Play, RotateCcw, Copy, Check, Loader2 } from "lucide-react";
import { api, type Project, type Task, type SyncButtonConfig, type SyncExecutionResult, type ExecutionMode } from "@/lib/api";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import { EditProjectDialog } from "./edit-project-dialog";
import { SyncOutputDialog } from "./sync-output-dialog";

interface ProjectCardProps {
  project: Project;
  selectedBranch: string | null;
  onUpdateProject: (id: string, opts: {
    name?: string;
    path?: string | null;
    remotePath?: string | null;
    remoteUrl?: string | null;
    remoteApiKey?: string | null;
    syncUpConfig?: SyncButtonConfig | null;
    syncDownConfig?: SyncButtonConfig | null;
  }) => Promise<void> | Promise<unknown>;
  onDeleteProject: (id: string) => Promise<void>;
  onSyncPrompt?: (prompt: string, executionMode: ExecutionMode) => void;
  assignedTask?: Task | null;
  onStartTask?: (task: Task) => void;
  onResetTask?: (taskId: string) => void;
  startingTask?: boolean;
}

export function ProjectCard({ project, selectedBranch, onUpdateProject, onDeleteProject, onSyncPrompt, assignedTask, onStartTask, onResetTask, startingTask }: ProjectCardProps) {
  const { remotes } = useProjectRemotes(project.id);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [syncOutputOpen, setSyncOutputOpen] = useState(false);
  const [syncOutput, setSyncOutput] = useState<{
    type: 'up' | 'down';
    result: SyncExecutionResult | null;
    loading: boolean;
  }>({ type: 'up', result: null, loading: false });
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const createdDate = new Date(project.created_at).toLocaleDateString();

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPath(text);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  // Collect all sync configs: project-level (legacy) + per-remote
  const syncUpSources: Array<{ label: string; config: SyncButtonConfig; remoteServerId?: string }> = [];
  const syncDownSources: Array<{ label: string; config: SyncButtonConfig; remoteServerId?: string }> = [];

  // Legacy project-level sync configs
  if (project.sync_up_config) {
    syncUpSources.push({ label: "Project", config: project.sync_up_config });
  }
  if (project.sync_down_config) {
    syncDownSources.push({ label: "Project", config: project.sync_down_config });
  }

  // Per-remote sync configs
  for (const remote of remotes) {
    if (remote.sync_up_config) {
      syncUpSources.push({
        label: remote.server_name,
        config: remote.sync_up_config,
        remoteServerId: remote.remote_server_id,
      });
    }
    if (remote.sync_down_config) {
      syncDownSources.push({
        label: remote.server_name,
        config: remote.sync_down_config,
        remoteServerId: remote.remote_server_id,
      });
    }
  }

  const handleSyncAction = async (syncType: 'up' | 'down', config: SyncButtonConfig, remoteServerId?: string) => {
    if (config.actionType === 'prompt') {
      onSyncPrompt?.(config.content, config.executionMode);
      return;
    }

    // Command execution
    setSyncOutput({ type: syncType, result: null, loading: true });
    setSyncOutputOpen(true);

    try {
      const result = await api.executeSyncCommand(project.id, syncType, selectedBranch, remoteServerId);
      setSyncOutput({ type: syncType, result, loading: false });
    } catch (e) {
      setSyncOutput({
        type: syncType,
        result: {
          success: false,
          stdout: '',
          stderr: e instanceof Error ? e.message : 'Command execution failed',
          exitCode: 1,
        },
        loading: false,
      });
    }
  };

  const handleSyncButton = (syncType: 'up' | 'down') => {
    const sources = syncType === 'up' ? syncUpSources : syncDownSources;
    if (sources.length === 1) {
      handleSyncAction(syncType, sources[0].config, sources[0].remoteServerId);
    }
    // If multiple sources, the dropdown handles it
  };

  const showSyncUp = syncUpSources.length > 0;
  const showSyncDown = syncDownSources.length > 0;

  // Badge logic based on remotes
  const hasLocal = !!project.path;
  const remoteCount = remotes.length;

  const renderBadge = () => {
    if (hasLocal && remoteCount > 1) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-500" title={`Local + ${remoteCount} remotes`}>
          <Globe className="h-3 w-3" />
          Local + {remoteCount} Remotes
        </span>
      );
    }
    if (hasLocal && remoteCount === 1) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-500" title={`Local + Remote: ${remotes[0].server_name}`}>
          <Globe className="h-3 w-3" />
          Local + Remote
        </span>
      );
    }
    if (!hasLocal && remoteCount > 1) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500" title={`${remoteCount} remotes`}>
          <Globe className="h-3 w-3" />
          {remoteCount} Remotes
        </span>
      );
    }
    if (!hasLocal && remoteCount === 1) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500" title={`Remote: ${remotes[0].server_name}`}>
          <Globe className="h-3 w-3" />
          Remote
        </span>
      );
    }
    // Legacy fallback: check old project.remote_path
    if (hasLocal && project.remote_path) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-500" title={`Local + Remote: ${project.remote_url}`}>
          <Globe className="h-3 w-3" />
          Local + Remote
        </span>
      );
    }
    if (!hasLocal && project.remote_path) {
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500" title={`Remote: ${project.remote_url}`}>
          <Globe className="h-3 w-3" />
          Remote
        </span>
      );
    }
    return null;
  };

  const renderSyncButton = (syncType: 'up' | 'down', sources: typeof syncUpSources) => {
    const Icon = syncType === 'up' ? ArrowUp : ArrowDown;
    const label = syncType === 'up' ? 'Sync Up' : 'Sync Down';

    if (sources.length === 0) return null;

    if (sources.length === 1) {
      const source = sources[0];
      return (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={() => handleSyncAction(syncType, source.config, source.remoteServerId)}
          title={`${label}: ${source.config.content.slice(0, 50)}${source.config.content.length > 50 ? '...' : ''}`}
        >
          <Icon className="h-4 w-4" />
        </Button>
      );
    }

    // Multiple sources: dropdown
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            title={label}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sources.map((source, index) => (
            <DropdownMenuItem
              key={`${source.remoteServerId ?? 'project'}-${index}`}
              onSelect={() => handleSyncAction(syncType, source.config, source.remoteServerId)}
            >
              {source.label}: {source.config.content.slice(0, 40)}{source.config.content.length > 40 ? '...' : ''}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm font-semibold flex-1">{project.name}</CardTitle>
          {renderBadge()}
          {showSyncUp && renderSyncButton('up', syncUpSources)}
          {showSyncDown && renderSyncButton('down', syncDownSources)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-7 w-7">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditDialogOpen(true)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onDeleteProject(project.id)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {project.path && (
          <div className="group/path flex items-center gap-2 text-sm text-muted-foreground">
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate flex-1" title={project.path}>{project.path}</span>
            <button
              onClick={() => copyToClipboard(project.path!)}
              className="shrink-0 p-0.5 rounded hover:bg-muted opacity-0 group-hover/path:opacity-100 transition-opacity"
              title="Copy local path"
            >
              {copiedPath === project.path ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
        {/* Show linked remotes */}
        {remotes.map((remote) => (
          <div key={remote.id} className="group/remote flex items-center gap-2 text-sm text-muted-foreground">
            <Globe className="h-4 w-4 shrink-0" />
            <span className="truncate flex-1" title={`${remote.server_name}: ${remote.remote_path}`}>
              {remote.server_name}: {remote.remote_path}
            </span>
            <button
              onClick={() => copyToClipboard(remote.remote_path)}
              className="shrink-0 p-0.5 rounded hover:bg-muted opacity-0 group-hover/remote:opacity-100 transition-opacity"
              title="Copy remote path"
            >
              {copiedPath === remote.remote_path ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ))}
        {/* Legacy remote path fallback (for projects not yet migrated) */}
        {remotes.length === 0 && project.remote_path && project.remote_url && (
          <div className="group/remote flex items-center gap-2 text-sm text-muted-foreground">
            <Globe className="h-4 w-4 shrink-0" />
            <span className="truncate flex-1" title={`${project.remote_url}:${project.remote_path}`}>{project.remote_url}:{project.remote_path}</span>
            <button
              onClick={() => copyToClipboard(project.remote_path!)}
              className="shrink-0 p-0.5 rounded hover:bg-muted opacity-0 group-hover/remote:opacity-100 transition-opacity"
              title="Copy remote path"
            >
              {copiedPath === project.remote_path ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          <span>{createdDate}</span>
        </div>
        {assignedTask && (
          <div className="border-t border-border/40 pt-3 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground text-xs font-medium">Assigned Task:</span>
              <span className="text-sm truncate flex-1">{assignedTask.title}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="flex-1 active:scale-95 transition-transform"
                onClick={() => onStartTask?.(assignedTask)}
                disabled={startingTask}
              >
                {startingTask ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                {startingTask ? "Starting..." : "Start"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onResetTask?.(assignedTask.id)}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Reset
              </Button>
            </div>
          </div>
        )}
      </CardContent>
      <EditProjectDialog
        project={project}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onProjectUpdated={onUpdateProject}
      />
      <SyncOutputDialog
        open={syncOutputOpen}
        onOpenChange={setSyncOutputOpen}
        syncType={syncOutput.type}
        result={syncOutput.result}
        loading={syncOutput.loading}
      />
    </Card>
  );
}
