import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Surface a commander-created agent session into an already-open agent window.
 *
 * The agent panel normally only (re)loads its session on mount / workspace
 * switch / manual history pick. When the Main Chat commander spawns a new agent
 * session on THIS workspace in the background, the panel would otherwise not
 * show it (only the workspace dot lights up). This hook listens to the shared
 * `/api/events` stream and, when a `session:status` event names a session for
 * this workspace that differs from the one currently loaded, calls
 * `onSurface(sessionId)` so the caller can navigate to it.
 *
 * Mode-agnostic: remote `session:status` events already carry the local
 * `remote-{mode}-{project}-{remoteId}` id, which the existing load path
 * resolves the same as a local id — so `event.sessionId` passes through verbatim.
 *
 * No internal refs are needed: `useGlobalEventStream` refreshes its listener
 * ref every render, so this inline closure always reads fresh argument values.
 */
export function useSurfaceCommanderSession(
  projectId: string | null,
  branch: string | null,
  currentSessionId: string | null,
  onSurface: (sessionId: string) => void,
): void {
  useGlobalEventStream((data) => {
    if (data.type !== "session:status") return;
    const evt = data as unknown as {
      type: "session:status";
      projectId: string;
      branch: string | null;
      sessionId: string;
    };
    // Only this workspace (normalize null branches before comparing).
    if (!projectId || evt.projectId !== projectId) return;
    if ((evt.branch ?? null) !== (branch ?? null)) return;
    // Dedup / loop-guard: ignore the session already loaded in the panel — its
    // own subsequent running/stopped events carry the same id.
    if (!evt.sessionId || evt.sessionId === currentSessionId) return;
    onSurface(evt.sessionId);
  });
}
