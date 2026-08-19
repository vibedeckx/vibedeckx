"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Cloud, CloudOff } from "lucide-react";
import { api, type ProjectRemote } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";

interface UseProjectRemotesOptions {
  // When true, also fetch remote server connection status so the cloud icon
  // reflects whether each remote is currently connected. Status is refreshed
  // on `remote-server:status` SSE events (worker connect/disconnect), on window
  // focus, and on a slow backstop poll.
  withStatus?: boolean;
}

// Backstop only: the live signal is the `remote-server:status` event. Catches a
// missed SSE frame (zombie stream, reconnect gap) without the 15s-per-tab churn
// the old poll produced — every workspace panel shares one provider instance,
// but every open tab is its own poller against the hub.
const STATUS_BACKSTOP_MS = 60_000;

export function useProjectRemotes(
  projectId: string | undefined,
  options?: UseProjectRemotesOptions,
) {
  const withStatus = options?.withStatus ?? false;
  const [remotes, setRemotes] = useState<ProjectRemote[]>([]);
  const [loading, setLoading] = useState(false);
  // Latest list, so a status-only refresh can merge into it without being
  // recreated (and re-subscribing the effects below) on every update.
  const remotesRef = useRef<ProjectRemote[]>([]);

  const applyStatus = useCallback(
    (data: ProjectRemote[], servers: { id: string; status?: ProjectRemote["status"] }[]) => {
      const byId = new Map(servers.map((s) => [s.id, s]));
      return data.map((r) => {
        const server = byId.get(r.remote_server_id);
        return server ? { ...r, status: server.status } : r;
      });
    },
    [],
  );

  const commit = useCallback((next: ProjectRemote[]) => {
    remotesRef.current = next;
    setRemotes(next);
  }, []);

  // Full refresh: project→remote links (rarely change) plus, when requested,
  // their connection status.
  const refresh = useCallback(async () => {
    if (!projectId) {
      commit([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api.getProjectRemotes(projectId);
      if (withStatus) {
        const servers = await api.getRemoteServers();
        commit(applyStatus(data, servers));
      } else {
        commit(data);
      }
    } catch (err) {
      console.error("Failed to fetch project remotes:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, withStatus, commit, applyStatus]);

  // Status-only refresh: one `/api/remote-servers` call merged into the
  // already-loaded links. `/remotes` is project config and is not re-read here.
  const refreshStatus = useCallback(async () => {
    if (!projectId || !withStatus) return;
    try {
      const servers = await api.getRemoteServers();
      commit(applyStatus(remotesRef.current, servers));
    } catch (err) {
      console.error("Failed to refresh remote server status:", err);
    }
  }, [projectId, withStatus, commit, applyStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live signal: the hub emits one event per linked project when a worker
  // connects or disconnects (after the row's status is updated).
  useGlobalEventStream((evt) => {
    if (
      withStatus &&
      evt.type === "remote-server:status" &&
      projectId !== undefined &&
      evt.projectId === projectId
    ) {
      void refreshStatus();
    }
  });

  // Focus + backstop keep status honest when an event was missed.
  useEffect(() => {
    if (!withStatus || !projectId) return;
    const interval = setInterval(() => void refreshStatus(), STATUS_BACKSTOP_MS);
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [withStatus, projectId, refreshStatus]);

  return { remotes, loading, refresh };
}

// Cloud icon for a remote target: a slashed cloud when the remote is known to be
// disconnected (remotes connect via reverse-connect and track a live status).
export function remoteConnectionIcon(remote: ProjectRemote) {
  return remote.status !== "online" ? CloudOff : Cloud;
}
