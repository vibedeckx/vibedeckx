export interface PendingSessionSelection {
  projectId: string | null | undefined;
  branch: string | null;
  sessionId: string;
}

interface ShouldClearSessionAfterWorkspaceChangeArgs {
  branchChanged: boolean;
  projectChanged: boolean;
  urlSessionId: string | null;
  pendingSessionSelection: PendingSessionSelection | null;
  currentProjectId: string | null | undefined;
  selectedBranch: string | null;
}

export function matchesPendingSessionSelection(
  pending: PendingSessionSelection | null,
  currentProjectId: string | null | undefined,
  selectedBranch: string | null,
  urlSessionId: string | null,
): boolean {
  return (
    !!pending &&
    pending.projectId === currentProjectId &&
    pending.branch === selectedBranch &&
    pending.sessionId === urlSessionId
  );
}

export function shouldClearSessionAfterWorkspaceChange({
  branchChanged,
  projectChanged,
  urlSessionId,
  pendingSessionSelection,
  currentProjectId,
  selectedBranch,
}: ShouldClearSessionAfterWorkspaceChangeArgs): boolean {
  if ((!branchChanged && !projectChanged) || !urlSessionId) return false;
  return !matchesPendingSessionSelection(
    pendingSessionSelection,
    currentProjectId,
    selectedBranch,
    urlSessionId,
  );
}
