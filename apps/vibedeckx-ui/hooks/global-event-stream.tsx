"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getFreshToken } from "@/lib/api";
import { useAppConfig } from "@/hooks/use-app-config";

function getApiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:5173";
  }
  return "";
}

// A parsed SSE payload. Each consumer narrows by its own `type` field and
// filters by project itself.
export type GlobalEvent = { type?: string; [key: string]: unknown };
type Listener = (data: GlobalEvent) => void;

// Connection liveness for display:
//   - connecting — opening or (auto-)reconnecting, no live stream yet
//   - live       — open and receiving data (events or heartbeats)
//   - stale      — open but silent past the heartbeat deadline (zombie socket);
//                  shown to the user, recovered by a manual reconnect click
export type ConnectionState = "connecting" | "live" | "stale";

interface GlobalEventStreamValue {
  subscribe: (listener: Listener) => () => void;
  /** Force-close and immediately re-open the stream (manual recovery). */
  reconnect: () => void;
}

interface ConnectionStatusValue {
  state: ConnectionState;
  /** Epoch ms of the last received frame (event or ping), or null pre-connect. */
  lastEventAt: number | null;
}

const GlobalEventStreamContext = createContext<GlobalEventStreamValue | null>(
  null,
);
const ConnectionStatusContext = createContext<ConnectionStatusValue | null>(
  null,
);

const MAX_RETRY_MS = 5000;
// Backend sends a `{type:"ping"}` heartbeat every 15s. If we hear nothing —
// not even a ping — for this long, the connection is silently dead (a zombie
// socket that never fired `onerror`, e.g. after sleep / network change). We
// surface it as `stale`; recovery is a manual click here (no watchdog-driven
// auto-reconnect yet). `onerror` still auto-reconnects clean drops.
const STALE_AFTER_MS = 40000;
const WATCHDOG_INTERVAL_MS = 5000;

/**
 * Owns the single `/api/events` SSE connection for the whole app. The backend
 * broadcasts every project's events to every client with no per-connection
 * scoping (see routes/event-routes.ts), so one stream is enough — consumers
 * register a listener via `useGlobalEventStream` and filter the parsed payload
 * themselves. Previously each consumer (branch activity, completion sounds,
 * task refresh, executor lifecycle) opened its own EventSource, so a single
 * open page held 3–4 redundant connections to the same endpoint.
 *
 * Reconnection is owned here, with a freshly-fetched token each attempt:
 *   - The token rides in the query string and is fixed at EventSource
 *     creation, so native auto-reconnect would reuse an expired JWT and loop on
 *     401. We close on error and reconnect with a new token instead.
 *   - On first mount the Clerk token getter is registered by AuthTokenSync in a
 *     *parent* effect, which React runs after this child effect. Opening a
 *     tokenless stream in auth mode would 401 (and EventSource won't retry a
 *     non-2xx response), so we wait for a token before connecting. In solo
 *     (no-auth) mode there is no token and that is correct.
 *
 * Liveness is published via a second context (`useConnectionStatus`): `onerror`
 * handles clean drops (auto-reconnect), and a heartbeat watchdog flags the
 * zombie case (open-but-silent) as `stale` for the header indicator.
 */
export function GlobalEventStreamProvider({ children }: { children: ReactNode }) {
  const { config, loading } = useAppConfig();
  const listenersRef = useRef<Set<Listener>>(new Set());

  const [state, setState] = useState<ConnectionState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const lastEventAtRef = useRef<number | null>(null);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // Any frame (real event or ping) proves the stream is alive.
  const markAlive = useCallback(() => {
    const now = Date.now();
    lastEventAtRef.current = now;
    setLastEventAt(now);
    setState((prev) => (prev === "live" ? prev : "live"));
  }, []);

  const authEnabled = !!config?.authEnabled && !!config?.clerkPublishableKey;

  // Holds the latest "force a fresh reconnect now" closure, set by the effect
  // so the stable `reconnect` callback below can reach the live connection.
  const reconnectRef = useRef<() => void>(() => {});
  const reconnect = useCallback(() => reconnectRef.current(), []);

  useEffect(() => {
    if (loading) return;

    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function teardown() {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      es?.close();
      es = null;
    }

    function scheduleReconnect() {
      if (cancelled) return;
      setState("connecting");
      const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_MS);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    }

    async function connect() {
      if (cancelled) return;
      const token = await getFreshToken();
      if (cancelled) return;

      // Auth mode but the token getter isn't live yet — wait rather than open a
      // doomed tokenless stream that 401s without auto-reconnect.
      if (authEnabled && !token) {
        scheduleReconnect();
        return;
      }

      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
      es = new EventSource(`${getApiBase()}/api/events${tokenParam}`);

      es.onopen = () => {
        attempt = 0;
        markAlive();
      };

      es.onmessage = (event) => {
        markAlive();
        let data: GlobalEvent;
        try {
          data = JSON.parse(event.data) as GlobalEvent;
        } catch {
          // Non-JSON frame — still proof of life, but nothing to dispatch.
          return;
        }
        // Heartbeat: keeps the connection observably alive; not a real event.
        if (data.type === "ping") return;
        for (const listener of listenersRef.current) {
          try {
            listener(data);
          } catch {
            // A faulty listener must not kill the stream for the others.
          }
        }
      };

      es.onerror = () => {
        // Tear down and reconnect with a fresh token (covers token expiry and
        // transient drops). Closing first avoids the native stale-token retry.
        es?.close();
        es = null;
        scheduleReconnect();
      };
    }

    // Watchdog: a silently-dead connection never fires `onerror`, so detect it
    // by the absence of frames (the 15s backend heartbeat included) and flag it
    // `stale` for the indicator. We do NOT auto-reconnect here — recovery is the
    // user clicking the stale pill (see ConnectionStatusIndicator).
    const watchdog = setInterval(() => {
      if (cancelled) return;
      const last = lastEventAtRef.current;
      if (last === null) return; // never connected yet — `connecting` covers it
      if (Date.now() - last > STALE_AFTER_MS) {
        setState((prev) => (prev === "connecting" ? prev : "stale"));
      }
    }, WATCHDOG_INTERVAL_MS);

    reconnectRef.current = () => {
      if (cancelled) return;
      teardown();
      attempt = 0;
      setState("connecting");
      void connect();
    };

    void connect();

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      teardown();
    };
  }, [loading, authEnabled, markAlive]);

  // Stable so `useGlobalEventStream` consumers don't re-subscribe on every
  // heartbeat (subscribe + reconnect are both memoized).
  const streamValue = useMemo<GlobalEventStreamValue>(
    () => ({ subscribe, reconnect }),
    [subscribe, reconnect],
  );
  const statusValue = useMemo<ConnectionStatusValue>(
    () => ({ state, lastEventAt }),
    [state, lastEventAt],
  );

  return (
    <GlobalEventStreamContext.Provider value={streamValue}>
      <ConnectionStatusContext.Provider value={statusValue}>
        {children}
      </ConnectionStatusContext.Provider>
    </GlobalEventStreamContext.Provider>
  );
}

/**
 * Subscribe to the shared `/api/events` stream. The listener is invoked with
 * each parsed event payload; narrow by `data.type` and filter by project
 * inside. The latest listener closure is always used, so callers don't
 * re-subscribe when props like the current projectId change.
 */
export function useGlobalEventStream(listener: Listener): void {
  const ctx = useContext(GlobalEventStreamContext);
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((data) => listenerRef.current(data));
  }, [ctx]);
}

/**
 * Read the shared stream's liveness for display (header indicator). `reconnect`
 * force-reopens the connection — the manual recovery for a `stale` (zombie)
 * stream.
 */
export function useConnectionStatus(): ConnectionStatusValue & {
  reconnect: () => void;
} {
  const status = useContext(ConnectionStatusContext);
  const stream = useContext(GlobalEventStreamContext);
  return {
    state: status?.state ?? "connecting",
    lastEventAt: status?.lastEventAt ?? null,
    reconnect: stream?.reconnect ?? (() => {}),
  };
}
