import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getProjectActivity } from "../project-activity.js";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/activity",
    async (req, reply) => {
      const authResult = requireAuth(req, reply);
      if (authResult === null) return;
      const { projectId } = req.params;
      const project = await fastify.storage.projects.getById(projectId, authResult);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      return reply.code(200).send(
        await getProjectActivity(fastify.storage, projectId, resolveUserId(authResult)),
      );
    },
  );
};

export default fp(routes);
