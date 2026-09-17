import { createHash, randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { proxyToRemoteAuto, type ProxyResult } from "./utils/remote-proxy.js";
import { compareVersionStrings } from "./update-check.js";
import type { RemoteExecutorInfo } from "./server-types.js";

/**
 * Workers since this version honor a caller-chosen `processId` on
 * `/api/path/execute` and answer a same-effect retry with the process that is
 * already running instead of spawning a second one (e6fc263c). Older workers
 * ignore the field, so a retry against them is not deduplicated.
 */
export const IDEMPOTENT_EXECUTE_MIN_WORKER_VERSION = "0.3.1";

export interface RemoteExecuteBody {
  path: string;
  command: string;
  executor_type: string;
  prompt_provider: string | null;
  branch?: string;
  cwd?: string;
  pty: boolean;
}

export interface RemoteStartRequest {
  executorId: string;
  projectId: string;
  remoteServerId: string;
  branch: string | null;
  body: RemoteExecuteBody;
}

export type RemoteStartOutcome =
  | { kind: "started"; processId: string }
  | { kind: "already_running"; processId: string }
  | { kind: "starting" }
  | { kind: "unknown"; error: string }
  | { kind: "rejected"; result: ProxyResult };

/**
 * A start whose outcome the hub has not observed yet. It keeps the identity the
 * worker was asked to use, so a start that did happen on the worker (response
 * lost to a tunnel drop) can be found again or retried idempotently instead of
 * being forgotten and launched a second time.
 */
interface PendingStart extends RemoteStartRequest {
  processId: string;
  effectFingerprint: string;
  inFlight: boolean;
}

const isTransportFailure = (result: ProxyResult): boolean =>
  result.status === 0 || result.errorCode === "timeout" || result.errorCode === "network_error";

/**
 * Process ids the worker currently reports as running, or null when the list
 * could not be fetched (callers must treat null as "unknown", never as "gone").
 */
export async function listWorkerRunningProcessIds(
  fastify: FastifyInstance,
  remoteServerId: string,
): Promise<Set<string> | null> {
  const result = await proxyToRemoteAuto(
    remoteServerId,
    "GET",
    "/api/executor-processes/running",
    undefined,
    { reverseConnectManager: fastify.reverseConnectManager },
  );
  if (!result.ok) return null;
  const processes = (result.data as { processes?: unknown } | null)?.processes;
  if (!Array.isArray(processes)) return null;
  const ids = new Set<string>();
  for (const proc of processes) {
    const id = (proc as { id?: unknown } | null)?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

export function createRemoteExecutorStarts(fastify: FastifyInstance) {
  /** `${executorId}:${remoteServerId}` → unconfirmed start */
  const pending = new Map<string, PendingStart>();

  const supportsIdempotentExecute = async (remoteServerId: string): Promise<boolean> => {
    const server = await fastify.storage.remoteServers.getById(remoteServerId);
    const version = server?.worker_version;
    if (!version) return false;
    return (compareVersionStrings(version, IDEMPOTENT_EXECUTE_MIN_WORKER_VERSION) ?? -1) >= 0;
  };

  const register = async (start: PendingStart, remoteProcessId: string): Promise<string> => {
    const localProcessId = `remote-${start.executorId}-${remoteProcessId}`;
    if (fastify.remoteExecutorMap.has(localProcessId)) return localProcessId;
    const remoteInfo: RemoteExecutorInfo = {
      remoteServerId: start.remoteServerId,
      remoteProcessId,
      executorId: start.executorId,
      projectId: start.projectId,
    };
    fastify.remoteExecutorMap.set(localProcessId, remoteInfo);
    // Detect completion independently of any frontend log-proxy connection,
    // so executor:stopped fires (and the map is cleared) even if the user
    // navigates away before the process finishes.
    fastify.remoteExecutorMonitor.watch(localProcessId, remoteInfo);
    await fastify.storage.remoteExecutorProcesses.insert(localProcessId, {
      remoteServerId: start.remoteServerId,
      remoteProcessId,
      executorId: start.executorId,
      projectId: start.projectId,
      branch: start.branch ?? undefined,
      machineId: fastify.reverseConnectManager.getMachineId(start.remoteServerId),
    });
    fastify.eventBus.emit({
      type: "executor:started",
      projectId: start.projectId,
      executorId: start.executorId,
      processId: localProcessId,
      target: start.remoteServerId,
    });
    return localProcessId;
  };

  const start = async (request: RemoteStartRequest): Promise<RemoteStartOutcome> => {
    // Everything up to the first await runs as one synchronous block, so two
    // overlapping requests cannot both pass these checks.
    for (const [localProcessId, info] of fastify.remoteExecutorMap) {
      if (info.executorId === request.executorId && info.remoteServerId === request.remoteServerId) {
        return { kind: "already_running", processId: localProcessId };
      }
    }
    const key = `${request.executorId}:${request.remoteServerId}`;
    let entry = pending.get(key);
    if (entry?.inFlight) return { kind: "starting" };
    if (!entry) {
      entry = {
        ...request,
        processId: randomUUID(),
        effectFingerprint: createHash("sha256")
          .update(JSON.stringify({ executorId: request.executorId, remoteServerId: request.remoteServerId, body: request.body }))
          .digest("hex"),
        inFlight: false,
      };
      pending.set(key, entry);
    }
    // A retry of an unconfirmed start reuses the stored identity and body: the
    // worker either returns the process the first attempt spawned or starts it
    // now — exactly once either way.
    const current = entry;
    current.inFlight = true;

    try {
      const result = await proxyToRemoteAuto(
        current.remoteServerId,
        "POST",
        "/api/path/execute",
        { ...current.body, processId: current.processId, effectFingerprint: current.effectFingerprint },
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      if (result.ok) {
        pending.delete(key);
        const remoteProcessId = (result.data as { processId: string }).processId;
        return { kind: "started", processId: await register(current, remoteProcessId) };
      }
      if (isTransportFailure(result)) {
        // The request may have reached the worker. Keep the identity so the
        // next attempt can be deduplicated — unless the worker can't dedupe,
        // in which case holding it would only block the user.
        if (!(await supportsIdempotentExecute(current.remoteServerId))) pending.delete(key);
        const reason = (result.data as { error?: string } | null)?.error ?? "Remote server unreachable";
        return { kind: "unknown", error: reason };
      }
      pending.delete(key);
      return { kind: "rejected", result };
    } finally {
      current.inFlight = false;
    }
  };

  /**
   * After a worker reconnects, look for unconfirmed starts that did happen.
   * Not seeing one proves nothing (a single listing can't rule the start out),
   * so absent entries stay pending for the next idempotent Start.
   */
  const reconcile = async (remoteServerId: string): Promise<void> => {
    const candidates = [...pending.entries()].filter(
      ([, entry]) => entry.remoteServerId === remoteServerId && !entry.inFlight,
    );
    if (candidates.length === 0) return;
    for (const [, entry] of candidates) entry.inFlight = true;
    try {
      const running = await listWorkerRunningProcessIds(fastify, remoteServerId);
      if (!running) return;
      for (const [key, entry] of candidates) {
        if (!running.has(entry.processId) || pending.get(key) !== entry) continue;
        pending.delete(key);
        await register(entry, entry.processId);
        console.log(`[RemoteExecutorStarts] confirmed start after reconnect: executor=${entry.executorId} target=${remoteServerId} process=${entry.processId}`);
      }
    } finally {
      for (const [, entry] of candidates) entry.inFlight = false;
    }
  };

  fastify.reverseConnectManager.setStatusChangeHandler((_remoteServerId, status) => {
    if (status !== "online") return;
    // Like RemoteExecutorMonitor: ask the manager which targets are routable
    // rather than trusting the event's id, so aliased targets resume too.
    const servers = new Set([...pending.values()].map((entry) => entry.remoteServerId));
    for (const serverId of servers) {
      if (!fastify.reverseConnectManager.isConnected(serverId)) continue;
      reconcile(serverId).catch((error) => {
        console.error(`[RemoteExecutorStarts] reconcile failed for ${serverId}:`, error);
      });
    }
  });

  return { start, reconcile };
}
