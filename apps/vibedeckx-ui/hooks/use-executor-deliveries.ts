"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ExecutorDelivery } from "@/lib/api";
import { STREAM_RECONNECTED_EVENT, useGlobalEventStream } from "@/hooks/global-event-stream";

/** One delivery per executor and target, like the hub's own bookkeeping. */
export const deliveryKey = (executorId: string, target: string) => `${executorId}:${target}`;

type DeliveryEvent =
  | { type: "executor:delivery"; projectId: string; delivery: ExecutorDelivery }
  | { type: "executor:started"; projectId: string; executorId: string; target?: string };

/**
 * Apply one event. A retry or a give-up is shown until the start is refused
 * or the executor starts on that target — delivered at last, or started
 * afresh; either way `executor:started` ends what was shown for it.
 */
export function applyDeliveryEvent(
  prev: Map<string, ExecutorDelivery>,
  event: DeliveryEvent,
): Map<string, ExecutorDelivery> {
  if (event.type === "executor:started") {
    const key = deliveryKey(event.executorId, event.target ?? "local");
    if (!prev.has(key)) return prev;
    const next = new Map(prev);
    next.delete(key);
    return next;
  }
  const { delivery } = event;
  const key = deliveryKey(delivery.executorId, delivery.remoteServerId);
  const next = new Map(prev);
  if (delivery.state === "retrying" || delivery.state === "gave_up") next.set(key, delivery);
  else next.delete(key);
  return next;
}

const EMPTY: Map<string, ExecutorDelivery> = new Map();

/**
 * Remote starts of this project the hub is re-delivering or gave up on, keyed
 * by `deliveryKey`. Seeded from the hub, then kept current by SSE; reloaded
 * when the stream reconnects, since events emitted while it was down are gone.
 */
export function useExecutorDeliveries(projectId: string | null): Map<string, ExecutorDelivery> {
  // Tagged with its project, so a project switch shows nothing stale while the
  // new project's list loads.
  const [state, setState] = useState<{ projectId: string | null; deliveries: Map<string, ExecutorDelivery> }>(
    () => ({ projectId, deliveries: new Map() }),
  );
  // Events received while a load is out, replayed in order on its snapshot:
  // the snapshot may predate them, and a removal must not be undone by it.
  const sinceLoadRef = useRef<DeliveryEvent[] | null>(null);
  const loadIdRef = useRef(0);

  const load = useCallback((id: string) => {
    const loadId = ++loadIdRef.current;
    sinceLoadRef.current = [];
    api.getExecutorDeliveries(id)
      .then((list) => {
        if (loadId !== loadIdRef.current) return;
        const events = sinceLoadRef.current ?? [];
        sinceLoadRef.current = null;
        let deliveries = new Map(list.map((d) => [deliveryKey(d.executorId, d.remoteServerId), d]));
        for (const event of events) deliveries = applyDeliveryEvent(deliveries, event);
        setState({ projectId: id, deliveries });
      })
      .catch((error) => {
        if (loadId === loadIdRef.current) sinceLoadRef.current = null;
        console.warn("[useExecutorDeliveries] load failed:", error);
      });
  }, []);

  /** Drop whatever load is still out (it belongs to a previous project). */
  const invalidate = useCallback(() => {
    loadIdRef.current++;
    sinceLoadRef.current = null;
  }, []);

  useEffect(() => {
    if (!projectId) return;
    load(projectId);
    return invalidate;
  }, [projectId, load, invalidate]);

  useGlobalEventStream((raw) => {
    if (!projectId) return;
    if (raw.type === STREAM_RECONNECTED_EVENT) {
      load(projectId);
      return;
    }
    const event = raw as DeliveryEvent;
    if (event.projectId !== projectId) return;
    if (event.type !== "executor:delivery" && event.type !== "executor:started") return;
    sinceLoadRef.current?.push(event);
    setState((current) => ({
      projectId,
      deliveries: applyDeliveryEvent(current.projectId === projectId ? current.deliveries : EMPTY, event),
    }));
  });

  return state.projectId === projectId ? state.deliveries : EMPTY;
}
