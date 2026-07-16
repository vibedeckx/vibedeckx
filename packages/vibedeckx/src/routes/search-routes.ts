import type { FastifyPluginAsync } from "fastify";
import { buildSearchCatalog } from "../search/catalog.js";

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // Worker-side (also served locally in solo mode): full project catalog for
  // search-cache refresh. Reached through the remote proxy like the other
  // /api/path/* provider routes.
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/path/search-catalog",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const project = await fastify.storage.projects.getByPath(projectPath);
      if (!project) {
        return reply.code(200).send({ snapshotAt: Date.now(), workspaces: [], sessions: [] });
      }
      try {
        const catalog = await buildSearchCatalog(
          {
            storage: fastify.storage,
            getProcessAlive: (id) => fastify.agentSessionManager.getSessionProcessAlive(id),
          },
          project.id,
          projectPath,
        );
        return reply.code(200).send(catalog);
      } catch (error) {
        return reply.code(500).send({ error: String(error) });
      }
    },
  );
};

export default searchRoutes;
