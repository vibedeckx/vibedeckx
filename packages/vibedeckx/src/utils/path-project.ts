import type { FastifyInstance } from "fastify";

/**
 * Resolve the project id that owns `projectPath` on a provider host, creating a
 * `path:<projectPath>` pseudo project row when none exists yet.
 *
 * Provider protocol routes (`/api/path/*`) are addressed by filesystem path —
 * the caller's project lives on the front server, not here. Everything the
 * provider registers (agent sessions, terminals) still needs a local project row
 * to hang ownership and foreign keys off, and that row is what per-process
 * authorization resolves back to.
 */
export async function ensurePathProjectId(
  fastify: FastifyInstance,
  projectPath: string,
): Promise<string> {
  const pseudoProjectId = `path:${projectPath}`;
  if (await fastify.storage.projects.getById(pseudoProjectId)) return pseudoProjectId;

  // A project already registered under this path owns it when the canonical
  // pseudo id has not been created yet.
  const existingByPath = await fastify.storage.projects.getByPath(projectPath);
  if (existingByPath) return existingByPath.id;

  const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
  try {
    await fastify.storage.projects.create({ id: pseudoProjectId, name, path: projectPath });
  } catch (err: unknown) {
    // Safety net for concurrent creation of the same path:<path> primary key.
    if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
  }
  return pseudoProjectId;
}
