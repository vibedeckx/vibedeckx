/**
 * Hub memory observability (step 1 of bounding RemotePatchCache).
 *
 * The patch cache grows for every remote agent session ever opened and is only
 * released when the session is deleted or reconciled away — no size cap, no
 * TTL. Before choosing a per-session budget or a global LRU ceiling we need the
 * real curve, so this module exposes one snapshot in two places: an
 * operator-only HTTP endpoint for a point read, and a periodic structured log
 * line so the curve exists in the rotating logs after the fact without any
 * external scraper.
 *
 * Aggregate-only by construction: nothing here can name a session, a server or
 * a user, because the endpoint it feeds spans tenants.
 */

import { getLogger } from "./logger.js";
import type { ProcessManager, ProcessLogBufferStats } from "./process-manager.js";
import type { RemotePatchCache, RemotePatchCacheStats } from "./remote-patch-cache.js";

const REPORT_INTERVAL_MS = 5 * 60 * 1000;

export interface MemoryStatsDeps {
  remotePatchCache: RemotePatchCache;
  processManager: ProcessManager;
}

export interface MemoryStatsSnapshot {
  process: {
    rss: number;
    heap_used: number;
    heap_total: number;
    external: number;
    array_buffers: number;
    uptime_s: number;
  };
  patch_cache: RemotePatchCacheStats;
  process_manager: ProcessLogBufferStats;
}

export function collectMemoryStats(deps: MemoryStatsDeps): MemoryStatsSnapshot {
  const mem = process.memoryUsage();
  return {
    process: {
      rss: mem.rss,
      heap_used: mem.heapUsed,
      heap_total: mem.heapTotal,
      external: mem.external,
      array_buffers: mem.arrayBuffers,
      uptime_s: Math.round(process.uptime()),
    },
    patch_cache: deps.remotePatchCache.stats(),
    process_manager: deps.processManager.logBufferStats(),
  };
}

/**
 * Emits one structured log line per interval. Cheap enough to leave on
 * everywhere: the walk is over cached entry counts, not their contents, and it
 * runs twelve times an hour.
 */
export class MemoryStatsReporter {
  private readonly deps: MemoryStatsDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: MemoryStatsDeps, opts?: { intervalMs?: number }) {
    this.deps = deps;
    this.intervalMs = opts?.intervalMs ?? REPORT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => this.report(), this.intervalMs);
    // Observability must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for a one-shot read at startup. */
  report(): MemoryStatsSnapshot {
    const snapshot = collectMemoryStats(this.deps);
    try {
      getLogger().child({ mod: "memory-stats" }).info(snapshot, "memory stats");
    } catch (error) {
      // A logging failure must not kill the timer — the next tick retries.
      console.warn("[MemoryStats] Failed to emit stats:", error);
    }
    return snapshot;
  }
}
