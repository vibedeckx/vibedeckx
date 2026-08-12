import { randomUUID } from "crypto";
import type { Storage } from "./storage/types.js";
import type { EventBus } from "./event-bus.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import type { RemoteExecutorInfo } from "./server-types.js";

/**
 * Watches remote executor processes for completion INDEPENDENTLY of any
 * frontend log-proxy subscription.
 *
 * Without this, a remote executor's `executor:stopped` is only emitted when
 * `attachRemoteProcessStream` (the on-demand log proxy) happens to be connected
 * at the moment the remote process finishes. If the user navigated to another
 * project, that proxy is torn down — so the finish goes unobserved:
 * `remoteExecutorMap` is never cleared, `/api/executor-processes/running` keeps
 * reporting the process, and the UI Stop button stays red forever.
 *
 * One monitor connection per remote process, kept alive for the process's
 * lifetime. Coexists safely with an active log proxy: the `stoppedEmitted` flag
 * on the shared RemoteExecutorInfo dedupes `executor:stopped`, and
 * `remoteExecutorMap.delete` is idempotent.
 *
 * Extracted from ChatSessionManager.monitorRemoteExecutor so every
 * `remoteExecutorMap.set` site (panel start, boot recovery, chat) can share one
 * registry + one dedupe guard.
 */
export class RemoteExecutorMonitor {
  /**
   * Processes that still need a terminal observation.  This registry is
   * deliberately separate from the currently-open virtual channels: a control
   * connection can disappear while the remote process keeps running.
   */
  private watched = new Map<string, RemoteExecutorInfo>();

  /** localProcessId → cleanup for the currently-open virtual channel */
  private activeMonitors = new Map<string, () => void>();

  constructor(
    private readonly reverseConnectManager: ReverseConnectManager,
    private readonly eventBus: EventBus,
    private readonly storage: Storage,
    private readonly remoteExecutorMap: Map<string, RemoteExecutorInfo>,
  ) {
    // A reverse-connect outage closes every virtual channel.  Keep the watch
    // intent above and re-open those channels when the worker reconnects so a
    // `finished` frame produced during the outage is replayed from the worker's
    // ProcessManager buffer.
    this.reverseConnectManager.setStatusChangeHandler((_remoteServerId, status) => {
      if (status !== "online") return;
      for (const [localProcessId, info] of this.watched) {
        // Ask the manager instead of comparing the online event's server id:
        // this resumes every currently-routable watch, including aliases that
        // were already registered before this transition.
        if (this.reverseConnectManager.isConnected(info.remoteServerId)) {
          this.attach(localProcessId, info);
        }
      }
    });
  }

  watch(localProcessId: string, remoteInfo: RemoteExecutorInfo): void {
    this.watched.set(localProcessId, remoteInfo);
    this.attach(localProcessId, remoteInfo);
  }

  private attach(localProcessId: string, remoteInfo: RemoteExecutorInfo): void {
    // Idempotent for the active transport.  The durable watch intent remains in
    // `watched` until a real terminal frame arrives or the caller unwatches it.
    if (this.activeMonitors.has(localProcessId)) return;

    const rcm = this.reverseConnectManager;
    if (!rcm.isConnected(remoteInfo.remoteServerId)) {
      console.log(`[RemoteExecutorMonitor] remote ${remoteInfo.remoteServerId} not connected for ${localProcessId}, deferring`);
      return;
    }

    const channelId = randomUUID();
    const wsPath = `/api/executor-processes/${remoteInfo.remoteProcessId}/logs`;
    const adapter = new VirtualWsAdapter(
      (data) => rcm.sendChannelData(remoteInfo.remoteServerId, channelId, data),
      () => rcm.closeChannel(remoteInfo.remoteServerId, channelId),
    );
    rcm.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
    rcm.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath);
    const remoteWs: VirtualWsAdapter = adapter;
    setTimeout(() => adapter.emit("open"), 0);

    let cleanedUp = false;
    const cleanupActive = (closeChannel: boolean) => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.activeMonitors.delete(localProcessId);
      if (closeChannel) {
        try { remoteWs.close(); } catch { /* already closed */ }
      }
    };

    // Collect output so the executor:stopped event can carry a tail (mirrors the
    // log proxy / local ProcessManager behavior).
    const outputChunks: string[] = [];

    remoteWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if ((parsed.type === "pty" || parsed.type === "stdout" || parsed.type === "stderr") && parsed.data) {
          outputChunks.push(parsed.data);
        }
        if (parsed.type === "finished") {
          this.watched.delete(localProcessId);
          const info = this.remoteExecutorMap.get(localProcessId);
          // A worker that restarted or already purged its in-memory process
          // buffer answers with `finished(exitCode: null)`.  That proves only
          // that the process is gone, not that it succeeded.  Event consumers
          // require a numeric code, so report failure while persisting the more
          // precise `killed` terminal state below.
          const hasKnownExitCode = typeof parsed.exitCode === "number";
          const eventExitCode = hasKnownExitCode ? parsed.exitCode : 1;
          if (info && !info.stoppedEmitted) {
            info.stoppedEmitted = true;
            let raw = outputChunks.join("");
            raw = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
            const tailOutput = raw.length > 10000 ? raw.slice(-10000) : raw;
            this.eventBus.emit({
              type: "executor:stopped",
              projectId: info.projectId ?? "",
              executorId: info.executorId,
              processId: localProcessId,
              exitCode: eventExitCode,
              target: info.remoteServerId,
              tailOutput,
              // Structured final message forwarded by the remote's finished
              // LogMessage; absent when the remote runs an older version.
              finalResult: typeof parsed.finalResult === "string" ? parsed.finalResult : undefined,
            });
          }
          this.remoteExecutorMap.delete(localProcessId);
          // Soft-delete: keep the DB row so "Last run" + post-finish log replay
          // survive past the process's lifecycle.
          const markFinished = hasKnownExitCode
            ? this.storage.remoteExecutorProcesses.markFinished(localProcessId, parsed.exitCode)
            : this.storage.remoteExecutorProcesses.markFinished(localProcessId, undefined, "killed");
          markFinished.catch((err) => {
            console.error(`[RemoteExecutorMonitor] Failed to mark process ${localProcessId} finished:`, err);
          });
          cleanupActive(true);
        }
      } catch { /* ignore parse errors */ }
    });

    // Transport close is not process completion.  Drop only the active channel;
    // the watch intent stays registered and will reconnect on the next online
    // status notification.
    remoteWs.on("close", () => { cleanupActive(false); });

    remoteWs.on("error", (error) => {
      console.error(`[RemoteExecutorMonitor] error for ${localProcessId}:`, error);
      cleanupActive(true);
    });

    this.activeMonitors.set(localProcessId, () => cleanupActive(true));
    console.log(`[RemoteExecutorMonitor] watching ${localProcessId}`);
  }

  unwatch(localProcessId: string): void {
    this.watched.delete(localProcessId);
    this.activeMonitors.get(localProcessId)?.();
  }

  shutdown(): void {
    this.watched.clear();
    for (const cleanup of [...this.activeMonitors.values()]) cleanup();
    this.activeMonitors.clear();
  }
}
