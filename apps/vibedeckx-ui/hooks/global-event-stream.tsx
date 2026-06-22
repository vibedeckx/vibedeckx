"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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

interface GlobalEventStreamValue {
  subscribe: (listener: Listener) => () => void;
}

const GlobalEventStreamContext = createContext<GlobalEventStreamValue | null>(
  null,
);

const MAX_RETRY_MS = 5000;

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
 */
export function GlobalEventStreamProvider({ children }: { children: ReactNode }) {
  const { config, loading } = useAppConfig();
  const listenersRef = useRef<Set<Listener>>(new Set());

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const authEnabled = !!config?.authEnabled && !!config?.clerkPublishableKey;

  useEffect(() => {
    if (loading) return;

    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect() {
      if (cancelled) return;
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
      };

      es.onmessage = (event) => {
        let data: GlobalEvent;
        try {
          data = JSON.parse(event.data) as GlobalEvent;
        } catch {
          // Ignore keepalive comments / non-JSON frames.
          return;
        }
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

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [loading, authEnabled]);

  return (
    <GlobalEventStreamContext.Provider value={{ subscribe }}>
      {children}
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
