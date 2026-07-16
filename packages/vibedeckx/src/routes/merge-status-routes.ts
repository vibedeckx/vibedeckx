import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import {
  computeMergeStatusPairs,
  type MergeComparison,
  type MergePairError,
  type MergeStatusPairEntry,
  type MergeStatusValue,
} from "../merge-status.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

/**
 * Merge status API — is each worktree branch merged into its target branch?
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

export type MergeStatusRepository =
  | { kind: "local"; label: "Local" }
  | { kind: "remote"; remoteServerId: string; label: string };

export type TargetSource = "request" | "stored" | "default";

export interface ProjectMergeStatusPairEntry extends MergeStatusPairEntry {
  targetSource: TargetSource;
  requestedTarget: string | null;
}

function resolveTargets(
  comparisons: MergeComparison[],
  storedTargets: Map<string, string>,
): { comparisons: MergeComparison[]; sources: TargetSource[] } {
  const sources: TargetSource[] = [];
  const effective = comparisons.map((comparison) => {
    if (comparison.target !== undefined) {
      sources.push("request");
      return comparison;
    }
    const storedTarget = storedTargets.get(comparison.branch);
    if (storedTarget !== undefined) {
      sources.push("stored");
      return { branch: comparison.branch, target: storedTarget };
    }
    sources.push("default");
    return comparison;
  });
  return { comparisons: effective, sources };
}

function annotateEntries(
  entries: MergeStatusPairEntry[],
  comparisons: MergeComparison[],
  sources: TargetSource[],
): ProjectMergeStatusPairEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    targetSource: sources[index],
    requestedTarget: comparisons[index]?.target ?? entry.target,
  }));
}

const MERGE_PAIR_ERRORS = new Set<MergePairError>([
  "target-not-found",
  "branch-not-found",
  "no-default-branch",
]);
const MERGE_STATUS_VALUES = new Set<MergeStatusValue>([
  "merged",
  "partial",
  "unmerged",
  "no-unique-commits",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRemoteMergeStatusEntry(
  value: unknown,
  comparison: MergeComparison,
): value is MergeStatusPairEntry {
  if (!isRecord(value) || value.branch !== comparison.branch) return false;
  if (value.target !== null && typeof value.target !== "string") return false;

  if (value.error !== undefined) {
    if (!MERGE_PAIR_ERRORS.has(value.error as MergePairError)) return false;
    if (
      value.status !== undefined
      || value.unmergedCount !== undefined
      || value.dirty !== undefined
    ) {
      return false;
    }
    if (value.error === "target-not-found") {
      return comparison.target !== undefined && value.target === null;
    }
    if (value.error === "no-default-branch") {
      return comparison.target === undefined && value.target === null;
    }
    return typeof value.target === "string"
      && (comparison.target === undefined || value.target === comparison.target);
  }

  return typeof value.target === "string"
    && (comparison.target === undefined || value.target === comparison.target)
    && MERGE_STATUS_VALUES.has(value.status as MergeStatusValue)
    && Number.isInteger(value.unmergedCount)
    && (value.unmergedCount as number) >= 0
    && typeof value.dirty === "boolean";
}

function parseRemoteEntries(
  data: unknown,
  comparisons: MergeComparison[],
): MergeStatusPairEntry[] | null {
  if (!isRecord(data) || !Array.isArray(data.entries)) return null;
  if (data.entries.length !== comparisons.length) return null;
  if (!data.entries.every((entry, index) =>
    isRemoteMergeStatusEntry(entry, comparisons[index]))) {
    return null;
  }

  const entries = data.entries as MergeStatusPairEntry[];
  const implicitEntries = entries.filter((_entry, index) =>
    comparisons[index].target === undefined);
  const hasNoDefault = implicitEntries.some((entry) => entry.error === "no-default-branch");
  if (hasNoDefault) {
    return implicitEntries.every((entry) => entry.error === "no-default-branch")
      ? entries
      : null;
  }

  const resolvedDefault = implicitEntries[0]?.target;
  return implicitEntries.every((entry) => entry.target === resolvedDefault)
    ? entries
    : null;
}

function legacyRemoteLabel(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).hostname;
  } catch {
    return "Remote";
  }
}

async function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const primary = remotes[0]; // sorted by sort_order
    return {
      serverId: primary.remote_server_id,
      url: primary.server_url ?? "",
      apiKey: primary.server_api_key ?? "",
      remotePath: primary.remote_path,
      serverName: primary.server_name,
    };
  }
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return {
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
      serverName: legacyRemoteLabel(project.remote_url),
    };
  }
  return null;
}

const MAX_COMPARISONS = 50;
const MAX_NAME_LENGTH = 256;

function isValidName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/** Returns validated comparisons, or null when the body is malformed. */
function parseComparisons(body: unknown): MergeComparison[] | null {
  if (!body || typeof body !== "object") return null;
  const comparisons = (body as { comparisons?: unknown }).comparisons;
  if (!Array.isArray(comparisons) || comparisons.length > MAX_COMPARISONS) return null;
  const result: MergeComparison[] = [];
  for (const item of comparisons) {
    if (!item || typeof item !== "object") return null;
    const branch = (item as { branch?: unknown }).branch;
    const target = (item as { target?: unknown }).target;
    if (typeof branch !== "string" || !branch) return null;
    if (target !== undefined && (typeof target !== "string" || !target)) return null;
    result.push(target === undefined ? { branch } : { branch, target });
  }
  return result;
}

function sendComputed(
  reply: FastifyReply,
  repoPath: string,
  comparisons: MergeComparison[],
  repository?: MergeStatusRepository,
) {
  try {
    return reply.code(200).send({
      ...(repository ? { repository } : {}),
      entries: computeMergeStatusPairs(repoPath, comparisons),
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Failed to compute merge status";
    return reply.code(statusCode).send({ error: message });
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Path-based: used as the proxy target by remote backends.
  fastify.post<{ Body: { path?: string; comparisons?: unknown } }>(
    "/api/path/branches/merge-status",
    async (req, reply) => {
      const projectPath = req.body?.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const comparisons = parseComparisons(req.body);
      if (!comparisons) {
        return reply.code(400).send({ error: "Invalid comparisons" });
      }
      return sendComputed(reply, projectPath, comparisons);
    },
  );

  // Project-based: local computation or proxy to remote for remote-only projects.
  fastify.post<{ Params: { id: string }; Body: { comparisons?: unknown } }>(
    "/api/projects/:id/branches/merge-status",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const comparisons = parseComparisons(req.body);
      if (!comparisons) {
        return reply.code(400).send({ error: "Invalid comparisons" });
      }

      const storedTargets = await fastify.storage.mergeTargets.getForBranches(
        project.id,
        comparisons.map(({ branch }) => branch),
      );
      const resolved = resolveTargets(comparisons, storedTargets);

      if (!project.path) {
        const remoteConfig = await getRemoteConfig(fastify, project);
        if (!remoteConfig) {
          return reply.code(400).send({ error: "Project has no local path" });
        }
        const result = await proxyToRemoteAuto(
          remoteConfig.serverId,
          remoteConfig.url,
          remoteConfig.apiKey,
          "POST",
          "/api/path/branches/merge-status",
          { path: remoteConfig.remotePath, comparisons: resolved.comparisons },
          { reverseConnectManager: fastify.reverseConnectManager },
        );
        if (!result.ok) {
          return reply.code(proxyStatus(result)).send(result.data);
        }
        const entries = parseRemoteEntries(result.data, resolved.comparisons);
        if (!entries) {
          return reply.code(502).send({ error: "Remote merge-status response invalid" });
        }
        return reply.code(200).send({
          repository: {
            kind: "remote",
            remoteServerId: remoteConfig.serverId,
            label: remoteConfig.serverName,
          } satisfies MergeStatusRepository,
          entries: annotateEntries(
            entries,
            resolved.comparisons,
            resolved.sources,
          ),
        });
      }

      try {
        const entries = computeMergeStatusPairs(project.path, resolved.comparisons);
        return reply.code(200).send({
          repository: { kind: "local", label: "Local" } satisfies MergeStatusRepository,
          entries: annotateEntries(entries, resolved.comparisons, resolved.sources),
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const message = error instanceof Error ? error.message : "Failed to compute merge status";
        return reply.code(statusCode).send({ error: message });
      }
    },
  );

  fastify.put<{ Params: { id: string }; Body: unknown }>(
    "/api/projects/:id/branches/merge-target",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (!req.body || typeof req.body !== "object") {
        return reply.code(400).send({ error: "Invalid merge target" });
      }

      const body = req.body as Record<string, unknown>;
      const { branch, target, ifAbsent } = body;
      if (
        !isValidName(branch)
        || (target !== null && !isValidName(target))
        || (ifAbsent !== undefined && typeof ifAbsent !== "boolean")
        || (ifAbsent === true && target === null)
      ) {
        return reply.code(400).send({ error: "Invalid merge target" });
      }

      let changed: boolean;
      let storedTarget: string | null;
      if (target === null) {
        changed = await fastify.storage.mergeTargets.delete(project.id, branch);
        storedTarget = null;
      } else if (ifAbsent === true) {
        changed = await fastify.storage.mergeTargets.insertIfAbsent(project.id, branch, target);
        if (changed) {
          storedTarget = target;
        } else {
          storedTarget = (await fastify.storage.mergeTargets.getForBranches(project.id, [branch]))
            .get(branch) ?? null;
        }
      } else {
        changed = await fastify.storage.mergeTargets.upsert(project.id, branch, target);
        storedTarget = target;
      }

      if (changed) {
        fastify.eventBus.emit({
          type: "merge-target:updated",
          projectId: project.id,
          branch,
        });
      }

      return reply.code(200).send({ branch, target: storedTarget });
    },
  );
};

export default fp(routes, { name: "merge-status-routes" });
