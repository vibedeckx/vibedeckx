import type { ActiveView } from "@/components/layout";

const VALID_TABS = new Set<ActiveView>(["workspace", "tasks", "files"]);
const DEFAULT_TAB: ActiveView = "tasks";

export interface UrlState {
  projectId: string | null;
  tab: ActiveView;
  branch: string | null;
}

/**
 * Parse current URL into app state.
 * Supports: /, /p/:id, /p/:id/:tab, plus ?branch= query param.
 * Also detects legacy ?project= query params.
 */
export function parseUrlState(): UrlState {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  const search = typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(search);

  // Legacy query-param format: ?project=uuid&tab=workspace&branch=main
  const legacyProject = params.get("project");
  if (legacyProject) {
    const legacyTab = params.get("tab");
    return {
      projectId: legacyProject,
      tab: legacyTab && VALID_TABS.has(legacyTab as ActiveView)
        ? (legacyTab as ActiveView)
        : DEFAULT_TAB,
      branch: params.get("branch"),
    };
  }

  // New path format: /p/:projectId/:tab?branch=...
  const segments = pathname.split("/").filter(Boolean);

  let projectId: string | null = null;
  let tab: ActiveView = DEFAULT_TAB;

  if (segments[0] === "p" && segments[1]) {
    projectId = segments[1];
    const maybeTab = segments[2];
    if (maybeTab && VALID_TABS.has(maybeTab as ActiveView)) {
      tab = maybeTab as ActiveView;
    }
  }

  return { projectId, tab, branch: params.get("branch") };
}

/**
 * Build a URL string from app state.
 * Returns paths like: /, /p/uuid, /p/uuid/workspace, /p/uuid/files?branch=main
 */
export function buildUrl(state: { projectId?: string | null; tab?: ActiveView; branch?: string | null }): string {
  const { projectId, tab, branch } = state;

  if (!projectId) return "/";

  let path = `/p/${projectId}`;
  if (tab && tab !== DEFAULT_TAB) {
    path += `/${tab}`;
  }

  if (branch) {
    path += `?branch=${encodeURIComponent(branch)}`;
  }

  return path;
}
