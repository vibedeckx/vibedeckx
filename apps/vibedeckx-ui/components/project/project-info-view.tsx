"use client";

import { FolderOpen, Globe, Calendar } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
import type { Project, SyncButtonConfig } from "@/lib/api";
import { ProjectSettingsForm } from "./project-settings-form";

function StatusBadge({ project }: { project: Project }) {
  const hasLocal = !!project.path;
  const hasRemote = project.is_remote || !!project.remote_path;

  if (hasLocal && hasRemote) {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-500/10 px-2.5 py-0.5 text-xs font-medium text-purple-600">
        Local + Remote
      </span>
    );
  }
  if (hasRemote) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600">
        Remote
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      Local
    </span>
  );
}

interface ProjectInfoViewProps {
  project: Project;
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

export function ProjectInfoView({ project, onProjectUpdated }: ProjectInfoViewProps) {
  const { remotes } = useProjectRemotes(project.id);

  return (
    <div className="h-full flex flex-col p-6 overflow-hidden">
      <Tabs defaultValue="home" className="w-full max-w-2xl mx-auto flex flex-col flex-1 min-h-0">
        <TabsList>
          <TabsTrigger value="home">Home</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="home" className="flex-1 flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{project.name}</CardTitle>
                <StatusBadge project={project} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {project.path && (
                <div className="flex items-start gap-3 text-sm">
                  <FolderOpen className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground break-all">{project.path}</span>
                </div>
              )}

              {remotes.map((r) => (
                <div key={r.id} className="flex items-start gap-3 text-sm">
                  <Globe className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="text-muted-foreground break-all">{r.server_name}</span>
                    {r.server_url && (
                      <span className="block text-xs text-muted-foreground/70 break-all">{r.server_url}</span>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  Created {new Date(project.created_at).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto">
          <ProjectSettingsForm
            project={project}
            onSave={onProjectUpdated}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
