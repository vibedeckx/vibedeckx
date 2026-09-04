import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey, createPublicKey, type KeyObject } from "crypto";
import type { ControlFrame, HttpRequestFrame, WsOpenFrame, WsCloseFrame, PingFrame, HttpResponseFrame, PongFrame, StatusFrame, WsDataFrame, MachineChallengeFrame, MachineAuthFrame } from "./reverse-connect-types.js";
import type { FastifyInstance } from "fastify";
import { redactErrorSecret, redactSecretForms } from "./secret-redaction.js";
import { readPackageVersion } from "./utils/package-version.js";
import { WORKER_CAPABILITY_KEYS } from "./reverse-connect-capabilities.js";

// Settings key under which the remote node persists its stable Ed25519 private
// key (PKCS8 PEM). This key is the machine's cryptographic identity, recognized
// by the hub across remote_servers record recreation.
const MACHINE_KEY_SETTING = "reverse_machine_private_key";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * How long to wait for a hub ping before assuming the tunnel is dead.
 *
 * The hub pings every 30s (PING_INTERVAL_MS in reverse-connect-manager), so
 * this allows 10s of scheduling jitter on top of one interval. It does not ride
 * out a fully missed ping — neither did the previous 60s, which sat exactly on
 * the two-interval boundary and so raced the next ping anyway.
 *
 * This is the dominant term in user-visible recovery after a hub restart: when
 * the hub dies without a clean close reaching the worker — killed container, a
 * proxy in between — the worker notices only when this fires, and until then
 * the browser re-subscribes to a hub whose tunnel is still down.
 *
 * The cost of lowering it is that a hub event-loop stall longer than the slack
 * disconnects every worker at once. 10s of stall would already be pathological,
 * but if that ever shows up as a reconnect storm, this is the knob.
 */
const NO_PING_TIMEOUT_MS = 40_000;

/**
 * How long a dial may sit without completing the WebSocket handshake.
 *
 * `ws` installs no handshake timeout of its own. When the dial is swallowed by
 * something that completes the TCP handshake and then never speaks — a CDN edge
 * or tunnel daemon whose origin is down — the socket stays in CONNECTING
 * forever: no `open`, no `error`, no `close`. None of the recovery paths below
 * are armed in that state, so the worker goes permanently silent while its
 * process, timers and logs all look healthy (observed in the field: six days).
 *
 * ws implements this as an inactivity timeout on the upgrade request and clears
 * it once the socket is upgraded, so it cannot fire on an idle live tunnel.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** How often the supervisor re-evaluates the connection against the wall clock. */
const SUPERVISOR_INTERVAL_MS = 10_000;

/**
 * Supervisor backstop for a stuck dial. Deliberately longer than
 * HANDSHAKE_TIMEOUT_MS, which is the primary defence: this only fires if ws's
 * own timeout somehow did not.
 */
const DIAL_TIMEOUT_MS = 25_000;

/**
 * How long a socket may sit in CLOSING. A graceful close() waits for the peer's
 * close frame, and the peer not answering is exactly the failure we are
 * recovering from, so the teardown itself needs a deadline.
 */
const CLOSING_TIMEOUT_MS = 10_000;

// The hub accepts the WebSocket upgrade and only *then* closes with one of these
// when it rejects the connect token or the machine identity. So `open` firing
// proves nothing — a rejected client would otherwise clear its backoff on every
// attempt and retry at ~1Hz forever.
const AUTH_REJECT_CODES = new Set([4001, 4003]);

// How long a socket must stay open before we treat it as a working tunnel and
// clear the backoff. Guards against tight loops where the connection is torn
// down immediately after the upgrade (auth rejection, a proxy in between).
const HEALTHY_CONNECTION_MS = 5000;

// Whether a response body of this content-type is safe to carry as a plain UTF-8
// string through the control channel. Anything else (octet-stream, images, etc.)
// is sent as base64 to avoid corrupting the bytes. An empty content-type defaults
// to textual to preserve existing behavior for JSON API responses.
function isTextualContentType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  if (t === "") return true;
  return (
    t.startsWith("text/") ||
    t.includes("application/json") ||
    t.includes("application/javascript") ||
    t.includes("application/xml") ||
    t.includes("+json") ||
    t.includes("+xml") ||
    t.includes("image/svg")
  );
}

export class ReverseConnectClient {
  private ws: WebSocket | null = null;
  private localServer: FastifyInstance;
  private serverUrl: string;
  private token: string;
  private localPort: number;
  private localChannels = new Map<string, WebSocket>();
  private reconnectAttempt = 0;
  private openedAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private supervisorTimer: ReturnType<typeof setInterval> | null = null;
  /** When the current dial started — the CONNECTING watchdog's reference point. */
  private dialStartedAt = 0;
  /** Last time the hub said anything on the control socket (a superset of pings). */
  private lastFrameAt = 0;
  /** First tick that observed CLOSING, so a stalled teardown can be forced. */
  private closingSince = 0;
  private shuttingDown = false;

  constructor(localServer: FastifyInstance, serverUrl: string, token: string, localPort: number) {
    this.localServer = localServer;
    this.serverUrl = serverUrl;
    this.token = token;
    this.localPort = localPort;
  }

  connect(): void {
    if (this.shuttingDown) return;

    // The supervisor is the one recovery path that cannot be starved. Every
    // other one is armed by an event — `open`/`ping` arm the liveness check,
    // `close` schedules the reconnect — and a socket stuck in CONNECTING fires
    // none of them. Started here, stopped only by shutdown().
    this.startSupervisor();

    if (this.ws) {
      // Shouldn't happen: every teardown path clears this first. If it ever
      // does, dropping the old socket beats leaking a second silent one.
      console.warn("[ReverseClient] connect() called with a live socket — discarding the old one");
      const stale = this.ws;
      this.ws = null;
      try { stale.terminate(); } catch { /* already gone */ }
    }

    const cleanUrl = this.serverUrl.replace(/\/+$/, "");
    const wsProtocol = cleanUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = cleanUrl.replace(/^https?/, wsProtocol);
    const connectUrl = `${wsUrl}/api/reverse-connect?token=${encodeURIComponent(this.token)}`;

    console.log(`[ReverseClient] Connecting to ${cleanUrl}...`);

    this.dialStartedAt = Date.now();
    this.closingSince = 0;

    const ws = new WebSocket(connectUrl, {
      maxPayload: 11 * 1024 * 1024,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      // Deliberately not "Connected": the hub can still reject us after the
      // upgrade. Backoff is cleared on disconnect, once we know the connection
      // actually lasted.
      console.log("[ReverseClient] Socket open, awaiting server handshake");
      this.openedAt = Date.now();
      this.lastFrameAt = Date.now();

      // Send status ready. version/capabilities also ride machine_auth (the
      // reliable carrier — this frame can beat the hub's handshake listener).
      const frame: StatusFrame = {
        type: "status",
        ready: true,
        version: readPackageVersion(),
        capabilities: WORKER_CAPABILITY_KEYS,
      };
      ws.send(JSON.stringify(frame));
    });

    ws.on("message", (data) => {
      // Any frame proves the hub is alive, so this is a superset of "last ping"
      // and is what the liveness check measures against.
      this.lastFrameAt = Date.now();
      try {
        const frame = JSON.parse(data.toString()) as ControlFrame;
        this.handleFrame(frame);
      } catch (err) {
        console.error("[ReverseClient] Failed to parse frame:", err);
      }
    });

    ws.on("close", (code, reason) => {
      const safeReason = redactSecretForms(reason?.toString() || "", this.token);
      this.handleDisconnect(ws, `code=${code}, reason=${safeReason}`, code);
    });

    ws.on("error", (err) => {
      // A socket we already gave up on emits one of these from terminate(). The
      // supervisor has already logged why, so don't dress it up as news.
      if (ws !== this.ws) return;
      console.error(
        "[ReverseClient] WebSocket error:",
        redactErrorSecret(err, this.token),
      );
      // No reconnect is scheduled here: `close` follows an error, and if it ever
      // doesn't, the supervisor picks the socket up.
    });
  }

  /**
   * The single "this connection is over" funnel. Reached from the close event,
   * from the supervisor declaring a socket dead, or from both in that order —
   * so it keys on socket identity and schedules at most one reconnect per
   * connection.
   */
  private handleDisconnect(ws: WebSocket | null, reason: string, code?: number): void {
    if (ws !== null && ws !== this.ws) return;

    const rejected = code !== undefined && AUTH_REJECT_CODES.has(code);
    const uptime = this.openedAt === null ? 0 : Date.now() - this.openedAt;

    if (rejected) {
      console.error(
        `[ReverseClient] Server rejected this connection (${reason}). ` +
          (code === 4001
            ? "The connect token is no longer valid — open Settings → Remote Servers, " +
              "read the current token, and re-run `vibedeckx connect` with it."
            : "This machine's identity was refused — the remote record may belong to " +
              "another machine or another account.") +
          " Retrying with backoff, but it will not recover on its own."
      );
    } else {
      console.log(`[ReverseClient] Disconnected (${reason})`);
    }

    // Only a connection that actually held clears the backoff. Resetting on
    // `open` made every rejected attempt look like a fresh start, pinning the
    // retry delay at its 1s floor.
    if (!rejected && this.openedAt !== null && uptime >= HEALTHY_CONNECTION_MS) {
      this.reconnectAttempt = 0;
    }
    this.openedAt = null;
    this.closingSince = 0;

    this.closeAllLocalChannels();
    void this.localServer.remoteMcpSessionManager?.closeAll("reverse-connect disconnected");

    // Drop our claim on the socket *before* touching it, and leave the listeners
    // attached. terminate() on a CONNECTING socket goes through ws's
    // abortHandshake, which emits `error` and then `close` on a later tick — an
    // 'error' with no listener is an unhandled EventEmitter error, and thrown
    // from a nextTick callback it takes the process down. Both late events land
    // after this.ws is null and are dropped by the identity check above.
    this.ws = null;
    if (ws) {
      try { ws.terminate(); } catch { /* already gone */ }
    }

    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    this.scheduleReconnect();
  }

  private startSupervisor(): void {
    if (this.supervisorTimer) return;
    this.supervisorTimer = setInterval(() => this.superviseTick(), SUPERVISOR_INTERVAL_MS);
    // Never the reason the process stays alive; the local Fastify server is.
    this.supervisorTimer.unref?.();
  }

  private stopSupervisor(): void {
    if (!this.supervisorTimer) return;
    clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
  }

  /**
   * Level-triggered recovery: judges the current state against the wall clock
   * rather than waiting to be armed by an event. That is what survives a dial
   * that never completes, a close frame the peer never answers, and a host that
   * was suspended for hours.
   */
  private superviseTick(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    const ws = this.ws;

    if (ws === null) {
      // No socket and no reconnect pending means the recovery chain was lost.
      // Today that path is completely silent — not even diagnosable.
      if (!this.reconnectTimer) {
        console.warn("[ReverseClient] Supervisor: no socket and no pending reconnect — self-healing");
        this.scheduleReconnect();
      }
      return;
    }

    switch (ws.readyState) {
      case WebSocket.CONNECTING: {
        const stuckFor = now - this.dialStartedAt;
        if (stuckFor > DIAL_TIMEOUT_MS) {
          console.warn(
            `[ReverseClient] Supervisor: dial stuck ${Math.round(stuckFor / 1000)}s with no handshake — terminating`
          );
          this.handleDisconnect(ws, "dial timeout");
        }
        break;
      }
      case WebSocket.OPEN: {
        const silentFor = now - this.lastFrameAt;
        if (silentFor > NO_PING_TIMEOUT_MS) {
          console.warn(
            `[ReverseClient] Supervisor: no hub traffic for ${Math.round(silentFor / 1000)}s — terminating`
          );
          this.handleDisconnect(ws, "no ping timeout");
        }
        break;
      }
      case WebSocket.CLOSING: {
        if (this.closingSince === 0) {
          this.closingSince = now;
        } else if (now - this.closingSince > CLOSING_TIMEOUT_MS) {
          console.warn("[ReverseClient] Supervisor: close handshake stalled — terminating");
          this.handleDisconnect(ws, "closing stalled");
        }
        break;
      }
      default:
        break;
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.stopSupervisor();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeAllLocalChannels();
    const ws = this.ws;
    this.ws = null;
    // A deliberate, graceful goodbye: the hub should see a clean 1000 rather
    // than a torn socket. Listeners stay attached so a late close is a no-op
    // rather than an unhandled event.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "Shutdown");
    }
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
      case "machine_challenge":
        await this.handleMachineChallenge(frame);
        break;
      default:
        break;
    }
  }

  /**
   * Prove possession of this machine's stable private key by signing the hub's
   * challenge nonce. The hub uses the public key's fingerprint to recognize
   * this machine across remote_servers.id changes.
   */
  private async handleMachineChallenge(frame: MachineChallengeFrame): Promise<void> {
    try {
      const { privateKey, publicKeyPem } = await this.getOrCreateKeys();
      const signature = cryptoSign(null, Buffer.from(frame.nonce, "base64"), privateKey);
      const reply: MachineAuthFrame = {
        type: "machine_auth",
        publicKey: publicKeyPem,
        signature: signature.toString("base64"),
        version: readPackageVersion(),
        capabilities: WORKER_CAPABILITY_KEYS,
      };
      this.sendFrame(reply);
    } catch (err) {
      console.error("[ReverseClient] Failed to answer machine challenge:", err);
    }
  }

  private async getOrCreateKeys(): Promise<{ privateKey: KeyObject; publicKeyPem: string }> {
    // Pushed into a single atomic storage call (settings.getOrCreate): two
    // concurrent first-time challenges previously could both see the setting
    // missing and each generate + persist their own keypair, with whichever
    // set() landed last winning silently — leaving the other reply signed
    // with a private key that no longer matches what's persisted, undermining
    // the "stable machine identity across reconnects" this key exists for.
    const pem = await this.localServer.storage.settings.getOrCreate(MACHINE_KEY_SETTING, () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      console.log("[ReverseClient] Generated new stable machine identity key");
      return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    });
    const privateKey = createPrivateKey(pem);
    const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    return { privateKey, publicKeyPem };
  }

  private async handleHttpRequest(frame: HttpRequestFrame): Promise<void> {
    try {
      let status: number;
      let responseHeaders: Record<string, string> = {};
      let body: string;
      // base64 set only for binary responses (e.g. file-download) so the bytes
      // survive the JSON control channel; text/JSON responses stay as-is.
      let encoding: "base64" | undefined;

      if (frame.port) {
        // Direct fetch to localhost:{port} — used by browser proxy to reach dev servers
        const url = `http://localhost:${frame.port}${frame.path}`;
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
        // Route through Fastify server — used for API proxy. The tunnel is
        // already token-authenticated at the hub, and the worker's own
        // VIBEDECKX_API_KEY (if it inherited one from ~/.vibedeckx/.env) now
        // only gates /api/admin/*, which the tunnel never calls — so injected
        // requests need no local credential.
        const response = await (this.localServer.inject as Function)({
          method: frame.method,
          url: frame.path,
          headers: frame.headers ?? {},
          payload: frame.body,
        }) as { statusCode: number; headers: Record<string, string | string[] | undefined>; payload: string; rawPayload: Buffer };

        status = response.statusCode;
        for (const [key, val] of Object.entries(response.headers)) {
          if (typeof val === "string") {
            responseHeaders[key] = val;
          } else if (Array.isArray(val)) {
            responseHeaders[key] = val.join(", ");
          }
        }
        // Binary responses (octet-stream, etc.) would be corrupted by a UTF-8
        // string round-trip, so carry their raw bytes as base64. Text/JSON keep
        // the plain payload.
        if (isTextualContentType(responseHeaders["content-type"] ?? "")) {
          body = response.payload;
        } else {
          body = response.rawPayload.toString("base64");
          encoding = "base64";
        }
      }

      const responseFrame: HttpResponseFrame = {
        type: "http_response",
        requestId: frame.requestId,
        status,
        headers: responseHeaders,
        body,
        ...(encoding ? { encoding } : {}),
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
    // Liveness is tracked in the message handler for every inbound frame, so
    // there is nothing to refresh here beyond answering.
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

  private closeAllLocalChannels(): void {
    for (const [id, ws] of this.localChannels) {
      try { ws.close(1001, "Control connection closed"); } catch { /* ignore */ }
      this.localChannels.delete(id);
    }
  }
}
