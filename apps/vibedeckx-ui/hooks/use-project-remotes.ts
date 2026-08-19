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
  // Project whose links have completed at least one fetch (success or failure).
  // `loading` alone can't tell "not started yet" from "finished": consumers that
  // derive a target from the links (diff panel) must not fire requests on the
  // empty pre-fetch list.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const loaded = projectId === undefined ? true : loadedProjectId === projectId;

  // Project switch: drop the previous project's links during render so they
  // are never shown (or used to derive a target) as the new project's — even
  // if the new project's fetch fails and leaves nothing to replace them with.
  const [seenProjectId, setSeenProjectId] = useState(projectId);
  if (projectId !== seenProjectId) {
    setSeenProjectId(projectId);
    setRemotes([]);
    // Also forget that any project finished loading: switching A→B→A while B
    // is still in flight would otherwise pair the cleared list with A's old
    // `loaded=true`, and consumers would fetch against an empty link list.
    setLoadedProjectId(null);
  }

  // Request generation: every refresh() bumps it and only the latest issued
  // request may land. Without this a slow project-A response arriving after
  // project-B's would overwrite B's links with A's and set loadedProjectId back
  // to A — leaving B `loaded=false` for good, which would gate the diff panel
  // shut (nothing else sets loadedProjectId).
  const generationRef = useRef(0);

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

  // Full refresh: project→remote links (rarely change) plus, when requested,
  // their connection status.
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!projectId) {
      setRemotes([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api.getProjectRemotes(projectId);
      let next = data;
      if (withStatus) {
        const servers = await api.getRemoteServers();
        next = applyStatus(data, servers);
      }
      if (generation !== generationRef.current) return;
      setRemotes(next);
    } catch (err) {
      if (generation !== generationRef.current) return;
      console.error("Failed to fetch project remotes:", err);
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setLoadedProjectId(projectId);
      }
    }
  }, [projectId, withStatus, applyStatus]);

  // Status-only refresh: one `/api/remote-servers` call merged into the
  // already-loaded links (functional update — merges into whatever list is
  // current when it lands). `/remotes` is project config and is not re-read.
  const refreshStatus = useCallback(async () => {
    if (!projectId || !withStatus) return;
    try {
      const servers = await api.getRemoteServers();
      setRemotes((prev) => applyStatus(prev, servers));
    } catch (err) {
      console.error("Failed to refresh remote server status:", err);
    }
  }, [projectId, withStatus, applyStatus]);

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

  return { remotes, loading, loaded, refresh };
}

// Cloud icon for a remote target: a slashed cloud when the remote is known to be
// disconnected (remotes connect via reverse-connect and track a live status).
export function remoteConnectionIcon(remote: ProjectRemote) {
  return remote.status !== "online" ? CloudOff : Cloud;
}
