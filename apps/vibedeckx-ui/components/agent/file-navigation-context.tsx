"use client";

import { createContext, useContext } from "react";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

// Where a file mentioned in the conversation is read from — the same
// (project, branch, target) triple the Files tab uses, so a hover preview
// fetches through the identical API and lands on the identical machine.
export interface FileReadScope {
  projectId: string;
  branch: string | null;
  target?: "local" | "remote";
  /**
   * The conversation asking. A repo file needs only the triple above, but an
   * artifact the agent names by absolute path (`/tmp/shot.png`) belongs to
   * whichever machine ran the command that wrote it — the session's own remote,
   * or one it drove through the cross-remote gateway. The backend ranks those
   * candidates; without the session it can only guess the project's primary.
   */
  sessionId?: string | null;
}

export interface FileNavigationValue {
  openFile: (path: string, line?: number | null) => void;
  index: FileRefIndex | null;
  // Absent while no project is open. Optional so harnesses that only exercise
  // repo-file links need not provide it.
  scope?: FileReadScope | null;
}

const FileNavigationContext = createContext<FileNavigationValue | null>(null);

const NOOP: FileNavigationValue = { openFile: () => {}, index: null, scope: null };

export function useFileNavigation(): FileNavigationValue {
  return useContext(FileNavigationContext) ?? NOOP;
}

export const FileNavigationProvider = FileNavigationContext.Provider;
