import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import { proxyStatus, proxyToRemote } from "../utils/remote-proxy.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  // Test connection to remote vibedeckx server
  fastify.post<{
    Body: { url: string; apiKey: string };
  }>("/api/remote/test-connection", async (req, reply) => {
    const { url, apiKey } = req.body;

    if (!url || !apiKey) {
      return reply.code(400).send({ error: "URL and API key are required" });
    }

    const result = await proxyToRemote(url, apiKey, "GET", "/api/projects");

    if (result.ok) {
      return reply.code(200).send({ success: true, message: "Connection successful" });
    } else if (result.status === 401) {
      return reply.code(401).send({ error: "Invalid API key" });
    } else if (result.status === 0) {
      return reply.code(502).send({ error: "Cannot connect to remote server" });
    } else {
      return reply.code(result.status).send(result.data);
    }
  });

  // Browse remote directory
  fastify.post<{
    Body: { url: string; apiKey: string; path?: string };
  }>("/api/remote/browse", async (req, reply) => {
    const { url, apiKey, path: browsePath } = req.body;

    if (!url || !apiKey) {
      return reply.code(400).send({ error: "URL and API key are required" });
    }

    const queryPath = browsePath || "/";
    const result = await proxyToRemote(
      url,
      apiKey,
      "GET",
      `/api/browse?path=${encodeURIComponent(queryPath)}`
    );

    if (result.ok) {
      return reply.code(200).send(result.data);
    } else {
      return reply.code(proxyStatus(result)).send(result.data);
    }
  });

  // Create remote project (stores connection config locally only)
  fastify.post<{
    Body: {
      name: string;
      path: string;
      remoteUrl: string;
      remoteApiKey: string;
    };
  }>("/api/projects/remote", async (req, reply) => {
    const { name, path: projectPath, remoteUrl, remoteApiKey } = req.body;

    if (!name || !projectPath || !remoteUrl || !remoteApiKey) {
      return reply.code(400).send({ error: "All fields are required" });
    }

    const id = randomUUID();
    const project = await fastify.storage.projects.create({
      id,
      name,
      remote_path: projectPath,
      remote_url: remoteUrl,
      remote_api_key: remoteApiKey,
    });

    const { remote_api_key: _, ...safeProject } = project;
    return reply.code(201).send({ project: safeProject });
  });
};

export default fp(routes, { name: "remote-routes" });
