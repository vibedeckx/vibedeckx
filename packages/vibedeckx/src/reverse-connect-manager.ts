import { randomUUID } from "crypto";
import type WebSocket from "ws";
import type { ControlFrame, HttpRequestFrame, HttpResponseFrame, WsOpenFrame, WsDataFrame, WsCloseFrame, PingFrame } from "./reverse-connect-types.js";
import type { VirtualWsAdapter } from "./virtual-ws-adapter.js";
import type { ProxyResult } from "./utils/remote-proxy.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: ProxyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReverseConnection {
  ws: WebSocket;
  pendingRequests: Map<string, PendingRequest>;
  virtualChannels: Map<string, VirtualWsAdapter>;
  pingTimer: ReturnType<typeof setInterval>;
  pongTimer: ReturnType<typeof setTimeout> | null;
  lastPong: number;
}

export class ReverseConnectManager {
  private connections = new Map<string, ReverseConnection>();
  private onStatusChange?: (remoteServerId: string, status: "online" | "offline") => void;

  setStatusChangeHandler(handler: (remoteServerId: string, status: "online" | "offline") => void): void {
    this.onStatusChange = handler;
  }

  registerConnection(remoteServerId: string, ws: WebSocket): void {
    // Last-writer-wins: close old connection if exists
    const existing = this.connections.get(remoteServerId);
    if (existing) {
      console.log(`[ReverseConnect] Replacing existing connection for ${remoteServerId}`);
      this.cleanupConnection(remoteServerId, existing);
    }

    const conn: ReverseConnection = {
      ws,
      pendingRequests: new Map(),
      virtualChannels: new Map(),
      pingTimer: setInterval(() => this.sendPing(remoteServerId), PING_INTERVAL_MS),
      pongTimer: null,
      lastPong: Date.now(),
    };

    this.connections.set(remoteServerId, conn);

    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as ControlFrame;
        this.handleFrame(remoteServerId, frame);
      } catch (err) {
        console.error(`[ReverseConnect] Failed to parse frame from ${remoteServerId}:`, err);
      }
    });

    ws.on("close", () => {
      console.log(`[ReverseConnect] Connection closed for ${remoteServerId}`);
      const c = this.connections.get(remoteServerId);
      if (c && c.ws === ws) {
        this.cleanupConnection(remoteServerId, c);
        this.connections.delete(remoteServerId);
        this.onStatusChange?.(remoteServerId, "offline");
      }
    });

    ws.on("error", (err) => {
      console.error(`[ReverseConnect] Connection error for ${remoteServerId}:`, err);
    });

    console.log(`[ReverseConnect] Registered connection for ${remoteServerId}`);
    this.onStatusChange?.(remoteServerId, "online");
  }

  unregisterConnection(remoteServerId: string): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn) return;
    this.cleanupConnection(remoteServerId, conn);
    this.connections.delete(remoteServerId);
  }

  isConnected(remoteServerId: string): boolean {
    const conn = this.connections.get(remoteServerId);
    return conn !== undefined && conn.ws.readyState === 1; // WebSocket.OPEN
  }

  async sendHttpRequest(
    remoteServerId: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  ): Promise<ProxyResult> {
    const conn = this.connections.get(remoteServerId);
    if (!conn || conn.ws.readyState !== 1) {
      return {
        ok: false,
        status: 0,
        data: { error: "Remote not connected" },
        errorCode: "network_error",
      };
    }

    const requestId = randomUUID();
    const frame: HttpRequestFrame = {
      type: "http_request",
      requestId,
      method,
      path,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    return new Promise<ProxyResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        resolve({
          ok: false,
          status: 0,
          data: { error: `Request timed out after ${timeoutMs}ms` },
          errorCode: "timeout",
        });
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, timer });
      conn.ws.send(JSON.stringify(frame));
    });
  }

  openVirtualChannel(remoteServerId: string, channelId: string, path: string, query?: string): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn || conn.ws.readyState !== 1) return;

    const frame: WsOpenFrame = { type: "ws_open", channelId, path, query };
    conn.ws.send(JSON.stringify(frame));
  }

  sendChannelData(remoteServerId: string, channelId: string, data: string): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn || conn.ws.readyState !== 1) return;

    const frame: WsDataFrame = { type: "ws_data", channelId, data };
    conn.ws.send(JSON.stringify(frame));
  }

  closeChannel(remoteServerId: string, channelId: string, code?: number, reason?: string): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn) return;

    conn.virtualChannels.delete(channelId);
    if (conn.ws.readyState === 1) {
      const frame: WsCloseFrame = { type: "ws_close", channelId, code, reason };
      conn.ws.send(JSON.stringify(frame));
    }
  }

  setChannelAdapter(remoteServerId: string, channelId: string, adapter: VirtualWsAdapter): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn) return;
    conn.virtualChannels.set(channelId, adapter);
  }

  shutdown(): void {
    for (const [id, conn] of this.connections) {
      this.cleanupConnection(id, conn);
    }
    this.connections.clear();
  }

  private handleFrame(remoteServerId: string, frame: ControlFrame): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn) return;

    switch (frame.type) {
      case "http_response": {
        const pending = conn.pendingRequests.get(frame.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          conn.pendingRequests.delete(frame.requestId);

          let data: unknown;
          try {
            data = frame.body ? JSON.parse(frame.body) : {};
          } catch {
            data = { rawBody: frame.body };
          }

          const ok = frame.status >= 200 && frame.status < 300;
          let errorCode: ProxyResult["errorCode"];
          if (!ok) {
            if (frame.status === 401) errorCode = "auth_error";
            else if (frame.status >= 500) errorCode = "server_error";
          }

          pending.resolve({
            ok,
            status: frame.status,
            data,
            errorCode,
          });
        }
        break;
      }
      case "ws_data": {
        const adapter = conn.virtualChannels.get(frame.channelId);
        if (adapter) {
          adapter.deliverMessage(frame.data);
        }
        break;
      }
      case "ws_close": {
        const adapter = conn.virtualChannels.get(frame.channelId);
        if (adapter) {
          adapter.deliverClose(frame.code, frame.reason);
          conn.virtualChannels.delete(frame.channelId);
        }
        break;
      }
      case "pong": {
        conn.lastPong = Date.now();
        if (conn.pongTimer) {
          clearTimeout(conn.pongTimer);
          conn.pongTimer = null;
        }
        break;
      }
      case "status": {
        console.log(`[ReverseConnect] Status from ${remoteServerId}: ready=${frame.ready}`);
        break;
      }
      default:
        // Ignore unknown frame types
        break;
    }
  }

  private sendPing(remoteServerId: string): void {
    const conn = this.connections.get(remoteServerId);
    if (!conn || conn.ws.readyState !== 1) return;

    const frame: PingFrame = { type: "ping", ts: Date.now() };
    conn.ws.send(JSON.stringify(frame));

    // Set pong timeout
    conn.pongTimer = setTimeout(() => {
      console.log(`[ReverseConnect] Pong timeout for ${remoteServerId}, closing connection`);
      conn.ws.close(1000, "Pong timeout");
    }, PONG_TIMEOUT_MS);
  }

  private cleanupConnection(remoteServerId: string, conn: ReverseConnection): void {
    clearInterval(conn.pingTimer);
    if (conn.pongTimer) clearTimeout(conn.pongTimer);

    // Reject all pending requests
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        status: 0,
        data: { error: "Remote connection closed" },
        errorCode: "network_error",
      });
    }
    conn.pendingRequests.clear();

    // Close all virtual channels
    for (const [, adapter] of conn.virtualChannels) {
      adapter.deliverClose(1001, "Control connection closed");
    }
    conn.virtualChannels.clear();

    // Close WebSocket if still open
    if (conn.ws.readyState === 0 || conn.ws.readyState === 1) {
      try { conn.ws.close(1000, "Cleanup"); } catch { /* ignore */ }
    }
  }
}
