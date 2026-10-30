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
  /** Shown to the user while the start is being re-delivered. */
  executorName?: string;
  projectId: string;
  remoteServerId: string;
  branch: string | null;
  body: RemoteExecuteBody;
  /**
   * Caller-chosen worker process id, so the caller can register who owns the
   * process before it exists. A request carrying the id of the process already
   * running answers `started` again; any other running or unconfirmed start on
   * the target is someone else's and is reported, never adopted.
   */
  processId?: string;
  /**
   * Only re-send the pending start with `processId`; never start anew. For a
   * user's "Retry now" on a notice that may be stale: if the hub already
   * delivered or gave up on that start, a fresh start would run it again.
   */
  retryOnly?: boolean;
}

export type RemoteStartOutcome =
  | { kind: "started"; processId: string }
  | { kind: "already_running"; processId: string }
  | { kind: "starting" }
  /**
   * The request may have reached the worker. `retrying`: the hub keeps
   * delivering it under the same identity until `deadlineAt`; the outcome
   * arrives as `executor:started` or as an `executor:delivery` event.
   */
  | { kind: "unknown"; error: string; reason: DeliveryFailure; retrying: boolean; deadlineAt?: number }
  /** The hub had already stopped re-delivering it: the delivery window is over. */
  | { kind: "gave_up" }
  /** `retryOnly`: that start is no longer pending (delivered or given up); nothing was sent. */
  | { kind: "retry_ended" }
  | { kind: "rejected"; result: ProxyResult };

/**
 * How long a lost start is re-delivered under its identity. Must stay below the
 * worker's memory of a finished process (`LOG_RETENTION_MS`, 30 min after
 * exit): within it, a re-delivery of a start that did run is answered with
 * that process instead of running the command again.
 */
export const DELIVERY_WINDOW_MS = 20 * 60_000;
/** Pause between delivery attempts while the worker is connected. */
export const DELIVERY_RETRY_INTERVAL_MS = 30_000;
const DELIVERY_TICK_MS = 5_000;
/** A start the hub gave up on stays listed this long, for the user to act on. */
const GAVE_UP_RETENTION_MS = 60 * 60_000;

/** Why the last delivery attempt failed. */
export type DeliveryFailure =
  /** No open tunnel: the request was not sent. */
  | "offline"
  /** The tunnel closed while the request was out. */
  | "connection_closed"
  /** No answer in time. */
  | "timeout";

/**
 * A start the hub is still delivering (`retrying`), has given up on
 * (`gave_up`), or that the worker refused on re-delivery (`rejected`, event
 * only). A delivered start needs no event of its own: `executor:started` says it.
 */
export interface ExecutorDelivery {
  /** Local id (`remote-<executorId>-<id>`) the process runs under once delivered. */
  processId: string;
  executorId: string;
  executorName: string | null;
  projectId: string;
  remoteServerId: string;
  branch: string | null;
  state: "retrying" | "gave_up" | "rejected";
  attempts: number;
  reason: DeliveryFailure | null;
  error: string | null;
  /** Null while waiting for the worker to reconnect, or once settled. */
  nextAttemptAt: number | null;
  firstSentAt: number;
  deadlineAt: number;
  /**
   * An attempt may have reached the worker (it failed after being sent). When
   * false every attempt failed before leaving the hub: the command did not run.
   */
  mayHaveRun: boolean;
}

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
  attempts: number;
  firstSentAt: number;
  nextAttemptAt: number | null;
  reason: DeliveryFailure | null;
  error: string | null;
  /** A retrying event went out, so the outcome is announced too. */
  announced: boolean;
  mayHaveRun: boolean;
}

const isTransportFailure = (result: ProxyResult): boolean =>
  result.status === 0 || result.errorCode === "timeout" || result.errorCode === "network_error";

const classifyFailure = (result: ProxyResult): DeliveryFailure =>
  result.notSent ? "offline" : result.errorCode === "timeout" ? "timeout" : "connection_closed";

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
  /** Same key → a start given up on, until the next start or its retention ends. */
  const gaveUp = new Map<string, ExecutorDelivery>();
  let ticker: ReturnType<typeof setInterval> | null = null;

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

  const localIdOf = (entry: PendingStart) => `remote-${entry.executorId}-${entry.processId}`;

  const deliveryOf = (entry: PendingStart, state: ExecutorDelivery["state"]): ExecutorDelivery => ({
    processId: localIdOf(entry),
    executorId: entry.executorId,
    executorName: entry.executorName ?? null,
    projectId: entry.projectId,
    remoteServerId: entry.remoteServerId,
    branch: entry.branch,
    state,
    attempts: entry.attempts,
    reason: entry.reason,
    error: entry.error,
    nextAttemptAt: state === "retrying" ? entry.nextAttemptAt : null,
    firstSentAt: entry.firstSentAt,
    deadlineAt: entry.firstSentAt + DELIVERY_WINDOW_MS,
    mayHaveRun: entry.mayHaveRun,
  });

  const announce = (delivery: ExecutorDelivery) => {
    fastify.eventBus.emit({ type: "executor:delivery", projectId: delivery.projectId, delivery });
  };

  const ensureTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => tick(), DELIVERY_TICK_MS);
    ticker.unref?.();
  };

  /**
   * One delivery of the entry's request. Every attempt carries the same
   * processId and effect fingerprint: the worker either returns the process an
   * earlier attempt spawned or starts it now — exactly once either way.
   */
  const attempt = async (key: string, entry: PendingStart): Promise<RemoteStartOutcome> => {
    // Every send — first, timed, on reconnect, or the user's — passes here, so
    // this is the one check on whether re-sending is still safe.
    if (isExpired(entry, Date.now())) {
      giveUp(key, entry);
      return { kind: "gave_up" };
    }
    entry.inFlight = true;
    entry.attempts++;
    try {
      const result = await proxyToRemoteAuto(
        entry.remoteServerId,
        "POST",
        "/api/path/execute",
        { ...entry.body, processId: entry.processId, effectFingerprint: entry.effectFingerprint },
        { reverseConnectManager: fastify.reverseConnectManager },
      );
      if (result.ok) {
        pending.delete(key);
        const remoteProcessId = (result.data as { processId: string }).processId;
        return { kind: "started", processId: await register(entry, remoteProcessId) };
      }
      if (isTransportFailure(result)) {
        entry.reason = classifyFailure(result);
        if (!result.notSent) entry.mayHaveRun = true;
        entry.error = (result.data as { error?: string } | null)?.error ?? "Remote server unreachable";
        // The request may have reached the worker. Without dedupe a retry could
        // run it twice, so such workers get no retry: the start is forgotten.
        if (!(await supportsIdempotentExecute(entry.remoteServerId))) {
          pending.delete(key);
          return { kind: "unknown", error: entry.error, reason: entry.reason, retrying: false };
        }
        entry.nextAttemptAt = Date.now() + DELIVERY_RETRY_INTERVAL_MS;
        entry.announced = true;
        announce(deliveryOf(entry, "retrying"));
        ensureTicker();
        return {
          kind: "unknown", error: entry.error, reason: entry.reason, retrying: true,
          deadlineAt: entry.firstSentAt + DELIVERY_WINDOW_MS,
        };
      }
      pending.delete(key);
      if (entry.announced) {
        entry.error = (result.data as { error?: string } | null)?.error ?? `Remote start failed (HTTP ${result.status})`;
        announce(deliveryOf(entry, "rejected"));
      }
      return { kind: "rejected", result };
    } finally {
      entry.inFlight = false;
    }
  };

  const start = async (request: RemoteStartRequest): Promise<RemoteStartOutcome> => {
    // Everything up to the first await runs as one synchronous block, so two
    // overlapping requests cannot both pass these checks.
    for (const [localProcessId, info] of fastify.remoteExecutorMap) {
      if (info.executorId === request.executorId && info.remoteServerId === request.remoteServerId) {
        if (request.processId && info.remoteProcessId === request.processId) return { kind: "started", processId: localProcessId };
        return { kind: "already_running", processId: localProcessId };
      }
    }
    const key = `${request.executorId}:${request.remoteServerId}`;
    let entry = pending.get(key);
    if (request.retryOnly && (!entry || entry.processId !== request.processId)) return { kind: "retry_ended" };
    if (entry?.inFlight) return { kind: "starting" };
    if (entry && request.processId && entry.processId !== request.processId) return { kind: "starting" };
    if (!entry) {
      gaveUp.delete(key);
      entry = {
        ...request,
        processId: request.processId ?? randomUUID(),
        effectFingerprint: createHash("sha256")
          .update(JSON.stringify({ executorId: request.executorId, remoteServerId: request.remoteServerId, body: request.body }))
          .digest("hex"),
        inFlight: false,
        attempts: 0,
        firstSentAt: Date.now(),
        nextAttemptAt: null,
        reason: null,
        error: null,
        announced: false,
        mayHaveRun: false,
      };
      pending.set(key, entry);
    }
    // A retry of an unconfirmed start reuses the stored identity and body.
    return attempt(key, entry);
  };

  /**
   * Past the window, re-sending is no longer known to be safe: the worker may
   * have forgotten a run the start did. (A worker restart forgets it sooner;
   * that residual risk is accepted — see the design doc.)
   */
  const isExpired = (entry: PendingStart, now: number): boolean => now >= entry.firstSentAt + DELIVERY_WINDOW_MS;

  const giveUp = (key: string, entry: PendingStart) => {
    pending.delete(key);
    const delivery = deliveryOf(entry, "gave_up");
    gaveUp.set(key, delivery);
    console.warn(`[RemoteExecutorStarts] gave up delivering start: executor=${entry.executorId} target=${entry.remoteServerId} process=${entry.processId} attempts=${entry.attempts} after ${Math.round((Date.now() - entry.firstSentAt) / 60_000)} min (${entry.error})`);
    announce(delivery);
  };

  const redeliver = (key: string, entry: PendingStart) => {
    attempt(key, entry).catch((error) => {
      console.error(`[RemoteExecutorStarts] delivery attempt failed for ${entry.processId}:`, error);
    });
  };

  /**
   * Re-deliver due starts, give up on those past the window. A due start whose
   * worker is offline waits for the reconnect, which delivers it at once.
   */
  const tick = (now = Date.now()) => {
    for (const [key, entry] of pending) {
      if (entry.inFlight) continue;
      // Past the window it is given up even while the worker is offline;
      // anything else is decided by the attempt itself.
      if (isExpired(entry, now)) {
        giveUp(key, entry);
        continue;
      }
      if (entry.nextAttemptAt !== null && now < entry.nextAttemptAt) continue;
      if (!fastify.reverseConnectManager.isConnected(entry.remoteServerId)) {
        if (entry.nextAttemptAt !== null) {
          entry.nextAttemptAt = null;
          entry.reason = "offline";
          announce(deliveryOf(entry, "retrying"));
        }
        continue;
      }
      // Due, or waiting on a reconnect whose event this start missed.
      redeliver(key, entry);
    }
    for (const [key, delivery] of gaveUp) {
      if (now >= delivery.deadlineAt + GAVE_UP_RETENTION_MS) gaveUp.delete(key);
    }
    if (pending.size === 0 && gaveUp.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  /** A freshly connected tunnel is the best moment to deliver: try every start bound for it now. */
  const onReconnect = (remoteServerId: string) => {
    for (const [key, entry] of pending) {
      if (entry.remoteServerId !== remoteServerId || entry.inFlight) continue;
      redeliver(key, entry);
    }
  };

  /** Starts still being delivered or given up on, for a project's UI. */
  const list = (projectId: string): ExecutorDelivery[] => [
    ...[...pending.values()].filter((entry) => entry.projectId === projectId && entry.announced).map((entry) => deliveryOf(entry, "retrying")),
    ...[...gaveUp.values()].filter((delivery) => delivery.projectId === projectId),
  ];

  /** Whether the hub is still delivering the start that would run as this local process id. */
  const isRetrying = (localProcessId: string): boolean => {
    for (const entry of pending.values()) if (localIdOf(entry) === localProcessId) return true;
    return false;
  };

  fastify.reverseConnectManager.setStatusChangeHandler((_remoteServerId, status) => {
    if (status !== "online") return;
    // Like RemoteExecutorMonitor: ask the manager which targets are routable
    // rather than trusting the event's id, so aliased targets resume too.
    const servers = new Set([...pending.values()].map((entry) => entry.remoteServerId));
    for (const serverId of servers) {
      if (fastify.reverseConnectManager.isConnected(serverId)) onReconnect(serverId);
    }
  });

  return { start, tick, list, isRetrying };
}

export type RemoteExecutorStarts = ReturnType<typeof createRemoteExecutorStarts>;
