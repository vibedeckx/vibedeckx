"use client";

import { useEffect, useRef } from "react";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

type TaskChangedEvent = {
  type: "task:created" | "task:updated" | "task:deleted";
  projectId: string;
};

type GlobalEvent = TaskChangedEvent | { type?: string; projectId?: string };

interface UseGlobalEventsOptions {
  onTaskChanged?: () => void;
}

/**
 * Subscribes to backend SSE for task-table refreshes. Workspace dot status
 * lives in `useBranchActivity`; legacy session:* events still flow on the
 * wire (ChatSessionManager consumes them server-side) but aren't read here.
 *
 * Rides the shared `/api/events` stream (see `GlobalEventStreamProvider`)
 * rather than opening its own EventSource.
 */
export function useGlobalEvents(
  projectId: string | null,
  options: UseGlobalEventsOptions,
) {
  const onTaskChangedRef = useRef(options.onTaskChanged);

  useEffect(() => {
    onTaskChangedRef.current = options.onTaskChanged;
  });

  useGlobalEventStream((data) => {
    const evt = data as GlobalEvent;

    // Filter to current project.
    if (!projectId || evt.projectId !== projectId) return;

    if (
      evt.type === "task:created" ||
      evt.type === "task:updated" ||
      evt.type === "task:deleted"
    ) {
      onTaskChangedRef.current?.();
    }
  });
}
