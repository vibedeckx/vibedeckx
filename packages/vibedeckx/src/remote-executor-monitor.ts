import { randomUUID } from "crypto";
import WsWebSocket from "ws";
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
  /** localProcessId → cleanup function */
  private monitors = new Map<string, () => void>();

  constructor(
    private readonly reverseConnectManager: ReverseConnectManager,
    private readonly eventBus: EventBus,
    private readonly storage: Storage,
    private readonly remoteExecutorMap: Map<string, RemoteExecutorInfo>,
  ) {}

  watch(localProcessId: string, remoteInfo: RemoteExecutorInfo): void {
    // Idempotent — also avoids a second connection when the on-demand log proxy
    // is already attached.
    if (this.monitors.has(localProcessId)) return;

    let remoteWs: WsWebSocket | VirtualWsAdapter;
    const rcm = this.reverseConnectManager;
    const useVirtual = rcm.isConnected(remoteInfo.remoteServerId);

    if (useVirtual) {
      const channelId = randomUUID();
      const wsPath = `/api/executor-processes/${remoteInfo.remoteProcessId}/logs`;
      const wsQuery = `apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      const adapter = new VirtualWsAdapter(
        (data) => rcm.sendChannelData(remoteInfo.remoteServerId, channelId, data),
        () => rcm.closeChannel(remoteInfo.remoteServerId, channelId),
      );
      rcm.setChannelAdapter(remoteInfo.remoteServerId, channelId, adapter);
      rcm.openVirtualChannel(remoteInfo.remoteServerId, channelId, wsPath, wsQuery);
      remoteWs = adapter;
      setTimeout(() => adapter.emit("open"), 0);
    } else {
      if (!remoteInfo.remoteUrl) {
        console.log(`[RemoteExecutorMonitor] no direct URL for ${localProcessId}, skipping`);
        return;
      }
      const cleanRemoteUrl = remoteInfo.remoteUrl.replace(/\/+$/, "");
      const wsProtocol = cleanRemoteUrl.startsWith("https") ? "wss" : "ws";
      const wsUrl = cleanRemoteUrl.replace(/^https?/, wsProtocol);
      const remoteWsUrl = `${wsUrl}/api/executor-processes/${remoteInfo.remoteProcessId}/logs?apiKey=${encodeURIComponent(remoteInfo.remoteApiKey)}`;
      remoteWs = new WsWebSocket(remoteWsUrl);
    }

    const cleanup = () => {
      this.monitors.delete(localProcessId);
      try { remoteWs.close(); } catch { /* already closed */ }
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
          const info = this.remoteExecutorMap.get(localProcessId);
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
              exitCode: parsed.exitCode ?? 0,
              target: info.remoteServerId,
              tailOutput,
            });
          }
          this.remoteExecutorMap.delete(localProcessId);
          // Soft-delete: keep the DB row so "Last run" + post-finish log replay
          // survive past the process's lifecycle.
          this.storage.remoteExecutorProcesses.markFinished(
            localProcessId,
            typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
          );
          cleanup();
        }
      } catch { /* ignore parse errors */ }
    });

    remoteWs.on("close", () => { cleanup(); });

    remoteWs.on("error", (error) => {
      console.error(`[RemoteExecutorMonitor] error for ${localProcessId}:`, error);
      cleanup();
    });

    this.monitors.set(localProcessId, cleanup);
    console.log(`[RemoteExecutorMonitor] watching ${localProcessId}`);
  }

  unwatch(localProcessId: string): void {
    this.monitors.get(localProcessId)?.();
  }

  shutdown(): void {
    for (const cleanup of this.monitors.values()) cleanup();
    this.monitors.clear();
  }
}
