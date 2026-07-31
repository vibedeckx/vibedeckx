import type {
  ProjectChatContextRef,
  ProjectChatThread,
  Storage,
} from "./storage/types.js";

export const PROJECT_CHAT_CONTEXT_REF_LIMIT = 100;
const WORKSPACE_LOOKUP_LIMIT = 500;

export interface ProjectChatPublicContextRef extends ProjectChatContextRef {
  deleted: boolean;
}

function parseWorkspaceId(entityId: string): { target: string; branch: string | null } | null {
  try {
    const parsed = JSON.parse(entityId) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string"
      || (parsed[1] !== null && typeof parsed[1] !== "string")) return null;
    return { target: parsed[0], branch: parsed[1] };
  } catch {
    return null;
  }
}

async function contextEntityExists(
  storage: Storage,
  projectId: string,
  ref: ProjectChatContextRef,
  workspaces: () => Promise<Array<{ targetId: string; branch: string | null }>>,
): Promise<boolean> {
  switch (ref.entity_type) {
    case "task":
      return (await storage.tasks.getById(ref.entity_id))?.project_id === projectId;
    case "workspace": {
      const selector = parseWorkspaceId(ref.entity_id);
      if (!selector) return false;
      return (await workspaces()).some(({ targetId, branch }) =>
        targetId === selector.target && branch === selector.branch);
    }
    case "agent_session": {
      if ((await storage.agentSessions.getById(ref.entity_id))?.project_id === projectId) return true;
      const mapping = await storage.remoteSessionMappings.getAuthorizedByLocal(ref.entity_id, projectId);
      return Boolean(mapping && await storage.projectRemotes.getByProjectAndServer(
        projectId,
        mapping.remote_server_id,
      ));
    }
    case "schedule":
      return (await storage.scheduledTasks.getById(ref.entity_id))?.project_id === projectId;
    case "schedule_run": {
      const run = await storage.scheduledTaskRuns.getById(ref.entity_id);
      if (!run) return false;
      return (await storage.scheduledTasks.getById(run.schedule_id))?.project_id === projectId;
    }
  }
}

/**
 * Returns only public Context-rail data for an already-authorized thread.
 * Missing and cross-project targets deliberately collapse to the same Deleted
 * marker so a stale/corrupt ref cannot disclose another project's entity.
 */
export async function listProjectChatPublicContextRefs(
  storage: Storage,
  thread: ProjectChatThread,
): Promise<ProjectChatPublicContextRef[]> {
  const refs = await storage.projectChatContextRefs.listByThread(
    thread.id,
    thread.project_id,
    thread.user_id,
    PROJECT_CHAT_CONTEXT_REF_LIMIT,
  );
  let workspacePromise: Promise<Array<{ targetId: string; branch: string | null }>> | undefined;
  const workspaces = () => workspacePromise ??= storage.searchCache.listWorkspacesByProject(
    thread.project_id, WORKSPACE_LOOKUP_LIMIT,
  );
  return Promise.all(refs.map(async (ref) => ({
    ...ref,
    deleted: !(await contextEntityExists(storage, thread.project_id, ref, workspaces)),
  })));
}
