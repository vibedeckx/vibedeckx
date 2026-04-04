import WebSocket from "ws";
import type { ControlFrame, HttpRequestFrame, WsOpenFrame, WsCloseFrame, PingFrame, HttpResponseFrame, PongFrame, StatusFrame, WsDataFrame } from "./reverse-connect-types.js";
import type { FastifyInstance } from "fastify";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const NO_PING_TIMEOUT_MS = 60_000;

export class ReverseConnectClient {
  private ws: WebSocket | null = null;
  private localServer: FastifyInstance;
  private serverUrl: string;
  private token: string;
  private localPort: number;
  private localChannels = new Map<string, WebSocket>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noPingTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(localServer: FastifyInstance, serverUrl: string, token: string, localPort: number) {
    this.localServer = localServer;
    this.serverUrl = serverUrl;
    this.token = token;
    this.localPort = localPort;
  }

  connect(): void {
    if (this.shuttingDown) return;

    const cleanUrl = this.serverUrl.replace(/\/+$/, "");
    const wsProtocol = cleanUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = cleanUrl.replace(/^https?/, wsProtocol);
    const connectUrl = `${wsUrl}/api/reverse-connect?token=${encodeURIComponent(this.token)}`;

    console.log(`[ReverseClient] Connecting to ${cleanUrl}...`);

    this.ws = new WebSocket(connectUrl, {
      maxPayload: 11 * 1024 * 1024,
    });

    this.ws.on("open", () => {
      console.log("[ReverseClient] Connected to server");
      this.reconnectAttempt = 0;
      this.resetNoPingTimer();

      // Send status ready
      const frame: StatusFrame = { type: "status", ready: true };
      this.ws!.send(JSON.stringify(frame));
    });

    this.ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as ControlFrame;
        this.handleFrame(frame);
      } catch (err) {
        console.error("[ReverseClient] Failed to parse frame:", err);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[ReverseClient] Disconnected (code=${code}, reason=${reason?.toString() || ""})`);
      this.clearNoPingTimer();
      this.closeAllLocalChannels();
      this.ws = null;

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      console.error("[ReverseClient] WebSocket error:", err.message);
    });
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.clearNoPingTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeAllLocalChannels();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000, "Shutdown");
    }
    this.ws = null;
  }

  private async handleFrame(frame: ControlFrame): Promise<void> {
    switch (frame.type) {
      case "http_request":
        await this.handleHttpRequest(frame);
        break;
      case "ws_open":
        this.handleWsOpen(frame);
        break;
      case "ws_data":
        this.handleWsData(frame);
        break;
      case "ws_close":
        this.handleWsClose(frame);
        break;
      case "ping":
        this.handlePing(frame);
        break;
      default:
        break;
    }
  }

  private async handleHttpRequest(frame: HttpRequestFrame): Promise<void> {
    try {
      let status: number;
      let responseHeaders: Record<string, string> = {};
      let body: string;

      if (frame.port) {
        // Direct fetch to localhost:{port} — used by browser proxy to reach dev servers
        const url = `http://127.0.0.1:${frame.port}${frame.path}`;
        const fetchInit: RequestInit = {
          method: frame.method,
          headers: frame.headers,
          redirect: "follow",
        };
        if (frame.body && frame.method !== "GET" && frame.method !== "HEAD") {
          fetchInit.body = frame.body;
        }
        const response = await fetch(url, fetchInit);
        status = response.status;
        response.headers.forEach((val, key) => {
          responseHeaders[key] = val;
        });
        body = await response.text();
      } else {
        // Route through Fastify server — used for API proxy
        const response = await (this.localServer.inject as Function)({
          method: frame.method,
          url: frame.path,
          headers: frame.headers,
          payload: frame.body,
        }) as { statusCode: number; headers: Record<string, string | string[] | undefined>; payload: string };

        status = response.statusCode;
        for (const [key, val] of Object.entries(response.headers)) {
          if (typeof val === "string") {
            responseHeaders[key] = val;
          } else if (Array.isArray(val)) {
            responseHeaders[key] = val.join(", ");
          }
        }
        body = response.payload;
      }

      const responseFrame: HttpResponseFrame = {
        type: "http_response",
        requestId: frame.requestId,
        status,
        headers: responseHeaders,
        body,
      };

      this.sendFrame(responseFrame);
    } catch (err) {
      console.error(`[ReverseClient] request error for ${frame.requestId}:`, err);
      const errorFrame: HttpResponseFrame = {
        type: "http_response",
        requestId: frame.requestId,
        status: 502,
        headers: {},
        body: JSON.stringify({ error: err instanceof Error ? err.message : "Request failed" }),
      };
      this.sendFrame(errorFrame);
    }
  }

  private handleWsOpen(frame: WsOpenFrame): void {
    const wsUrl = `ws://127.0.0.1:${this.localPort}${frame.path}${frame.query ? `?${frame.query}` : ""}`;
    console.log(`[ReverseClient] Opening local WS channel ${frame.channelId} → ${frame.path}`);

    const localWs = new WebSocket(wsUrl);

    localWs.on("open", () => {
      this.localChannels.set(frame.channelId, localWs);
    });

    localWs.on("message", (data) => {
      const dataFrame: WsDataFrame = {
        type: "ws_data",
        channelId: frame.channelId,
        data: data.toString(),
      };
      this.sendFrame(dataFrame);
    });

    localWs.on("close", (code, reason) => {
      this.localChannels.delete(frame.channelId);
      const closeFrame: WsCloseFrame = {
        type: "ws_close",
        channelId: frame.channelId,
        code,
        reason: reason?.toString(),
      };
      this.sendFrame(closeFrame);
    });

    localWs.on("error", (err) => {
      console.error(`[ReverseClient] Local WS error for channel ${frame.channelId}:`, err.message);
      this.localChannels.delete(frame.channelId);
      const closeFrame: WsCloseFrame = {
        type: "ws_close",
        channelId: frame.channelId,
        code: 1011,
        reason: "Local WebSocket error",
      };
      this.sendFrame(closeFrame);
    });
  }

  private handleWsData(frame: WsDataFrame): void {
    const localWs = this.localChannels.get(frame.channelId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(frame.data);
    }
  }

  private handleWsClose(frame: WsCloseFrame): void {
    const localWs = this.localChannels.get(frame.channelId);
    if (localWs) {
      localWs.close(frame.code, frame.reason);
      this.localChannels.delete(frame.channelId);
    }
  }

  private handlePing(frame: PingFrame): void {
    this.resetNoPingTimer();
    const pong: PongFrame = { type: "pong", ts: frame.ts };
    this.sendFrame(pong);
  }

  private sendFrame(frame: ControlFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY_MS
    );
    const jitter = delay * Math.random() * 0.25;
    const totalDelay = delay + jitter;

    this.reconnectAttempt++;
    console.log(`[ReverseClient] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, totalDelay);
  }

  private resetNoPingTimer(): void {
    this.clearNoPingTimer();
    this.noPingTimer = setTimeout(() => {
      console.log("[ReverseClient] No ping received in 60s, reconnecting...");
      if (this.ws) {
        this.ws.close(1000, "No ping timeout");
      }
    }, NO_PING_TIMEOUT_MS);
  }

  private clearNoPingTimer(): void {
    if (this.noPingTimer) {
      clearTimeout(this.noPingTimer);
      this.noPingTimer = null;
    }
  }

  private closeAllLocalChannels(): void {
    for (const [id, ws] of this.localChannels) {
      try { ws.close(1001, "Control connection closed"); } catch { /* ignore */ }
      this.localChannels.delete(id);
    }
  }
}
