import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ProjectRemoteWithServer, RemoteUsage } from "../storage/types.js";
import { proxyToRemoteAuto } from "../utils/remote-proxy.js";
import {
  registerReportedWorktrees,
  snapshotLiveCheckouts,
  syncRemoteWorktreeList,
  type ReportedWorktree,
} from "../workspace-binding-backfill.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";

function sanitizeProjectRemote(pr: ProjectRemoteWithServer) {
  return pr;
}

/** Ceiling on how long linking waits for the new remote's worktree list. */
const LINK_SYNC_TIMEOUT_MS = 10_000;

/**
 * Register a just-linked remote's worktree list, so its per-workspace state
 * is known from the start instead of "unknown" until it is listed. Offline
 * or old workers simply leave it unconfirmed; the link itself has already
 * succeeded, so nothing here may fail it.
 */
async function syncLinkedRemoteWorktrees(
  fastify: FastifyInstance,
  projectId: string,
  remote: { remote_server_id: string; remote_path: string },
): Promise<void> {
  try {
    const result = await proxyToRemoteAuto(
      remote.remote_server_id,
      "GET",
      `/api/path/worktrees?path=${encodeURIComponent(remote.remote_path)}`,
      undefined,
      { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: LINK_SYNC_TIMEOUT_MS },
    );
    if (!result.ok) return;
    const worktrees = (result.data as { worktrees?: ReportedWorktree[] } | undefined)?.worktrees;
    if (!Array.isArray(worktrees)) return;
    await registerReportedWorktrees(fastify.storage, {
      projectId,
      targetId: remote.remote_server_id,
      remotePath: remote.remote_path,
      worktrees,
    });
    await fastify.storage.projectRemotes.markWorktreesSynced(projectId, remote.remote_server_id);
  } catch (error) {
    console.warn(`[ProjectRemotes] Worktree sync after linking ${remote.remote_server_id} failed:`, error);
  }
}

/** Ceiling on how long an unlink waits to confirm the machine's worktree list. */
const UNLINK_SYNC_TIMEOUT_MS = 10_000;

type UnreachableReason = "offline" | "sync-failed";

/**
 * Whether the machine can be asked what it has right now, deciding the
 * unlink by present connectivity rather than by when it last synced.
 *
 * Online: its registry rows are reconciled to the list it reports (a
 * worktree removed by hand is tombstoned here, so "delete it there and
 * retry" is a real way out). Offline, or online but not answering with a
 * real list within the timeout: unreachable, and the registry is left
 * exactly as it was.
 */
async function confirmRemoteReachable(
  fastify: FastifyInstance,
  projectId: string,
  remote: { remote_server_id: string; remote_path: string },
): Promise<{ reachable: true } | { reachable: false; reason: UnreachableReason }> {
  if (!fastify.reverseConnectManager?.isConnected(remote.remote_server_id)) {
    return { reachable: false, reason: "offline" };
  }
  try {
    const snapshot = await snapshotLiveCheckouts(fastify.storage, projectId, remote.remote_server_id);
    const result = await proxyToRemoteAuto(
      remote.remote_server_id,
      "GET",
      `/api/path/worktrees?path=${encodeURIComponent(remote.remote_path)}`,
      undefined,
      // Without the manager the proxy answers network_error at once and an
      // online machine would be misjudged unreachable, unlocking force.
      { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: UNLINK_SYNC_TIMEOUT_MS },
    );
    if (!result.ok) return { reachable: false, reason: "sync-failed" };
    const synced = await syncRemoteWorktreeList(
      fastify.storage,
      projectId,
      { serverId: remote.remote_server_id, remotePath: remote.remote_path },
      result.data,
      snapshot,
    );
    return synced ? { reachable: true } : { reachable: false, reason: "sync-failed" };
  } catch (error) {
    console.warn(`[ProjectRemotes] Worktree sync before unlinking ${remote.remote_server_id} failed:`, error);
    return { reachable: false, reason: "sync-failed" };
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describeUsage(usage: RemoteUsage): string {
  const parts: string[] = [];
  if (usage.workspaces.length > 0) parts.push(plural(usage.workspaces.length, "workspace"));
  if (usage.sessions > 0) parts.push(plural(usage.sessions, "session"));
  if (usage.pendingSessions > 0) parts.push(plural(usage.pendingSessions, "pending session"));
  if (usage.schedules.length > 0) parts.push(plural(usage.schedules.length, "schedule"));
  if (usage.runningExecutors > 0) parts.push(plural(usage.runningExecutors, "running executor"));
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:id/remotes — list all remotes for a project (api_key sanitized)
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/remotes",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { id } = request.params;
      const project = await fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });
      const remotes = await fastify.storage.projectRemotes.getByProject(id);
      return reply.send(remotes.map(sanitizeProjectRemote));
    }
  );

  // POST /api/projects/:id/remotes — add a remote to a project
  fastify.post<{ Params: { id: string } }>(
    "/api/projects/:id/remotes",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const { id } = request.params;
      const { remoteServerId, remotePath, sortOrder } =
        request.body as {
          remoteServerId: string;
          remotePath: string;
          sortOrder?: number;
        };

      if (!remoteServerId || !remotePath)
        return reply
          .code(400)
          .send({ error: "remoteServerId and remotePath are required" });

      const project = await fastify.storage.projects.getById(id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const server = await fastify.storage.remoteServers.getById(remoteServerId, userId);
      if (!server)
        return reply.code(404).send({ error: "Remote server not found" });

      const existing = await fastify.storage.projectRemotes.getByProjectAndServer(
        id,
        remoteServerId
      );
      if (existing)
        return reply
          .code(409)
          .send({ error: "This remote server is already associated with the project" });

      const projectRemote = await fastify.storage.projectRemotes.add({
        project_id: id,
        remote_server_id: remoteServerId,
        remote_path: remotePath,
        sort_order: sortOrder,
      });
      await syncLinkedRemoteWorktrees(fastify, id, projectRemote);
      return reply.code(201).send(
        // The sync may have just confirmed the remote; answer with that.
        (await fastify.storage.projectRemotes.getByProjectAndServer(id, remoteServerId)) ?? projectRemote,
      );
    }
  );

  // PUT /api/projects/:id/remotes/:rid — update a project-remote association
  fastify.put<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const { rid } = request.params;
      const { remotePath, sortOrder } =
        request.body as {
          remotePath?: string;
          sortOrder?: number;
        };

      const updated = await fastify.storage.projectRemotes.update(rid, {
        remote_path: remotePath,
        sort_order: sortOrder,
      }, project.id);
      if (!updated)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send(updated);
    }
  );

  // POST /api/projects/:id/remotes/:rid/primary — promote a project remote
  fastify.post<{ Params: { id: string; rid: string } }>(
    "/api/projects/:id/remotes/:rid/primary",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const promoted = await fastify.storage.projectRemotes.setPrimary(
        project.id,
        request.params.rid,
      );
      if (!promoted)
        return reply.code(404).send({ error: "Project remote not found" });
      return reply.send({ success: true });
    },
  );

  // DELETE /api/projects/:id/remotes/:rid[?force=1] — unlink a remote from a
  // project, refusing while the project still has something on it.
  //
  // Decided by connectivity at this moment (docs/project-remote-unlink-guard-
  // design.md §3): a reachable machine is re-synced and any usage is a hard
  // 409 `remote-in-use` that `force` cannot override — the ways out are to
  // remove the worktree there, end the session, or retarget the schedule. Only
  // an unreachable machine (offline, or not answering) gets 409
  // `remote-unreachable` with what the hub last knew, and only there does
  // `force=1` unlink anyway: a machine that is never coming back could not be
  // unlinked otherwise, and the hub cannot tell that from a weekend shutdown.
  fastify.delete<{ Params: { id: string; rid: string }; Querystring: { force?: string } }>(
    "/api/projects/:id/remotes/:rid",
    async (request, reply) => {
      const userId = requireAuth(request, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(request.params.id, userId);
      if (!project)
        return reply.code(404).send({ error: "Project not found" });

      const { rid } = request.params;
      const remote = (await fastify.storage.projectRemotes.getByProject(project.id))
        .find((candidate) => candidate.id === rid);
      if (!remote)
        return reply.code(404).send({ error: "Project remote not found" });

      const connectivity = await confirmRemoteReachable(fastify, project.id, remote);
      const force = request.query.force === "1" && !connectivity.reachable;
      const outcome = await fastify.storage.projectRemotes.removeGuarded(rid, project.id, {
        force,
        reachable: connectivity.reachable,
      });

      if (outcome.outcome === "not-found")
        return reply.code(404).send({ error: "Project remote not found" });
      if (outcome.outcome === "removed")
        return reply.send({ success: true });

      if (connectivity.reachable) {
        return reply.code(409).send({
          error: `${remote.server_name} still has ${describeUsage(outcome.usage)} in this project.`,
          errorCode: "remote-in-use",
          serverId: remote.remote_server_id,
          name: remote.server_name,
          usage: outcome.usage,
        });
      }

      // The repository maps a NULL token / timestamp to undefined; the wire
      // contract is null.
      const server = await fastify.storage.remoteServers.getById(remote.remote_server_id);
      const lastSyncedAt = remote.worktrees_synced_at ?? null;
      return reply.code(409).send({
        error: connectivity.reason === "offline"
          ? `${remote.server_name} is offline; its workspaces cannot be confirmed.`
          : `${remote.server_name} is online but did not report its workspaces; they cannot be confirmed.`,
        errorCode: "remote-unreachable",
        serverId: remote.remote_server_id,
        name: remote.server_name,
        reason: connectivity.reason,
        lastConnectedAt: server?.last_connected_at ?? null,
        lastSyncedAt,
        tokenRevoked: server?.connect_token == null,
        // Without a successful sync the registry holds nothing worth calling
        // "last known".
        lastKnownUsage: lastSyncedAt === null ? null : outcome.usage,
      });
    }
  );
};

export default fp(routes, { name: "project-remote-routes" });
