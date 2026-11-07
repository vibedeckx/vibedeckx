import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { PreviewLink } from "../storage/types.js";
import { LOCAL_PREVIEW_TARGET } from "../storage/repositories/preview-links.js";
import { isValidPreviewSlug, previewOrigin } from "../preview/preview-host.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";

/**
 * Preview links (docs/preview-links-design.md): the app-side half. These run
 * on the app origin with the Bearer token; the preview origin itself is served
 * by preview/preview-proxy.ts outside Fastify.
 *
 * Registry key of the worker-side support (reverse-connect-capabilities.ts).
 * A worker without it would corrupt binary assets and open HMR sockets
 * against its own API, so minting refuses instead of degrading.
 */
export const PREVIEW_PROXY_CAPABILITY = "passthrough:preview-proxy";

export interface PreviewLinkView {
  slug: string;
  targetId: string;
  /** Machine name, or "This machine" for the hub itself. */
  targetName: string;
  port: number;
  url: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the Browser tab needs to open a link: the origin and the one-time sign-in URL. */
export interface PreviewOpenResult {
  link: PreviewLinkView;
  authUrl: string;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const service = fastify.previewLinks;

  const requireProject = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return null;
    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      reply.code(404).send({ error: "Project not found" });
      return null;
    }
    return { userId, project };
  };

  const targetName = async (link: PreviewLink, userId: string): Promise<string> => {
    if (link.target_id === LOCAL_PREVIEW_TARGET) return "This machine";
    const server = await fastify.storage.remoteServers.getById(link.target_id, userId);
    return server?.name ?? "Unknown machine";
  };

  const view = async (link: PreviewLink, userId: string): Promise<PreviewLinkView> => ({
    slug: link.slug,
    targetId: link.target_id,
    targetName: await targetName(link, userId),
    port: link.port,
    url: previewOrigin(link.slug, service!.config),
    createdAt: link.created_at,
    lastUsedAt: link.last_used_at,
  });

  const openResult = async (link: PreviewLink, userId: string): Promise<PreviewOpenResult> => {
    const ticket = service!.auth.mintTicket(link.slug, userId);
    return {
      link: await view(link, userId),
      authUrl: `${previewOrigin(link.slug, service!.config)}/__vdx/auth?t=${encodeURIComponent(ticket)}`,
    };
  };

  // Every link of a project. `enabled: false` (no preview host) returns an
  // empty list rather than an error so the tab can render its explanation.
  fastify.get<{ Params: { id: string } }>("/api/projects/:id/preview-links", async (req, reply) => {
    const scope = await requireProject(req, reply);
    if (!scope) return;
    if (!service) return { enabled: false, links: [] as PreviewLinkView[] };
    const links = await fastify.storage.previewLinks.listByProject(scope.project.id, scope.userId);
    return { enabled: true, links: await Promise.all(links.map((link) => view(link, scope.userId))) };
  });

  // Create (or reuse) the link for a machine+port and mint a sign-in ticket.
  fastify.post<{ Params: { id: string }; Body: { targetId?: unknown; port?: unknown } }>(
    "/api/projects/:id/preview-links",
    async (req, reply) => {
      const scope = await requireProject(req, reply);
      if (!scope) return;
      if (!service) {
        return reply.code(409).send({
          errorCode: "preview-disabled",
          error: "Preview links are not configured on this server (set --preview-host).",
        });
      }
      const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : "";
      const port = Number(req.body?.port);
      if (!targetId) return reply.code(400).send({ error: "targetId is required" });
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return reply.code(400).send({ error: "port must be an integer between 1 and 65535" });
      }

      if (targetId === LOCAL_PREVIEW_TARGET) {
        // The hub's own machine: only meaningful where local projects exist.
        if (fastify.noLocalProjects || !scope.project.path) {
          return reply.code(400).send({ error: "This project has no local checkout on this server." });
        }
      } else {
        const link = await fastify.storage.projectRemotes.getByProjectAndServer(scope.project.id, targetId);
        if (!link) return reply.code(404).send({ error: "Machine is not linked to this project" });
        const server = await fastify.storage.remoteServers.getById(targetId, scope.userId);
        if (!server) return reply.code(404).send({ error: "Machine not found" });
        if (!server.worker_capabilities?.includes(PREVIEW_PROXY_CAPABILITY)) {
          return reply.code(409).send({
            errorCode: "worker-upgrade-required",
            error: `The worker on ${server.name} is too old for preview links. Update it to the latest version.`,
          });
        }
      }

      const link = await fastify.storage.previewLinks.upsert({
        projectId: scope.project.id,
        targetId,
        port,
        userId: scope.userId,
      });
      return reply.code(201).send(await openResult(link, scope.userId));
    },
  );

  fastify.delete<{ Params: { id: string; slug: string } }>(
    "/api/projects/:id/preview-links/:slug",
    async (req, reply) => {
      const scope = await requireProject(req, reply);
      if (!scope) return;
      const link = await fastify.storage.previewLinks.getBySlug(req.params.slug);
      if (!link || link.project_id !== scope.project.id) return reply.code(404).send({ error: "Preview link not found" });
      await fastify.storage.previewLinks.delete(link.slug, scope.userId);
      return reply.code(204).send();
    },
  );

  // A fresh sign-in ticket for an existing link: the Browser tab's Open button
  // and the `?preview=<slug>` bounce a bookmarked preview URL lands on.
  fastify.post<{ Params: { slug: string } }>("/api/preview-links/:slug/open", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;
    if (!service) return reply.code(409).send({ errorCode: "preview-disabled", error: "Preview links are not configured on this server." });
    if (!isValidPreviewSlug(req.params.slug)) return reply.code(404).send({ error: "Preview link not found" });
    const link = await fastify.storage.previewLinks.getBySlug(req.params.slug);
    // Ownership is the project's: the link row records who minted it, but the
    // project owner is who may open it (the same person in every deployment
    // today). A project the caller cannot see is a 404, not a 403.
    if (!link || !(await fastify.storage.projects.getById(link.project_id, userId))) {
      return reply.code(404).send({ error: "Preview link not found" });
    }
    if (link.user_id !== userId) {
      // Re-own so the cookie check in the proxy matches the user who opens it.
      await fastify.storage.previewLinks.upsert({ projectId: link.project_id, targetId: link.target_id, port: link.port, userId });
    }
    return openResult({ ...link, user_id: userId }, userId);
  });
};

export default fp(routes, { name: "preview-link-routes" });
