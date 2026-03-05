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

  const handleSyncButton = async (syncType: 'up' | 'down') => {
    const config = syncType === 'up' ? project.sync_up_config : project.sync_down_config;
    if (!config) return;

    if (config.actionType === 'prompt') {
      onSyncPrompt?.(config.content, config.executionMode);
      return;
    }

    // Command execution
    setSyncOutput({ type: syncType, result: null, loading: true });
    setSyncOutputOpen(true);

    try {
      const result = await api.executeSyncCommand(project.id, syncType, selectedBranch);
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

  const showSyncUp = !!project.sync_up_config;
  const showSyncDown = !!project.sync_down_config;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg flex-1">{project.name}</CardTitle>
          {project.path && project.remote_path ? (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-500" title={`Local + Remote: ${project.remote_url}`}>
              <Globe className="h-3 w-3" />
              Local + Remote
            </span>
          ) : project.remote_path ? (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500" title={`Remote: ${project.remote_url}`}>
              <Globe className="h-3 w-3" />
              Remote
            </span>
          ) : null}
          {showSyncUp && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={() => handleSyncButton('up')}
              title={`Sync Up: ${project.sync_up_config!.content.slice(0, 50)}${project.sync_up_config!.content.length > 50 ? '...' : ''}`}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          {showSyncDown && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={() => handleSyncButton('down')}
              title={`Sync Down: ${project.sync_down_config!.content.slice(0, 50)}${project.sync_down_config!.content.length > 50 ? '...' : ''}`}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          )}
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
        {project.remote_path && project.remote_url && (
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
          <div className="border-t pt-2 space-y-2">
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
