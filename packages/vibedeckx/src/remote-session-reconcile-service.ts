import type { Storage } from "./storage/types.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { RemoteSessionInfo } from "./server-types.js";
import { listSearchTargets } from "./search/refresh.js";
import {
  reconcileRemoteSessions,
  type ReconcileSummary,
  type ReconcileTarget,
} from "./remote-session-reconcile.js";

/**
 * Scheduling shell around `reconcileRemoteSessions`
 * (docs/plans/2026-08-08-session-retention.md §3.1): enumerate this hub's
 * remote targets and run one bounded reconciliation round over them.
 *
 * On a machine with no remote servers every round is one empty target list —
 * there is no "am I a hub" branch, the work is simply zero.
 */

/** Long by design: a stale handle self-heals on click (the belt), so this is
 * only the backstop that catches handles nobody clicks. */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const RECONCILE_STARTUP_DELAY_MS = 120_000;

export interface RemoteSessionReconcilerDeps {
  storage: Storage;
  reverseConnectManager: ReverseConnectManager;
  remoteSessionMap: Map<string, RemoteSessionInfo>;
  remotePatchCache: RemotePatchCache;
  intervalMs?: number;
  startupDelayMs?: number;
}

export class RemoteSessionReconciler {
  private readonly deps: RemoteSessionReconcilerDeps;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private inFlight: Promise<ReconcileSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(deps: RemoteSessionReconcilerDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
    this.startupDelayMs = deps.startupDelayMs ?? RECONCILE_STARTUP_DELAY_MS;
  }

  start(): void {
    if (this.closed) return;
    this.startupTimer = setTimeout(() => { void this.run(); }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.run(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
  }

  /** Single-flight round; a caller arriving mid-round joins it. */
  run(): Promise<ReconcileSummary> {
    if (this.inFlight) return this.inFlight;
    const round = this.runOnce()
      .catch((error): ReconcileSummary => {
        console.error("[RemoteSessionReconcile] round failed:", error);
        return { targetsChecked: 0, targetsSkipped: 0, forgotten: 0 };
      })
      .finally(() => { this.inFlight = null; });
    this.inFlight = round;
    return round;
  }

  private async runOnce(): Promise<ReconcileSummary> {
    // No userId filter: this is server maintenance over every mapping the hub
    // holds, not a user-facing listing.
    const targets: ReconcileTarget[] = (await listSearchTargets(this.deps.storage))
      .flatMap((t) => (t.remote
        ? [{ projectId: t.projectId, remoteServerId: t.remote.serverId, remotePath: t.remote.remotePath }]
        : []));
    if (targets.length === 0) {
      return { targetsChecked: 0, targetsSkipped: 0, forgotten: 0 };
    }
    const summary = await reconcileRemoteSessions({
      storage: this.deps.storage,
      reverseConnectManager: this.deps.reverseConnectManager,
      remoteSessionMap: this.deps.remoteSessionMap,
      remotePatchCache: this.deps.remotePatchCache,
    }, targets);
    if (summary.forgotten > 0) {
      console.log(
        `[RemoteSessionReconcile] forgot ${summary.forgotten} mapping(s) deleted on their worker `
        + `(checked ${summary.targetsChecked}, skipped ${summary.targetsSkipped})`,
      );
    }
    return summary;
  }
}
