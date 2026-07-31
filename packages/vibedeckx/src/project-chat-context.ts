import type { ProjectChatContextRef, ProjectChatThread, Storage } from "./storage/types.js";

export const PROJECT_CHAT_CONTEXT_REF_LIMIT = 100;

export interface ProjectChatPublicContextRef extends ProjectChatContextRef {
  deleted: boolean;
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
  const existing = new Set((await storage.projectChatContextRefs.resolveExisting(
    thread.project_id,
    refs.map(({ entity_type, entity_id }) => ({ entity_type, entity_id })),
  )).map(({ entity_type, entity_id }) => `${entity_type}\0${entity_id}`));
  return refs.map((ref) => ({
    ...ref,
    deleted: !existing.has(`${ref.entity_type}\0${ref.entity_id}`),
  }));
}
