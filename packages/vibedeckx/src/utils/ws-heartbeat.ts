import WebSocket from "ws";

/**
 * WebSocket liveness heartbeat.
 *
 * A bare `socket.ping()` on an interval keeps proxies from reaping an idle
 * connection, but it detects nothing: when the peer's TCP dies silently (laptop
 * sleep, tab suspend, network switch) the socket stays `OPEN` on this side and
 * every subsequent `send()` succeeds into a kernel buffer that will never drain.
 * The connection becomes a zombie — still counted as a subscriber, receiving
 * every broadcast, delivering none of it — until the OS TCP timeout finally
 * fires, which can take minutes. Session output streamed during that window is
 * lost with no error anywhere.
 *
 * This closes the loop: a ping that goes unanswered for two intervals
 * terminates the socket, so `close` fires, subscribers are cleaned up, and the
 * client's own reconnect path (which replays history) gets a chance to run.
 *
 * The optional `keepalive` frame exists because browsers do not surface pong
 * events to JavaScript — a browser client cannot observe the protocol-level
 * heartbeat at all. An application-level frame every interval gives it
 * something to run its own silence watchdog against.
 *
 * It is opt-in, and must stay that way: our stream clients do not ignore
 * unknown frames. Project Chat throws on one and fails the socket, the executor
 * mux reads `.data.length` off it, the single-process stream appends it to the
 * terminal. Enable it only for an endpoint whose client explicitly handles the
 * frame — today just the agent-session stream, consumed by `use-agent-session`.
 */
export interface WsHeartbeatOptions {
  /** Log prefix identifying the endpoint, e.g. `AgentWS session=abc`. */
  label: string;
  /** Ping period in ms. Detection takes up to 2× this. */
  intervalMs?: number;
  /** Send an application-level `{ keepalive }` frame alongside each ping. */
  keepalive?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Start pinging `socket` and terminate it once a ping goes unanswered for two
 * consecutive intervals. Returns a cleanup function; call it from the socket's
 * `close` handler (calling it more than once is safe).
 */
export function attachWsHeartbeat(
  socket: WebSocket,
  { label, intervalMs = DEFAULT_INTERVAL_MS, keepalive = false }: WsHeartbeatOptions,
): () => void {
  // Cleared by a pong, or by any inbound frame — a client that is actively
  // talking to us is demonstrably alive even if it never pongs.
  let awaitingPong = false;

  const markAlive = () => { awaitingPong = false; };
  socket.on("pong", markAlive);
  socket.on("message", markAlive);

  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;

    if (awaitingPong) {
      console.log(`[WsHeartbeat] ${label}: no pong within ${intervalMs * 2}ms — terminating dead socket`);
      try { socket.terminate(); } catch { /* already gone */ }
      return;
    }

    awaitingPong = true;
    try { socket.ping(); } catch { /* closing */ }
    if (keepalive) {
      try { socket.send(JSON.stringify({ keepalive: Date.now() })); } catch { /* closing */ }
    }
  }, intervalMs);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    socket.off("pong", markAlive);
    socket.off("message", markAlive);
  };
}
