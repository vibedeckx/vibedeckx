"use client";

import { useState, useEffect, useCallback } from "react";
import { Cloud, CloudOff } from "lucide-react";
import { api, type ProjectRemote } from "@/lib/api";

interface UseProjectRemotesOptions {
  // When true, also fetch remote server connection status and poll it so the
  // cloud icon reflects whether each remote is currently connected.
  withStatus?: boolean;
}

const STATUS_POLL_MS = 15000;

export function useProjectRemotes(
  projectId: string | undefined,
  options?: UseProjectRemotesOptions,
) {
  const withStatus = options?.withStatus ?? false;
  const [remotes, setRemotes] = useState<ProjectRemote[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setRemotes([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api.getProjectRemotes(projectId);
      if (withStatus) {
        const servers = await api.getRemoteServers();
        const byId = new Map(servers.map((s) => [s.id, s]));
        setRemotes(
          data.map((r) => {
            const server = byId.get(r.remote_server_id);
            return server
              ? { ...r, status: server.status, connection_mode: server.connection_mode }
              : r;
          }),
        );
      } else {
        setRemotes(data);
      }
    } catch (err) {
      console.error("Failed to fetch project remotes:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, withStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep connection status fresh when callers care about it.
  useEffect(() => {
    if (!withStatus || !projectId) return;
    const interval = setInterval(refresh, STATUS_POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [withStatus, projectId, refresh]);

  return { remotes, loading, refresh };
}

// Cloud icon for a remote target: a slashed cloud when the remote is known to be
// disconnected. Only inbound (reverse-connect) remotes track a live connection
// status; outbound remotes connect on demand, so they always show a plain cloud.
export function remoteConnectionIcon(remote: ProjectRemote) {
  if (remote.connection_mode === "inbound" && remote.status !== "online") {
    return CloudOff;
  }
  return Cloud;
}
