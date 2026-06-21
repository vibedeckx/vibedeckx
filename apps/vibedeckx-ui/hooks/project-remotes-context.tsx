"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useProjectRemotes } from "./use-project-remotes";
import type { ProjectRemote } from "@/lib/api";

interface ProjectRemotesContextValue {
  remotes: ProjectRemote[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const ProjectRemotesContext = createContext<ProjectRemotesContextValue | null>(
  null,
);

// Single source of truth for the currently-open project's remotes. Every
// workspace panel (agent, executors, terminal, diff) stays mounted at once, so
// without sharing they each fetch `/remotes` and poll `/api/remote-servers`
// independently. This provider runs one fetch + one 15s status poll and hands
// the result to all of them.
export function ProjectRemotesProvider({
  projectId,
  children,
}: {
  projectId: string | undefined;
  children: ReactNode;
}) {
  const value = useProjectRemotes(projectId, { withStatus: true });
  return (
    <ProjectRemotesContext.Provider value={value}>
      {children}
    </ProjectRemotesContext.Provider>
  );
}

export function useProjectRemotesContext(): ProjectRemotesContextValue {
  const ctx = useContext(ProjectRemotesContext);
  if (!ctx) {
    throw new Error(
      "useProjectRemotesContext must be used within a ProjectRemotesProvider",
    );
  }
  return ctx;
}
